import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { compactIndex, INDEX_STEPS, openIndexStore } from '../../src/indexstore/index.ts';
import {
  collect,
  createWorld,
  DIMS,
  git,
  initRepo,
  keyOf,
  MODEL,
  makeRecords,
  removeDir,
  spawnChild,
  syncIndex,
  TEST_TIMEOUT_MS,
  tempRoot,
  waitChild,
} from './helpers.ts';

/** Estado sadio: fsck limpo, toda referência do índice aponta para commit existente, leitura sem problemas. */
async function expectHealthy(dir: string, label: string): Promise<Set<string>> {
  expect(await git(dir, ['fsck', '--no-progress', '--no-dangling']), label).toBe('');
  const refs = await git(dir, ['for-each-ref', '--format=%(refname) %(objecttype)', 'refs/heads/cabecao/']);
  for (const line of refs.split('\n').filter(Boolean)) expect(line, label).toMatch(/ commit$/);
  const store = await openIndexStore(dir, MODEL);
  const records = await collect(store);
  expect(store.issues, label).toEqual([]);
  return new Set(records.map((r) => r.key));
}

/** Chaves que o processo filho grava com `append <prefixo> <n>`. */
function childKeys(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => keyOf(`${prefix}:${i}`));
}

describe('indexstore: morte súbita', { timeout: TEST_TIMEOUT_MS * 3 }, () => {
  it('appendRecords morto (SIGKILL) em cada passo: a branch nunca aponta para objeto inexistente e a próxima escrita conclui', async ({
    onTestFinished,
  }) => {
    const root = tempRoot();
    onTestFinished(() => removeDir(root));
    const dir = join(root, 'c');
    await initRepo(dir);
    await (await openIndexStore(dir, MODEL, { dims: DIMS })).appendRecords(makeRecords('base', 10));
    const reached: string[] = [];
    for (const step of INDEX_STEPS) {
      const before = await git(dir, ['rev-parse', 'cabecao/index']);
      const child = await waitChild(spawnChild([dir, 'append', `k-${step}`, '7', step]));
      if (child.stdout.includes(`morrendo em ${step}`)) {
        reached.push(step);
        expect(child.stdout, step).not.toContain('RESULTADO');
      } else expect(child.code, `${step}: ${child.stderr}`).toBe(0);
      const after = await git(dir, ['rev-parse', 'cabecao/index']);
      // antes do update-ref a branch fica onde estava; depois, aponta para o commit completo
      if (step === 'blobs-written' || step === 'tree-written' || step === 'commit-written')
        expect(after, step).toBe(before);
      const keys = await expectHealthy(dir, step);
      expect(keys.has(keyOf('base:0')), step).toBe(true);
      // a trava do morto é tomada na hora (PID inexistente) e a escrita seguinte conclui
      const t0 = Date.now();
      const store = await openIndexStore(dir, MODEL, { dims: DIMS, lockTimeoutMs: 5_000 });
      const redo = await store.appendRecords(
        childKeys(`k-${step}`, 7).map((key) => ({ key, scale: 0.5, vector: new Int8Array(DIMS) })),
      );
      expect(Date.now() - t0, step).toBeLessThan(5_000);
      // morto antes do update-ref: nada ficou gravado; depois dele (ou concluído): nada a regravar (não recalcula)
      const lost = reached.includes(step) && ['blobs-written', 'tree-written', 'commit-written'].includes(step);
      expect(redo.appended, step).toBe(lost ? 7 : 0);
      const final = await expectHealthy(dir, `${step}: depois`);
      for (const key of childKeys(`k-${step}`, 7)) expect(final.has(key), step).toBe(true);
    }
    expect(reached).toEqual(['blobs-written', 'tree-written', 'commit-written', 'ref-updated']);
    // nenhum índice temporário do git sobrou (os do morto são limpos na escrita seguinte)
    const scratch = join(dir, '.cabecao', 'tmp', 'indexstore');
    expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
    expect(existsSync(join(dir, '.cabecao', 'locks', 'index.lock'))).toBe(false);
  });

  it('compactIndex morto em cada passo: nenhum vetor some e a geração fica coerente', async ({ onTestFinished }) => {
    const root = tempRoot();
    onTestFinished(() => removeDir(root));
    const dir = join(root, 'c');
    await initRepo(dir);
    const store = await openIndexStore(dir, MODEL, { dims: DIMS });
    await store.appendRecords(makeRecords('a', 10));
    const reached: string[] = [];
    let expected = 10;
    for (const step of INDEX_STEPS) {
      await store.appendRecords(makeRecords(`c-${step}`, 3));
      expected += 3;
      const child = await waitChild(spawnChild([dir, 'compact', '-', '-', step]));
      if (child.stdout.includes(`morrendo em ${step}`)) reached.push(step);
      else expect(child.code, `${step}: ${child.stderr}`).toBe(0);
      const keys = await expectHealthy(dir, step);
      expect(keys.size, step).toBe(expected);
      // a próxima operação conclui e deixa uma única branch local
      await store.appendRecords(makeRecords(`d-${step}`, 1));
      expected += 1;
      expect((await git(dir, ['for-each-ref', 'refs/heads/cabecao/'])).split('\n'), step).toHaveLength(1);
      expect((await expectHealthy(dir, `${step}: depois`)).size, step).toBe(expected);
    }
    expect(reached).toEqual([...INDEX_STEPS]);
    const final = await compactIndex(dir);
    expect(final?.after.vectors).toBe(expected);
  });

  it('mergeRemoteIndex morto em cada passo: o sync seguinte converge com a outra máquina', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('base', 5));
    await syncIndex(world.a);
    const b = await world.clone('b');
    for (const step of INDEX_STEPS) {
      await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords(`a-${step}`, 2));
      await syncIndex(world.a);
      await (await openIndexStore(b, MODEL)).appendRecords(makeRecords(`b-${step}`, 2));
      await git(b, ['fetch', '--quiet', 'origin']);
      await waitChild(spawnChild([b, 'merge', '-', '-', step]));
      await expectHealthy(b, step);
      await syncIndex(b);
      await syncIndex(world.a);
      const ka = await expectHealthy(world.a, step);
      const kb = await expectHealthy(b, step);
      expect(kb, step).toEqual(ka);
      expect(ka.has(keyOf(`b-${step}:0`)) && ka.has(keyOf(`a-${step}:1`)), step).toBe(true);
    }
    expect(await git(world.remote, ['fsck', '--no-progress', '--no-dangling'])).toBe('');
  });

  it('mortes em instantes aleatórios durante escritas em laço: toda rodada concluída sobrevive', async ({
    onTestFinished,
  }) => {
    const root = tempRoot();
    onTestFinished(() => removeDir(root));
    const dir = join(root, 'c');
    await initRepo(dir);
    let kills = 0;
    const done: string[] = [];
    for (let i = 0; i < 8; i++) {
      const child = spawnChild([dir, 'loop', `r${i}`, '1000']);
      const wait = waitChild(child);
      await sleep(250 + ((i * 137) % 400));
      child.kill('SIGKILL');
      const result = await wait;
      if (result.signal === 'SIGKILL' || result.code !== 0) kills++;
      for (const match of result.stdout.matchAll(/rodada (\d+)/g)) done.push(`r${i}-${match[1]}`);
      const keys = await expectHealthy(dir, `morte ${i}`);
      for (const prefix of done) expect(keys.has(keyOf(`${prefix}:0`)), prefix).toBe(true);
    }
    expect(kills).toBe(8);
    expect(done.length).toBeGreaterThan(0);
    const store = await openIndexStore(dir, MODEL, { dims: DIMS, lockTimeoutMs: 5_000 });
    await store.appendRecords(makeRecords('fim', 2));
    expect((await store.listKeys()).has(keyOf('fim:1'))).toBe(true);
  });
});
