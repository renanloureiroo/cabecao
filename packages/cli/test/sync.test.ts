import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock, syncLayout } from '@cabecao/core';
import { afterAll, describe, expect, it } from 'vitest';
import { syncExitCode } from '../src/commands/sync.ts';
import {
  brainRepo,
  disposeSandbox,
  freshDir,
  git,
  machine,
  obsidianNote,
  parseJson,
  readNote,
  TEST_TIMEOUT_MS,
  twoClones,
  writeNote,
} from './helpers.ts';

afterAll(() => {
  disposeSandbox();
});

/** Token falso no formato do GitHub, montado em tempo de execução (nunca aparece inteiro no código). */
function fakeToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let seed = 4242;
  let out = '';
  for (let i = 0; i < 36; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    out += alphabet[seed % alphabet.length];
  }
  return `gh${'p'}_${out}`;
}

describe('código de saída', () => {
  it('ok e busy saem com 0; blocked e error com 1; offline depende de haver remoto', () => {
    expect(syncExitCode({ status: 'ok', remote: 'origin' })).toBe(0);
    expect(syncExitCode({ status: 'busy', remote: 'origin' })).toBe(0);
    expect(syncExitCode({ status: 'blocked', remote: 'origin' })).toBe(1);
    expect(syncExitCode({ status: 'error', remote: 'origin' })).toBe(1);
    expect(syncExitCode({ status: 'offline', remote: 'origin' })).toBe(1);
    expect(syncExitCode({ status: 'offline', remote: null })).toBe(0);
  });
});

describe('sync', { timeout: TEST_TIMEOUT_MS }, () => {
  it('envia de uma máquina e recebe na outra; --json devolve a saída completa', async () => {
    const { a, b } = await twoClones();
    const m = machine();
    await writeNote(a, 'wiki/concepts/nova.md', obsidianNote('Nova', 'Escrita no Obsidian da máquina A.'));
    const sent = await m.cabecao(['sync', '--brain', a]);
    expect(sent.code).toBe(0);
    expect(sent.stdout).toContain('Sync: ok.');
    expect(sent.stdout).toContain('enviados: 1');

    const received = await m.cabecao(['sync', '--brain', b, '--json']);
    expect(received.code).toBe(0);
    const json = parseJson(received);
    expect(json).toMatchObject({ ok: true, command: 'sync' });
    expect(json.data).toMatchObject({ status: 'ok', pulled: 1, pushed: 0, remote: 'origin' });
    for (const key of ['message', 'conflicts', 'changed_paths', 'secrets', 'integration', 'recovered']) {
      expect(json.data).toHaveProperty(key);
    }
    expect(await readNote(b, 'wiki/concepts/nova.md')).toContain('máquina A');
  });

  it('a mesma nota editada nos dois lados: guarda as duas versões e mostra o caminho da cópia', async () => {
    const { a, b } = await twoClones();
    const m = machine();
    const path = 'wiki/decisions/usar-sqs-para-filas.md';
    const original = await readNote(a, path);
    await writeNote(a, path, original.replace(/\n$/, '\nEdição da máquina A.\n'));
    expect((await m.cabecao(['sync', '--brain', a])).code).toBe(0);
    await writeNote(b, path, original.replace(/\n$/, '\nEdição da máquina B.\n'));
    const result = await m.cabecao(['sync', '--brain', b]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Conflitos \(1\)/);
    expect(result.stdout).toMatch(/usar-sqs-para-filas\.md: ficou com a versão do remoto; a sua está em .*\.conflict-/);
  });

  it('segredo numa edição: bloqueia com arquivo, linha e regra, sem o segredo, e sai com 1', async () => {
    const { a, remote } = await twoClones();
    const m = machine();
    const token = fakeToken();
    await writeNote(a, 'wiki/concepts/vazou.md', obsidianNote('Vazou', `token do CI: ${token}`));
    const before = await git(remote, ['rev-parse', 'main']);
    const result = await m.cabecao(['sync', '--brain', a]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Sync: bloqueado.');
    expect(result.stdout).toMatch(/wiki\/concepts\/vazou\.md:\d+:\d+\s+github-token/);
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).not.toContain(token.slice(4, 20));
    const json = await m.cabecao(['sync', '--brain', a, '--json']);
    expect(json.code).toBe(1);
    expect(json.stdout).not.toContain(token.slice(4, 20));
    expect(parseJson(json)).toMatchObject({ ok: false, data: { status: 'blocked', reason: 'secrets' } });
    expect(await git(remote, ['rev-parse', 'main'])).toBe(before);
  });

  it('remoto que sumiu: offline, código 1, as mudanças ficam num commit local', async () => {
    const { a } = await twoClones();
    const m = machine();
    await git(a, ['remote', 'set-url', 'origin', join(freshDir('sumiu'), 'nao-existe.git')]);
    await writeNote(a, 'wiki/concepts/local.md', obsidianNote('Local', 'Só aqui.'));
    const result = await m.cabecao(['sync', '--brain', a, '--json']);
    expect(result.code).toBe(1);
    expect(parseJson(result).data).toMatchObject({ status: 'offline', committed: 1, pushed: 0 });
  });

  it('cérebro sem remoto: código 0 com aviso', async () => {
    const brain = await brainRepo();
    const m = machine();
    await writeNote(brain, 'wiki/concepts/x.md', obsidianNote('X', 'x'));
    const result = await m.cabecao(['sync', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Aviso: este cérebro não tem remoto');
  });

  it('outro sync em andamento: busy, código 0', async () => {
    const { a } = await twoClones();
    const m = machine();
    const lockPath = syncLayout(a).syncLock;
    await mkdir(join(lockPath, '..'), { recursive: true });
    const lock = await acquireLock(lockPath);
    try {
      const result = await m.cabecao(['sync', '--brain', a, '--json']);
      expect(result.code).toBe(0);
      expect(parseJson(result).data.status).toBe('busy');
    } finally {
      await lock.release();
    }
  });

  it('--session aceita só o identificador de sessão; argumento solto é erro de uso', async () => {
    const brain = await brainRepo();
    const m = machine();
    const bad = await m.cabecao(['sync', '--brain', brain, '--session', 'nao-e-ulid', '--json']);
    expect(bad.code).toBe(1);
    expect(parseJson(bad).error).toMatchObject({ code: 'invalid_argument' });
    expect((await m.cabecao(['sync', 'extra', '--brain', brain])).code).toBe(2);
  });

  it('a pasta não é um cérebro: código 1, com o que fazer', async () => {
    const dir = freshDir('vazia');
    await writeFile(join(dir, 'nota.md'), '# oi\n');
    const result = await machine().cabecao(['sync', '--brain', dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cabecao init');
  });
});
