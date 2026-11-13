/**
 * Apoio dos testes do servidor MCP.
 *
 * - Cérebros: cópias do cérebro de exemplo (`fixtures/vault`) em `os.tmpdir()`, cada uma num repositório git
 *   próprio, com o git isolado da configuração real (mesmo padrão de `packages/core/test/brain/helpers.ts`).
 * - Cliente: um cliente JSON-RPC mínimo, escrito à mão, que fala as duas gerações do protocolo (2025-11-25 com
 *   `initialize`; 2026-07-28 com `server/discover` e o envelope `_meta` em cada requisição) sobre um par de streams.
 *   O pacote cliente do SDK não é dependência do projeto; falar o fio direto também prova o formato.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runGit } from '@cabecao/core';
import type { StdioServerOptions } from '../src/index.ts';
import { runStdioServer } from '../src/index.ts';

/** Muitos processos git por teste; no Windows cada um custa dezenas de milissegundos. */
export const TEST_TIMEOUT_MS = 120_000;

export const FIXTURE_VAULT = fileURLToPath(new URL('../../../fixtures/vault', import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// Git isolado e cérebros de teste

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'cabeção mcp ')));
const gitconfig = join(sandbox, 'gitconfig');
writeFileSync(
  gitconfig,
  [
    '[user]',
    '\tname = Teste Cabeção',
    '\temail = teste@cabecao.invalid',
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
    '[core]',
    '\tautocrlf = false',
    '[init]',
    '\tdefaultBranch = main',
    '[credential]',
    '\thelper = ',
    '',
  ].join('\n'),
);
// os arquivos de teste rodam em processos separados (`pool: 'forks'`); os filhos herdam este isolamento
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CABECAO_CONFIG_DIR = join(sandbox, 'config da máquina');

export const SANDBOX = sandbox;

let counter = 0;

export async function git(dir: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd: dir })).stdout.trimEnd();
}

/** Cópia do cérebro de exemplo, num repositório com um commit inicial. */
export async function createBrainRepo(name = 'cérebro'): Promise<string> {
  const parent = join(sandbox, `caso ${++counter}`);
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, name);
  await cp(FIXTURE_VAULT, dir, { recursive: true });
  await runGit(['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  appendFileSync(
    join(dir, '.git', 'config'),
    '[user]\n\tname = "Teste Cabeção"\n\temail = "teste@cabecao.invalid"\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'início']);
  return dir;
}

/** Pasta vazia que não é cérebro. */
export function createPlainDir(name = 'pasta comum'): string {
  const dir = join(sandbox, `caso ${++counter}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Apaga a pasta temporária inteira (chame no `afterAll`, depois de fechar os servidores). */
export function disposeSandbox(): void {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Árvore inteira da pasta, `.git/` incluído: caminho → tamanho e hash do conteúdo (pastas aparecem com `/`). */
export async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        out.set(`${child}/`, 'dir');
        await walk(child);
      } else {
        const data = await readFile(join(dir, ...child.split('/')));
        out.set(child, `${data.length}:${createHash('sha256').update(data).digest('hex')}`);
      }
    }
  };
  await walk('');
  return out;
}

export async function commitMessageOf(dir: string, sha = 'HEAD'): Promise<string> {
  return git(dir, ['log', '-1', '--format=%B', sha]);
}

export async function commitCount(dir: string): Promise<number> {
  return Number(await git(dir, ['rev-list', '--count', 'HEAD']));
}

/** Rodapés `Cabecao-*` de uma mensagem de commit. */
export function trailersOf(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of message.split('\n')) {
    const match = /^(Cabecao-[A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Cliente JSON-RPC das duas gerações

export type Generation = 'legacy' | 'modern';

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly id: number | string;
  readonly result?: Record<string, unknown>;
  readonly error?: JsonRpcError;
}

export interface ToolResult {
  readonly content: { type: string; text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface TestClient {
  readonly generation: Generation;
  /** Cada linha que o servidor escreveu no stdout, crua. */
  readonly lines: string[];
  /** `initialize` + `notifications/initialized` (2025) ou `server/discover` (2026). Devolve o resultado. */
  open(): Promise<Record<string, unknown>>;
  /** Uma requisição; na geração 2026, com o envelope `_meta`. */
  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  /** `tools/call`; falha o teste se vier erro JSON-RPC em vez de resultado. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Escreve uma linha crua no stdin do servidor e espera a resposta com o `id` dado. */
  raw(line: string, id: string): Promise<JsonRpcResponse>;
  /** Fecha o stdin do servidor. */
  end(): void;
}

export interface ClientOptions {
  readonly generation: Generation;
  /** `clientInfo.name` anunciado. */
  readonly clientName?: string;
}

export function createClient(serverStdin: Writable, serverStdout: Readable, options: ClientOptions): TestClient {
  const { generation } = options;
  const clientInfo = { name: options.clientName ?? 'claude-code', version: '9.9.9' };
  const lines: string[] = [];
  const pending = new Map<number | string, (response: JsonRpcResponse) => void>();
  let nextId = 1;
  let buffer = '';
  serverStdout.setEncoding('utf8');
  serverStdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      lines.push(line);
      let message: { id?: unknown; method?: unknown };
      try {
        message = JSON.parse(line) as { id?: unknown; method?: unknown };
      } catch {
        continue; // o teste de "só JSON-RPC no stdout" confere `lines`
      }
      if ((typeof message.id === 'number' || typeof message.id === 'string') && message.method === undefined) {
        pending.get(message.id)?.(message as JsonRpcResponse);
        pending.delete(message.id);
      }
    }
  });

  const envelope = {
    'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': clientInfo,
  };
  const send = (message: object): void => {
    serverStdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const withEnvelope = (params: Record<string, unknown> = {}): Record<string, unknown> =>
    generation === 'modern'
      ? { ...params, _meta: { ...envelope, ...((params._meta as object | undefined) ?? {}) } }
      : params;

  const request = (method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      const full = withEnvelope(params);
      send({ id, method, ...(Object.keys(full).length === 0 ? {} : { params: full }) });
    });
  };

  return {
    generation,
    lines,
    async open() {
      if (generation === 'legacy') {
        const response = await request('initialize', {
          protocolVersion: LEGACY_VERSION,
          capabilities: {},
          clientInfo,
        });
        if (response.result === undefined) throw new Error(`initialize falhou: ${JSON.stringify(response.error)}`);
        send({ method: 'notifications/initialized' });
        return response.result;
      }
      const response = await request('server/discover');
      if (response.result === undefined) throw new Error(`server/discover falhou: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    request,
    async call(name, args = {}) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.result === undefined) {
        throw new Error(`tools/call ${name} voltou erro JSON-RPC: ${JSON.stringify(response.error)}`);
      }
      return response.result as unknown as ToolResult;
    },
    raw(line, id) {
      return new Promise((resolve) => {
        pending.set(id, resolve);
        serverStdin.write(`${line}\n`);
      });
    },
    end() {
      serverStdin.end();
    },
  };
}

/** Erro de tool: o JSON `{error: {...}}` do texto. */
export function toolError(result: ToolResult): {
  code: string;
  message: string;
  next_step?: string;
  details?: unknown;
} {
  if (result.isError !== true) throw new Error(`esperava isError, veio ${JSON.stringify(result)}`);
  const text = result.content.map((block) => block.text).join('');
  return (JSON.parse(text) as { error: { code: string; message: string; next_step?: string } }).error;
}

/** Saída de tool com sucesso; confere que o texto é o mesmo JSON do `structuredContent`. */
export function toolOutput<T = Record<string, unknown>>(result: ToolResult): T {
  if (result.isError === true) throw new Error(`a tool falhou: ${result.content.map((block) => block.text).join('')}`);
  if (result.structuredContent === undefined) throw new Error('sem structuredContent');
  const text = result.content.map((block) => block.text).join('');
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(result.structuredContent)) {
    throw new Error('o texto não é equivalente ao structuredContent');
  }
  return result.structuredContent as T;
}

// ---------------------------------------------------------------------------------------------------------------
// Servidor em memória

export interface InMemoryServer {
  readonly client: TestClient;
  /** Resolve quando `runStdioServer` resolve. */
  readonly done: Promise<void>;
  /** Fecha o stdin e espera o servidor terminar. */
  stop(): Promise<void>;
}

const running = new Set<InMemoryServer>();

/**
 * Fecha os servidores que um teste deixou de pé (quando falhou no meio). Chame no `afterAll`, antes de
 * `disposeSandbox`: no Windows, o banco aberto impede apagar a pasta.
 */
export async function stopAll(): Promise<void> {
  await Promise.allSettled([...running].map((server) => server.stop()));
}

/** Sobe `runStdioServer` de verdade, ligado ao cliente por streams em memória. */
export function startInMemory(
  brainRoot: string,
  options: ClientOptions & Partial<Omit<StdioServerOptions, 'brainRoot' | 'stdin' | 'stdout'>>,
): InMemoryServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = runStdioServer({
    brainRoot,
    version: options.version ?? '0.0.0-teste',
    machine: options.machine ?? 'maquina-teste',
    ...(options.syncRunner === undefined ? {} : { syncRunner: options.syncRunner }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
    stdin,
    stdout,
  });
  const client = createClient(stdin, stdout, options);
  const server: InMemoryServer = {
    client,
    done,
    async stop() {
      client.end();
      await done;
      running.delete(server);
    },
  };
  running.add(server);
  return server;
}

// ---------------------------------------------------------------------------------------------------------------
// Processo filho

/** O filho é JavaScript puro que importa o TypeScript; no Node 22.16 e 22.17 isso pede a opção abaixo. */
const TYPE_FLAGS = process.features.typescript ? [] : ['--experimental-strip-types'];

/**
 * `node server-child.mjs <cérebro>`: o servidor de verdade, com o stdio do processo. Sem `--no-warnings`, de
 * propósito: os avisos do Node têm de ir para o stderr, nunca para o stdout.
 */
export function spawnServer(brainRoot: string): ChildProcess {
  const script = fileURLToPath(new URL('server-child.mjs', import.meta.url));
  return spawn(process.execPath, [...TYPE_FLAGS, script, brainRoot], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  });
}

export function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}
