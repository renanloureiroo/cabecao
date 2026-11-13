// O servidor num processo filho de verdade, falando pelo stdin e pelo stdout do processo, como o `cabecao mcp`
// que um cliente MCP sobe: stdout só com JSON-RPC (nem avisos do Node), encerramento limpo quando o stdin fecha ou
// quando chega SIGTERM, banco fechado antes de a pasta ser apagada (Windows).
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/index.ts';
import type { Generation, TestClient } from './helpers.ts';
import {
  commitMessageOf,
  createBrainRepo,
  createClient,
  disposeSandbox,
  snapshotTree,
  spawnServer,
  TEST_TIMEOUT_MS,
  toolOutput,
  trailersOf,
  waitExit,
} from './helpers.ts';

const children: ChildProcess[] = [];

afterEach(async () => {
  // nenhum processo órfão, nem quando um teste falha no meio
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitExit(child);
    }
  }
});

afterAll(() => disposeSandbox());

function start(
  dir: string,
  generation: Generation,
  clientName: string,
): { child: ChildProcess; client: TestClient; stderr: () => string } {
  const child = spawnServer(dir);
  children.push(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  if (child.stdin === null || child.stdout === null) throw new Error('filho sem stdio');
  const client = createClient(child.stdin, child.stdout, { generation, clientName });
  return { child, client, stderr: () => stderr };
}

/** Espera o filho sair, com prazo; passado o prazo, o teste falha (e o `afterEach` mata o filho). */
async function exitWithin(
  child: ChildProcess,
  ms: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`o servidor não saiu em ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([waitExit(child), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function expectOnlyJsonRpc(lines: readonly string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines.filter((text) => text !== '')) {
    let message: unknown;
    expect(() => {
      message = JSON.parse(line);
    }, line).not.toThrow();
    expect((message as { jsonrpc?: unknown }).jsonrpc, line).toBe('2.0');
  }
}

it(
  'processo real, geração 2025: tools funcionam, stdout só tem JSON-RPC e o processo sai quando o stdin fecha',
  async () => {
    const dir = await createBrainRepo();
    const { child, client, stderr } = start(dir, 'legacy', 'claude-code');
    const opened = await client.open();
    expect(opened.serverInfo).toEqual({ name: 'cabecao', version: '0.0.0-filho' });
    const tools = (await client.request('tools/list')).result?.tools as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);

    const session = String(toolOutput(await client.call('recall', { task: 'filas' })).session_handle);
    const written = toolOutput<{ commit: string }>(
      await client.call('remember', {
        type: 'gotcha',
        title: 'Processo filho do MCP',
        content: 'O servidor stdio sai quando o cliente fecha o stdin.\n',
        session_handle: session,
      }),
    );
    expect(trailersOf(await commitMessageOf(dir, written.commit))).toMatchObject({
      'Cabecao-Client': 'claude-code',
      'Cabecao-Session': session,
      'Cabecao-Machine': 'maquina-filho',
    });

    client.end();
    const exit = await exitWithin(child, 20_000);
    expect(exit).toEqual({ code: 0, signal: null });
    expectOnlyJsonRpc(client.lines);
    expect(stderr()).toContain('[server-child] encerrado');
  },
  TEST_TIMEOUT_MS,
);

it(
  'processo real, geração 2026: subir e listar não muda nada na pasta; SIGTERM fecha o banco e sai',
  async () => {
    const dir = await createBrainRepo();
    const before = await snapshotTree(dir);
    const { child, client, stderr } = start(dir, 'modern', 'codex-mcp-client');
    const discovered = await client.open();
    expect(discovered.supportedVersions).toEqual(['2026-07-28']);
    expect((await client.request('tools/list')).result?.tools).toHaveLength(TOOL_NAMES.length);
    expect(await snapshotTree(dir)).toEqual(before);

    // agora abre o cérebro (cria o banco em .cabecao/)
    const status = toolOutput<{ client: string }>(await client.call('status'));
    expect(status.client).toBe('codex');

    if (process.platform === 'win32') {
      // no Windows não existe SIGTERM de verdade (o processo é terminado na hora); fechar o stdin é o caminho
      client.end();
      expect(await exitWithin(child, 20_000)).toEqual({ code: 0, signal: null });
    } else {
      child.kill('SIGTERM');
      const exit = await exitWithin(child, 20_000);
      expect(exit).toEqual({ code: 143, signal: null });
      expect(stderr()).toContain('[server-child] encerrado');
    }
    expectOnlyJsonRpc(client.lines);
  },
  TEST_TIMEOUT_MS,
);
