// `status`, `search` e `undo` sobre uma cópia do cérebro de exemplo.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  brainRepo,
  closeOpened,
  disposeSandbox,
  git,
  HUMAN,
  machine,
  openAsAgent,
  parseJson,
  readNote,
  TEST_TIMEOUT_MS,
  writeNote,
} from './helpers.ts';

let brain: string;
let m: ReturnType<typeof machine>;

beforeEach(async () => {
  brain = await brainRepo();
  m = machine();
});

afterEach(async () => {
  await closeOpened();
});

afterAll(() => {
  disposeSandbox();
});

describe('status', { timeout: TEST_TIMEOUT_MS }, () => {
  it('mostra notas por tipo, links quebrados, sync e saúde; --json traz a saída completa', async () => {
    const result = await m.cabecao(['status', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`Cérebro: ${brain}`);
    expect(result.stdout).toMatch(/Notas: \d+ \(.*decision \d+/);
    expect(result.stdout).toMatch(/Links quebrados: \d+/);
    expect(result.stdout).toContain('Sync: branch main, sem remoto');
    expect(result.stdout).toContain('Conflitos pendentes: nenhum');

    const json = parseJson(await m.cabecao(['status', '--brain', brain, '--json']));
    expect(json.ok).toBe(true);
    expect(json.data.root).toBe(brain);
    expect(json.data.notes.total).toBeGreaterThan(10);
    expect(json.data.sync.remote_configured).toBe(false);
  });

  it('conflito pendente aparece com o caminho, e o código continua 0', async () => {
    await writeNote(
      brain,
      'wiki/decisions/usar-sqs-para-filas.conflict-maquina-b-20261112-143210.md',
      await readNote(brain, 'wiki/decisions/usar-sqs-para-filas.md'),
    );
    const result = await m.cabecao(['status', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Conflitos pendentes: 1');
    expect(result.stdout).toContain(
      'wiki/decisions/usar-sqs-para-filas.conflict-maquina-b-20261112-143210.md → wiki/decisions/usar-sqs-para-filas.md',
    );
    expect(result.stdout).toContain('Problemas:');
    expect(result.stdout).toContain('Próximo passo: Resolva os conflitos');
  });

  it('acha o cérebro pela pasta atual, e sem cérebro dá a dica do init com código 1', async () => {
    const here = await m.cabecao(['status', '--json'], { cwd: brain });
    expect(parseJson(here).data.root).toBe(brain);

    const none = await m.cabecao(['status']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('nenhum cérebro configurado');
    expect(none.stderr).toContain('cabecao init');

    const wrong = await m.cabecao(['status', '--brain', join(brain, 'wiki'), '--json']);
    expect(wrong.code).toBe(1);
    expect(parseJson(wrong).error).toMatchObject({ kind: 'runtime', code: 'not_a_brain' });
  });
});

describe('search', { timeout: TEST_TIMEOUT_MS }, () => {
  it('lista título, caminho, trecho e validade', async () => {
    const result = await m.cabecao(['search', 'filas', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/resultado\(s\) para "filas"/);
    expect(result.stdout).toContain('wiki/decisions/usar-sqs-para-filas.md');
    expect(result.stdout).toMatch(/\[decision · project:\w+\]\s+(vigente|VENCIDO)/);
    expect(result.stdout).toContain('«');
  });

  it('--json, --type (repetido ou com vírgula), --scope e --limit', async () => {
    const json = parseJson(await m.cabecao(['search', 'filas', '--brain', brain, '--json', '--limit', '1']));
    expect(json.data.hits).toHaveLength(1);
    expect(json.data.hits[0].validity).toMatch(/current|expired/);

    const typed = parseJson(await m.cabecao(['search', 'banco', '--type', 'gotcha', '--brain', brain, '--json']));
    expect(typed.data.hits.length).toBeGreaterThan(0);
    expect(typed.data.hits.every((hit: { type: string }) => hit.type === 'gotcha')).toBe(true);

    const comma = parseJson(
      await m.cabecao(['search', 'filas', '--type', 'gotcha,decision', '--brain', brain, '--json']),
    );
    expect(comma.data.hits.length).toBeGreaterThan(0);

    const scoped = await m.cabecao(['search', 'filas', '--scope', 'project:nada-a-ver', '--brain', brain, '--json']);
    expect(scoped.code).toBe(0);
  });

  it('nada encontrado sai com 0 e sugere o que tentar', async () => {
    const result = await m.cabecao(['search', 'xyzzyinexistente', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nada encontrado para "xyzzyinexistente"');
  });

  it('erros de uso: sem pergunta, --limit inválido, tipo ou escopo inválido', async () => {
    expect((await m.cabecao(['search', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['search', 'x', '--limit', 'dez', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['search', 'x', '--limit', '0', '--brain', brain])).code).toBe(2);
    const type = await m.cabecao(['search', 'x', '--type', 'tipo-que-nao-existe', '--brain', brain]);
    expect(type.code).toBe(2);
    expect(type.stderr).toContain('types');
    expect((await m.cabecao(['search', 'x', '--scope', 'qualquer', '--brain', brain])).code).toBe(2);
  });
});

describe('undo', { timeout: TEST_TIMEOUT_MS }, () => {
  async function twoOperations(): Promise<{ first: string; second: string; session: string }> {
    const agent = await openAsAgent(brain);
    const { session_handle: session } = await agent.recall({ task: 'teste' });
    const first = await agent.writePage({
      path: 'wiki/concepts/primeira.md',
      frontmatter: { type: 'concept', title: 'Primeira' },
      content: 'Primeira nota.',
      mode: 'create',
      session_handle: session,
    });
    const second = await agent.writePage({
      path: 'wiki/concepts/segunda.md',
      frontmatter: { type: 'concept', title: 'Segunda' },
      content: 'Segunda nota.',
      mode: 'create',
      session_handle: session,
    });
    await closeOpened();
    return { first: first.op, second: second.op, session };
  }

  it('--list mostra as operações; undo desfaz a última; desfazer o undo refaz', async () => {
    const { first, second } = await twoOperations();
    const list = await m.cabecao(['undo', '--list', '--brain', brain]);
    expect(list.code).toBe(0);
    expect(list.stdout.indexOf(second)).toBeGreaterThan(-1);
    expect(list.stdout.indexOf(second)).toBeLessThan(list.stdout.indexOf(first));

    const undone = await m.cabecao(['undo', '--brain', brain, '--json']);
    expect(undone.code).toBe(0);
    const data = parseJson(undone).data;
    expect(data.undone.map((op: { op: string }) => op.op)).toEqual([second]);
    expect(data.changed_paths).toContain('wiki/concepts/segunda.md');
    await expect(readNote(brain, 'wiki/concepts/segunda.md')).rejects.toThrow();
    await expect(readNote(brain, 'wiki/concepts/primeira.md')).resolves.toContain('Primeira');

    const text = await m.cabecao(['undo', '--op', data.op, '--brain', brain]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Desfeito: 1 operação');
    await expect(readNote(brain, 'wiki/concepts/segunda.md')).resolves.toContain('Segunda');

    const afterList = parseJson(await m.cabecao(['undo', '--list', '--brain', brain, '--json']));
    expect(afterList.data.operations.length).toBeGreaterThanOrEqual(4);
  });

  it('--op desfaz uma operação específica e --session desfaz a sessão inteira', async () => {
    const { first, session } = await twoOperations();
    // o usuário no terminal: o começo do id basta
    const one = await m.cabecao(['undo', '--op', first.slice(0, 12), '--brain', brain], HUMAN);
    expect(one.code).toBe(0);
    await expect(readNote(brain, 'wiki/concepts/primeira.md')).rejects.toThrow();
    await expect(readNote(brain, 'wiki/concepts/segunda.md')).resolves.toContain('Segunda');

    const all = await m.cabecao(['undo', '--session', session, '--brain', brain, '--json'], HUMAN);
    expect(all.code).toBe(0);
    await expect(readNote(brain, 'wiki/concepts/segunda.md')).rejects.toThrow();
  });

  it('sem operação: código 1 com a mensagem do núcleo; erros de uso com código 2', async () => {
    const nothing = await m.cabecao(['undo', '--brain', brain, '--json']);
    expect(nothing.code).toBe(1);
    expect(parseJson(nothing).error).toMatchObject({ code: 'nothing_to_undo' });
    expect((await m.cabecao(['undo', '--op', 'A', '--session', 'B', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['undo', '--op', 'não-é-id', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['undo', '--limit', '3', '--brain', brain])).code).toBe(2);
    const missing = await m.cabecao(['undo', '--op', '01ZZZZZZZZ', '--brain', brain]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('01ZZZZZZZZ');
  });

  it('o commit do undo vai com os rodapés da CLI', async () => {
    await twoOperations();
    await m.cabecao(['undo', '--brain', brain], HUMAN);
    const message = await git(brain, ['log', '-1', '--format=%B']);
    expect(message).toMatch(/^Cabecao-Client: cli$/m);
  });
});

describe('cérebro padrão da máquina', { timeout: TEST_TIMEOUT_MS }, () => {
  it('usa o defaultBrain da configuração quando não há --brain nem CABECAO_BRAIN', async () => {
    await mkdir(m.configDir, { recursive: true });
    await writeFile(join(m.configDir, 'config.json'), JSON.stringify({ machine: 'maquina-x', defaultBrain: brain }));
    const json = parseJson(await m.cabecao(['status', '--json']));
    expect(json.data.root).toBe(brain);
    expect(json.data.machine).toBe('maquina-x');
  });

  it('configuração da máquina corrompida vira erro claro, sem stack', async () => {
    await mkdir(m.configDir, { recursive: true });
    await writeFile(join(m.configDir, 'config.json'), '{quebrado');
    const result = await m.cabecao(['status']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('configuração inválida');
    expect(result.stderr).not.toContain('CABECAO_DEBUG');
  });
});
