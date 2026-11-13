// As tools sobre uma cópia do cérebro de exemplo, nas duas gerações do protocolo: saída validada pelo esquema
// declarado em `tools/list`, commits com os rodapés e o cliente vindo do `clientInfo`, recusas do núcleo (regra,
// segredo) como erro de tool com `next_step`, e erro inesperado sem pilha.
import type { SyncOutput } from '@cabecao/core';
import { BrainError } from '@cabecao/core';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/index.ts';
import type { Generation, TestClient, ToolResult } from './helpers.ts';
import {
  commitCount,
  commitMessageOf,
  createBrainRepo,
  disposeSandbox,
  git,
  snapshotTree,
  startInMemory,
  stopAll,
  TEST_TIMEOUT_MS,
  toolError,
  toolOutput,
  trailersOf,
} from './helpers.ts';

afterAll(async () => {
  await stopAll();
  disposeSandbox();
});

const GENERATIONS: readonly Generation[] = ['legacy', 'modern'];
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Token falso do GitHub, montado em tempo de execução: nunca aparece inteiro neste arquivo. */
function fakeToken(seed: number): string {
  let state = seed;
  let body = '';
  for (let i = 0; i < 36; i++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    body += BASE62[state % BASE62.length];
  }
  return `${'gh'}${'p_'}${body}`;
}

interface OutputChecker {
  /** Valida o `structuredContent` contra o `outputSchema` que o próprio servidor anunciou e o devolve. */
  check(name: string, result: ToolResult): Record<string, unknown>;
  /** Tools já conferidas. */
  readonly seen: Set<string>;
}

async function outputChecker(client: TestClient): Promise<OutputChecker> {
  const response = await client.request('tools/list');
  const tools = (response.result?.tools ?? []) as { name: string; outputSchema: JsonSchemaType }[];
  const ajv = new AjvJsonSchemaValidator();
  const validators = new Map(tools.map((tool) => [tool.name, ajv.getValidator(tool.outputSchema)]));
  const seen = new Set<string>();
  return {
    seen,
    check(name, result) {
      const output = toolOutput(result);
      const verdict = validators.get(name)?.(output);
      expect(verdict?.errorMessage, `${name}: ${JSON.stringify(output).slice(0, 400)}`).toBeUndefined();
      expect(verdict?.valid, name).toBe(true);
      seen.add(name);
      return output;
    },
  };
}

describe.each(GENERATIONS)('geração %s', (generation) => {
  // o nome anunciado varia por geração para provar o mapeamento: "Claude Code" e "codex-mcp-client"
  const announced = generation === 'legacy' ? 'Claude Code' : 'codex-mcp-client';
  const expectedClient = generation === 'legacy' ? 'claude-code' : 'codex';

  it(
    'todas as tools respondem com structuredContent igual ao texto e válido pelo esquema de saída',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation, clientName: announced });
      await server.client.open();
      const { check, seen } = await outputChecker(server.client);

      const recall = check('recall', await server.client.call('recall', { task: 'filas do Projeto Atlas' }));
      const session = String(recall.session_handle);
      expect(session).toMatch(ULID_RE);
      expect(recall.data_notice).toMatch(/dado/);
      expect((recall.rules as unknown[]).length).toBeGreaterThan(0);
      expect(recall.next_step).toBeTruthy();

      const search = check('search', await server.client.call('search', { query: 'RabbitMQ', limit: 5 }));
      expect((search.hits as unknown[]).length).toBeGreaterThan(0);
      const empty = check('search', await server.client.call('search', { query: 'xyzzyinexistente' }));
      expect(empty.next_step).toBeTruthy();

      const read = check('read', await server.client.call('read', { path: 'wiki/entities/SQS.md' }));
      expect((read.note as { path: string }).path).toBe('wiki/entities/SQS.md');

      const past = check('search', await server.client.call('search', { query: 'filas', as_of: '2026-03-01' }));
      expect(past.as_of).toBe('2026-03-01');
      expect(Array.isArray(past.related)).toBe(true);

      const graph = check('graph', await server.client.call('graph', { node: 'Projeto Atlas', depth: 1 }));
      expect((graph.node as { path: string }).path).toBe('wiki/entities/Projeto Atlas.md');
      expect((graph.neighbors as unknown[]).length).toBeGreaterThan(0);
      expect(graph.data_notice).toMatch(/dado/);

      const facts = check(
        'facts',
        await server.client.call('facts', { subject: 'Projeto Atlas', predicate: 'led_by', as_of: '2026-06-01' }),
      );
      expect((facts.facts as { path: string; validity: string }[])[0]).toMatchObject({
        path: 'memory/facts/fato-ana-lidera-atlas.md',
        validity: 'current',
      });

      const linted = check('lint', await server.client.call('lint', { limit: 5 }));
      expect(linted.data_notice).toMatch(/dado/);
      expect((linted.findings as unknown[]).length).toBeLessThanOrEqual(5);

      const status = check('status', await server.client.call('status'));
      expect(status.client).toBe(expectedClient);
      expect(status.machine).toBe('maquina-teste');

      const remembered = check(
        'remember',
        await server.client.call('remember', {
          type: 'gotcha',
          title: 'Fila de teste do MCP',
          content: 'O consumidor de teste do MCP precisa de ack manual.\n',
          scope: 'project:atlas',
          session_handle: session,
        }),
      );
      expect(remembered.changed).toBe(true);

      const created = check(
        'write_page',
        await server.client.call('write_page', {
          path: 'wiki/concepts/Servidor MCP.md',
          mode: 'create',
          frontmatter: { type: 'concept', title: 'Servidor MCP' },
          content: 'O servidor MCP do Cabeção fala as duas gerações do protocolo.\n',
          session_handle: session,
        }),
      );
      expect(created.action).toBe('add');
      check(
        'write_page',
        await server.client.call('write_page', {
          path: 'wiki/concepts/Servidor MCP.md',
          mode: 'append',
          content: 'Ele sobe sem abrir o cérebro.\n',
          session_handle: session,
        }),
      );

      const patched = check(
        'patch_page',
        await server.client.call('patch_page', {
          path: 'wiki/concepts/Servidor MCP.md',
          old: 'duas gerações',
          new: 'duas gerações (2025-11-25 e 2026-07-28)',
          session_handle: session,
        }),
      );
      expect(patched.action).toBe('update');

      const related = check(
        'relate',
        await server.client.call('relate', {
          from: 'wiki/concepts/Servidor MCP.md',
          type: 'related_to',
          to: 'SQS',
          session_handle: session,
        }),
      );
      expect(related.relation).toMatchObject({ type: 'related_to', to: 'wiki/entities/SQS.md', link: '[[SQS]]' });

      const handoff = check(
        'handoff_save',
        await server.client.call('handoff_save', {
          session_handle: session,
          scope: 'project:atlas',
          done: ['Criei a nota do servidor MCP.'],
          next: ['Testar com um cliente real.'],
        }),
      );
      expect((handoff.handoff as { path: string }).path).toMatch(/^memory\/handoffs\//);
      expect((handoff.episode as { path: string }).path).toMatch(/^memory\/episodes\//);

      const ingested = check(
        'ingest',
        await server.client.call('ingest', {
          content: 'Ata curta: o Projeto Atlas vai testar o SQS FIFO.\n',
          title: 'Ata de teste do MCP',
          session_handle: session,
        }),
      );
      expect((ingested.source as { trust: string }).trust).toBe('low');
      expect((ingested.plan as { steps: string[] }).steps.length).toBeGreaterThan(0);

      const forgotten = check(
        'forget',
        await server.client.call('forget', {
          id: 'wiki/concepts/Servidor MCP.md',
          reason: 'nota de teste',
          session_handle: session,
        }),
      );
      expect(forgotten.status).toBe('confirmation_required');

      const undone = check('undo', await server.client.call('undo', { session: session, session_handle: session }));
      expect((undone.undone as unknown[]).length).toBe(7);

      // sem remoto configurado: o sync faz o que é local e diz como ficou
      const synced = check('sync', await server.client.call('sync', { session_handle: session }));
      expect(['ok', 'offline']).toContain(synced.status);

      expect([...seen].sort()).toEqual([...TOOL_NAMES].sort());
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'remember → search → read → patch_page → undo: commits com rodapés e o cliente vindo do clientInfo',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation, clientName: announced });
      await server.client.open();
      const session = String(toolOutput(await server.client.call('recall', { task: 'mensageria' })).session_handle);
      const commitsBefore = await commitCount(dir);

      const written = toolOutput<{ op: string; path: string; commit: string; changed: boolean }>(
        await server.client.call('remember', {
          type: 'preference',
          title: 'Mensageria com ack explícito',
          content: 'O usuário prefere consumidores com ack explícito, nunca automático.\n',
          tags: ['mensageria'],
          session_handle: session,
        }),
      );
      expect(written.changed).toBe(true);
      expect(written.path).toMatch(/^memory\/preferences\/.+\.md$/);
      expect(await commitCount(dir)).toBe(commitsBefore + 1);
      expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(written.commit);
      const trailers = trailersOf(await commitMessageOf(dir, written.commit));
      expect(trailers).toMatchObject({
        'Cabecao-Op': written.op,
        'Cabecao-Session': session,
        'Cabecao-Client': expectedClient,
        'Cabecao-Machine': 'maquina-teste',
      });

      const found = toolOutput<{ hits: { path: string }[] }>(
        await server.client.call('search', { query: 'ack explícito', types: ['preference'] }),
      );
      expect(found.hits.map((hit) => hit.path)).toContain(written.path);

      const read = toolOutput<{
        note: { content: string; origin: string; trust: string };
        frontmatter: Record<string, unknown>;
      }>(await server.client.call('read', { path: written.path }));
      expect(read.note.content).toContain('ack explícito, nunca automático');
      // agente: origem com o cliente e confiança média, nunca a do usuário
      expect(read.note.origin).toBe(`agent:${expectedClient}`);
      expect(read.note.trust).toBe('medium');

      const patched = toolOutput<{ op: string; commit: string }>(
        await server.client.call('patch_page', {
          path: written.path,
          old: 'nunca automático',
          new: 'nunca automático (decidido em 2026-11)',
          session_handle: session,
        }),
      );
      expect(trailersOf(await commitMessageOf(dir, patched.commit))).toMatchObject({
        'Cabecao-Op': patched.op,
        'Cabecao-Session': session,
        'Cabecao-Client': expectedClient,
      });
      const afterPatch = toolOutput<{ note: { content: string } }>(
        await server.client.call('read', { path: written.path }),
      );
      expect(afterPatch.note.content).toContain('(decidido em 2026-11)');

      // sem argumentos: desfaz a última operação (o patch)
      const undone = toolOutput<{ op: string; commit: string; undone: { op: string }[]; next_step: string }>(
        await server.client.call('undo', { session_handle: session }),
      );
      expect(undone.undone.map((item) => item.op)).toEqual([patched.op]);
      expect(undone.next_step).toContain(undone.op);
      const revert = trailersOf(await commitMessageOf(dir, undone.commit));
      expect(revert).toMatchObject({ 'Cabecao-Op': undone.op, 'Cabecao-Client': expectedClient });
      expect(revert['Cabecao-Reverts']).toContain(patched.op);
      const afterUndo = toolOutput<{ note: { content: string } }>(
        await server.client.call('read', { path: written.path }),
      );
      expect(afterUndo.note.content).not.toContain('(decidido em 2026-11)');
      expect(await commitCount(dir)).toBe(commitsBefore + 3);
      expect(await git(dir, ['status', '--porcelain'])).toBe('');
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'regras são só do usuário: remember, write_page e patch_page de type rule são recusados sem commit',
    async () => {
      const dir = await createBrainRepo();
      // um cliente que se anuncia como "cli" continua sendo agente
      const server = startInMemory(dir, { generation, clientName: 'cli' });
      await server.client.open();
      const before = await snapshotTree(dir);

      const remember = toolError(
        await server.client.call('remember', { type: 'rule', title: 'Sempre usar tabs', content: 'Use tabs.\n' }),
      );
      expect(remember.code).toBe('rule_requires_human');
      expect(remember.next_step).toMatch(/preference/);

      const create = toolError(
        await server.client.call('write_page', {
          path: 'memory/rules/sempre-usar-tabs.md',
          mode: 'create',
          frontmatter: { type: 'rule', title: 'Sempre usar tabs' },
          content: 'Use tabs.\n',
        }),
      );
      expect(create.code).toBe('rule_requires_human');

      const patch = toolError(
        await server.client.call('patch_page', {
          path: 'memory/rules/nunca-commitar-segredos.md',
          old: 'segredo',
          new: 'segredo (ou não)',
        }),
      );
      expect(patch.code).toBe('rule_requires_human');

      // o banco local (`.cabecao/`) é criado ao abrir o cérebro; o resto fica intacto
      const after = await snapshotTree(dir);
      for (const key of [...after.keys()]) if (key.startsWith('.cabecao/')) after.delete(key);
      expect(after).toEqual(before);
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'segredo no conteúdo: recusado com regra e linha, sem ecoar o segredo, sem arquivo nem commit',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation });
      await server.client.open();
      const commits = await commitCount(dir);
      const token = fakeToken(generation === 'legacy' ? 11 : 23);
      const result = await server.client.call('remember', {
        type: 'gotcha',
        title: 'Token do CI',
        content: `Linha um.\nO token do CI é ${token}\n`,
      });
      const error = toolError(result);
      expect(error.code).toBe('secret_detected');
      expect(error.next_step).toBeTruthy();
      expect(error.details).toMatchObject({ secrets: [expect.objectContaining({ rule: 'github-token', line: 2 })] });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(server.client.lines.join('\n')).not.toContain(token);
      expect(await commitCount(dir)).toBe(commits);
      expect(await git(dir, ['status', '--porcelain'])).toBe('');
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'erros do núcleo mantêm código, mensagem e next_step; o servidor segue de pé',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation });
      await server.client.open();
      const unsafe = toolError(await server.client.call('read', { path: '../fora.md' }));
      expect(unsafe.code).toBe('unsafe_path');
      const missing = toolError(await server.client.call('read', { path: 'wiki/entities/Inexistente.md' }));
      expect(missing.code).toBe('not_found');
      expect(missing.next_step).toMatch(/search/);
      const both = toolError(await server.client.call('read', { path: 'wiki/entities/SQS.md', id: 'x' }));
      expect(both.code).toBe('invalid_argument');
      const patch = toolError(
        await server.client.call('patch_page', { path: 'wiki/entities/SQS.md', old: 'texto que não existe', new: 'x' }),
      );
      expect(patch.code).toBe('patch_not_found');
      expect(patch.next_step).toMatch(/read/);
      const handle = toolError(
        await server.client.call('remember', { type: 'gotcha', content: 'Algo.\n', session_handle: 'sessao-falsa' }),
      );
      expect(handle.code).toBe('invalid_argument');
      expect(handle.next_step).toMatch(/recall/);
      expect(toolOutput(await server.client.call('status')).healthy).toBeTypeOf('boolean');
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('sync em processo separado (SyncRunner da CLI)', () => {
  const fakeSync = (overrides: Partial<SyncOutput> = {}): SyncOutput => ({
    status: 'ok',
    message: 'sincronizado',
    pulled: 1,
    pushed: 2,
    committed: 0,
    conflicts: [],
    changed_paths: ['wiki/entities/SQS.md'],
    secrets: [],
    attempts: 1,
    ms: 12,
    branch: 'main',
    remote: 'origin',
    integration: 'fast-forward',
    reason: null,
    remote_error: null,
    recovered: [],
    config_problem: null,
    index: null,
    ...overrides,
  });

  it(
    'usa o runner com o session_handle e não abre o cérebro no processo do servidor',
    async () => {
      const dir = await createBrainRepo();
      const calls: unknown[] = [];
      const server = startInMemory(dir, {
        generation: 'modern',
        syncRunner: async (input) => {
          calls.push(input);
          return fakeSync();
        },
      });
      await server.client.open();
      const handle = '01KRSW6FHG33DDQD64ZMW36MRW';
      const output = toolOutput(await server.client.call('sync', { session_handle: handle }));
      expect(output).toEqual(fakeSync());
      toolOutput(await server.client.call('sync'));
      expect(calls).toEqual([{ session_handle: handle }, {}]);
      expect((await snapshotTree(dir)).has('.cabecao/')).toBe(false);
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'erro do runner: BrainError (ou um erro com a mesma forma vindo de outro processo) vira erro de tool',
    async () => {
      const dir = await createBrainRepo();
      let attempt = 0;
      const server = startInMemory(dir, {
        generation: 'legacy',
        syncRunner: async () => {
          attempt++;
          if (attempt === 1) throw new BrainError('locked', 'outro processo está gravando', { nextStep: 'Espere.' });
          throw Object.assign(new Error('a pasta não é um cérebro'), {
            code: 'not_a_brain',
            next_step: 'Rode "cabecao init".',
          });
        },
      });
      await server.client.open();
      expect(toolError(await server.client.call('sync'))).toEqual({
        code: 'locked',
        message: 'outro processo está gravando',
        next_step: 'Espere.',
      });
      expect(toolError(await server.client.call('sync'))).toEqual({
        code: 'not_a_brain',
        message: 'a pasta não é um cérebro',
        next_step: 'Rode "cabecao init".',
      });
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'erro inesperado vira internal_error sem pilha, e o servidor continua respondendo',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, {
        generation: 'modern',
        syncRunner: async () => {
          throw new TypeError('falhou feio\n    at segredoInterno (/caminho/interno.ts:1:1)');
        },
      });
      await server.client.open();
      const result = await server.client.call('sync');
      const error = toolError(result);
      expect(error.code).toBe('internal_error');
      expect(error.message).toContain('falhou feio');
      expect(error.next_step).toBeTruthy();
      expect(JSON.stringify(result)).not.toMatch(/segredoInterno|interno\.ts|\n\s+at /);
      expect(toolOutput(await server.client.call('status')).root).toBeTruthy();
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('resources', () => {
  it(
    'schema, index e page leem pelo núcleo; caminho fora do cérebro é recusado',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation: 'modern' });
      await server.client.open();
      const listed = await server.client.request('resources/list');
      const resources = (listed.result?.resources ?? []) as { uri: string }[];
      expect(resources.map((item) => item.uri).sort()).toEqual(['cabecao://index', 'cabecao://schema']);
      const templates = await server.client.request('resources/templates/list');
      const resourceTemplates = (templates.result?.resourceTemplates ?? []) as { uriTemplate: string }[];
      expect(resourceTemplates.map((item) => item.uriTemplate)).toEqual(['cabecao://page/{+path}']);

      const text = (response: Awaited<ReturnType<TestClient['request']>>): string =>
        ((response.result?.contents as { text: string }[] | undefined) ?? [])[0]?.text ?? '';
      expect(text(await server.client.request('resources/read', { uri: 'cabecao://schema' }))).toMatch(/\S/);
      expect(text(await server.client.request('resources/read', { uri: 'cabecao://index' }))).toContain('SQS');

      const page = JSON.parse(
        text(await server.client.request('resources/read', { uri: 'cabecao://page/wiki/entities/SQS.md' })),
      ) as { data_notice: string; note: { path: string } };
      expect(page.note.path).toBe('wiki/entities/SQS.md');
      expect(page.data_notice).toMatch(/dado/);
      const encoded = JSON.parse(
        text(
          await server.client.request('resources/read', {
            uri: `cabecao://page/${encodeURI('wiki/concepts/Fila de mensagens.md')}`,
          }),
        ),
      ) as { note: { path: string } };
      expect(encoded.note.path).toBe('wiki/concepts/Fila de mensagens.md');

      const outside = await server.client.request('resources/read', { uri: 'cabecao://page/..%2F..%2Fsegredo.md' });
      expect(outside.error?.message).toMatch(/recusado|fora|dentro do cérebro/);
      const missing = await server.client.request('resources/read', { uri: 'cabecao://page/wiki/nao-existe.md' });
      expect(missing.error).toBeDefined();
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );
});
