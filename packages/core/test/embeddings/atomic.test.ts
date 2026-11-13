// Conteúdo e índice no MESMO `git push --atomic` (decisão 15): chegam juntos ou nenhum chega. E morte súbita (SIGKILL)
// no meio do cálculo dos embeddings e no meio do envio: nada se perde e o próximo sync conclui sem recalcular o que
// já foi gravado.
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/git/index.ts';
import { cleanupAll, createBrainRepo, disposeSandbox, git, TEST_TIMEOUT_MS, waitChild } from '../brain/helpers.ts';
import { cloneMachine, fakeProvider, openHuman, remoteRefs, TEST_EMBEDDING } from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

async function world(): Promise<{ a: string; remote: string }> {
  const a = await createBrainRepo('a');
  const remote = join(a, '..', 'remoto.git');
  await runGit(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  await git(a, ['remote', 'add', 'origin', remote]);
  await git(a, ['push', '--quiet', '-u', 'origin', 'main']);
  return { a, remote };
}

/** Gancho `pre-receive` no remoto bare que recusa as atualizações de referências que casam com `pattern`. */
function refuse(remote: string, pattern: string): () => void {
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in\n    ${pattern}) echo "recusado pelo teste: $ref" >&2; exit 1 ;;\n  esac\ndone\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
  return () => rmSync(hook, { force: true });
}

const TYPE_FLAGS = process.features.typescript ? [] : ['--experimental-strip-types'];

function spawnChild(args: string[]): ChildProcess {
  const script = fileURLToPath(new URL('embeddings-child.mjs', import.meta.url));
  return spawn(process.execPath, ['--no-warnings', ...TYPE_FLAGS, script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function parseResult(stdout: string): { passages: number; result: Record<string, unknown> } | null {
  const line = stdout.split('\n').find((l) => l.startsWith('RESULTADO '));
  return line === undefined ? null : JSON.parse(line.slice('RESULTADO '.length));
}

describe('envio atômico de conteúdo e índice', { timeout: TEST_TIMEOUT_MS * 2 }, () => {
  it.each([
    ['o servidor recusa a branch de índice', 'refs/heads/cabecao/*'],
    ['o servidor recusa a branch de conteúdo', 'refs/heads/main'],
  ])('%s: nenhum dos dois chega; sem a recusa, os dois chegam juntos', async (_label, pattern) => {
    const { a, remote } = await world();
    const brain = await openHuman(a, fakeProvider());
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    const before = await remoteRefs(remote);
    const allow = refuse(remote, pattern);
    const refused = await brain.sync();
    expect(refused.status).toBe('error');
    expect(refused.message).toMatch(/recus/);
    const after = await remoteRefs(remote);
    // nada mudou no remoto: nem o conteúdo (o commit do .cabecao.json) nem a branch de índice
    expect(after).toEqual(before);
    expect(after.has('refs/heads/cabecao/index')).toBe(false);
    expect(refused.index?.pushed).toBe(0);

    allow();
    const ok = await brain.sync();
    expect(ok.status).toBe('ok');
    expect(ok.pushed).toBeGreaterThanOrEqual(1);
    expect(ok.index?.pushed).toBeGreaterThan(20);
    const final = await remoteRefs(remote);
    expect(final.get('refs/heads/main')).toBe(await git(a, ['rev-parse', 'HEAD']));
    expect(final.get('refs/heads/cabecao/index')).toBe(await git(a, ['rev-parse', 'refs/heads/cabecao/index']));
  });

  it('só o índice mudou (conteúdo igual ao remoto): o envio leva só a branch de índice', async () => {
    const { a, remote } = await world();
    const provider = fakeProvider({ unavailable: true });
    const first = await openHuman(a, provider);
    await first.setEmbedding(TEST_EMBEDDING);
    const synced = await first.sync();
    expect(synced.index?.computed).toBe(0);
    const contentTip = (await remoteRefs(remote)).get('refs/heads/main');
    await first.close();
    const brain = await openHuman(a, fakeProvider());
    const computed = await brain.computeEmbeddings();
    const second = await brain.sync();
    expect(second.status).toBe('ok');
    expect(second.pushed).toBe(0);
    expect(second.index?.pushed).toBe(computed.computed);
    expect((await remoteRefs(remote)).get('refs/heads/main')).toBe(contentTip);
  });

  it('corrida: a outra máquina enviou antes; o sync busca as DUAS branches de novo e junta os vetores', async () => {
    const { a, remote } = await world();
    const brainA = await openHuman(a, fakeProvider());
    await brainA.setEmbedding(TEST_EMBEDDING);
    await brainA.computeEmbeddings();
    expect((await brainA.sync()).status).toBe('ok');
    const b = await cloneMachine(remote, 'b');
    const brainB = await openHuman(b, fakeProvider());
    writeFileSync(join(a, 'wiki/concepts/Da A.md'), '---\ntitle: Da A\n---\nTexto escrito na máquina A.\n');
    writeFileSync(join(b, 'wiki/concepts/Da B.md'), '---\ntitle: Da B\n---\nTexto escrito na máquina B.\n');
    expect((await brainA.sync()).index?.pushed).toBe(1);
    const syncB = await brainB.sync();
    expect(syncB.status).toBe('ok');
    expect(syncB.index).toMatchObject({ computed: 1, pending: 0 });
    const syncA = await brainA.sync();
    expect(syncA.index).toMatchObject({ received: 1, computed: 0, pending: 0 });
  });
});

describe('morte súbita no meio do cálculo e do envio', { timeout: TEST_TIMEOUT_MS * 2 }, () => {
  it('SIGKILL depois da primeira rodada do cálculo: as rodadas gravadas ficam; a próxima calcula só o resto', async () => {
    const { a } = await world();
    const setup = await openHuman(a, fakeProvider());
    await setup.setEmbedding(TEST_EMBEDDING);
    const total = (await setup.embeddingsStatus()).chunks;
    await setup.close();
    const died = await waitChild(spawnChild([a, 'compute', 'round-appended', '5']));
    expect(died.stdout).toMatch(/morrendo em round-appended depois de 5 trechos/);
    expect(died.code).not.toBe(0);
    const resumed = await waitChild(spawnChild([a, 'compute', 'nenhum', '5']));
    const parsed = parseResult(resumed.stdout);
    expect(parsed, resumed.stderr).not.toBeNull();
    expect(parsed?.passages).toBe(total - 5);
    expect(parsed?.result).toMatchObject({ computed: total - 5, pending: 0, had: 5 });
    expect(await git(a, ['fsck', '--no-progress', '--no-dangling'])).toBe('');
  });

  it('SIGKILL logo depois de o remoto aceitar o envio: o próximo sync não reenvia nem recalcula nada', async () => {
    const { a, remote } = await world();
    const setup = await openHuman(a, fakeProvider());
    await setup.setEmbedding(TEST_EMBEDDING);
    await setup.close();
    const died = await waitChild(spawnChild([a, 'sync', 'pushed', '64']));
    expect(died.stdout).toMatch(/morrendo em pushed/);
    // o remoto recebeu os dois juntos
    const refs = await remoteRefs(remote);
    expect(refs.get('refs/heads/main')).toBe(await git(a, ['rev-parse', 'HEAD']));
    expect(refs.get('refs/heads/cabecao/index')).toBe(await git(a, ['rev-parse', 'refs/heads/cabecao/index']));
    const after = await waitChild(spawnChild([a, 'sync', 'nenhum', '64']));
    const parsed = parseResult(after.stdout);
    expect(parsed, after.stderr).not.toBeNull();
    expect(parsed?.passages).toBe(0);
    expect(parsed?.result).toMatchObject({ status: 'ok', pushed: 0 });
    expect(parsed?.result.index).toMatchObject({ computed: 0, pushed: 0, pending: 0 });
  });

  it('SIGKILL no meio do sync, antes do envio: o próximo sync envia conteúdo e índice juntos', async () => {
    const { a, remote } = await world();
    const setup = await openHuman(a, fakeProvider());
    await setup.setEmbedding(TEST_EMBEDDING);
    await setup.close();
    const died = await waitChild(spawnChild([a, 'sync', 'round-appended', '8']));
    expect(died.stdout).toMatch(/morrendo em round-appended/);
    expect((await remoteRefs(remote)).has('refs/heads/cabecao/index')).toBe(false);
    const after = await waitChild(spawnChild([a, 'sync', 'nenhum', '8']));
    const parsed = parseResult(after.stdout);
    expect(parsed?.result).toMatchObject({ status: 'ok' });
    expect(parsed?.result.index).toMatchObject({ pending: 0 });
    const total = (parsed?.result.index as { pushed: number } | undefined)?.pushed;
    expect(total).toBe(8 + (parsed?.passages ?? 0));
    const refs = await remoteRefs(remote);
    expect(refs.get('refs/heads/cabecao/index')).toBe(await git(a, ['rev-parse', 'refs/heads/cabecao/index']));
  });
});
