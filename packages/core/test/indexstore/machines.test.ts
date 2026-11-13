import { describe, expect, it } from 'vitest';
import {
  fetchRemoteIndex,
  indexPushRef,
  mergeRemoteIndex,
  openIndexStore,
  readIndexFile,
  readIndexManifest,
  recordIndexPushed,
  writeIndexFile,
} from '../../src/indexstore/index.ts';
import {
  collect,
  createWorld,
  DIMS,
  git,
  gitTry,
  indexRefs,
  MODEL,
  makeRecords,
  OTHER_MODEL,
  syncIndex,
  TEST_TIMEOUT_MS,
} from './helpers.ts';

/** Chaves que faltam no índice desta máquina (o que ela teria de calcular). */
async function missing(dir: string, keys: readonly string[]): Promise<number> {
  const have = await (await openIndexStore(dir, MODEL)).listKeys();
  return keys.filter((k) => !have.has(k)).length;
}

describe('indexstore: duas máquinas', { timeout: TEST_TIMEOUT_MS }, () => {
  it('clone recém-feito lê tudo sem buscar nada e sem recalcular; a primeira escrita dele é avanço simples', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    const records = makeRecords('a', 40);
    await (await openIndexStore(world.a, MODEL)).appendRecords(records);
    expect(await syncIndex(world.a)).toBe(1);
    const b = await world.clone('b');
    // o clone comum já traz refs/remotes/origin/cabecao/index; não existe branch local ainda
    expect((await indexRefs(b)).size).toBe(0);
    const store = await openIndexStore(b, MODEL);
    expect(await collect(store)).toHaveLength(40);
    expect(
      await missing(
        b,
        records.map((r) => r.key),
      ),
    ).toBe(0);
    const head = await store.head();
    expect(head?.commit).toBe(await git(world.a, ['rev-parse', 'cabecao/index']));
    await store.appendRecords(makeRecords('b', 5));
    expect(await git(b, ['rev-parse', 'cabecao/index^'])).toBe(head?.commit);
    expect(await syncIndex(b)).toBe(1);
  });

  it('clone de uma branch só (--single-branch): fetchRemoteIndex busca o índice', async ({ onTestFinished }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 10));
    await syncIndex(world.a);
    // --no-local: sem isso o clone de pasta local copia o banco de objetos inteiro
    const b = await world.clone('b', ['--no-local', '--single-branch', '--branch', 'main']);
    expect(await collect(await openIndexStore(b, MODEL))).toHaveLength(0);
    const fetched = await fetchRemoteIndex(b, 'origin');
    expect(fetched).toMatchObject({ ok: true, generation: 0, fetched: true });
    expect(await collect(await openIndexStore(b, MODEL))).toHaveLength(10);
    // nada mudou: só o ls-remote, nenhum fetch
    expect(await fetchRemoteIndex(b, 'origin')).toMatchObject({ ok: true, fetched: false });
  });

  it('as duas máquinas acrescentam ao mesmo tempo: união dos segmentos, sem conflito e sem recalcular nada', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('base', 10));
    await syncIndex(world.a);
    const b = await world.clone('b');
    const fromA = makeRecords('a', 30);
    const fromB = makeRecords('b', 25);
    const same = makeRecords('mesmo', 4); // o mesmo trecho calculado nas duas máquinas antes de qualquer envio
    await (await openIndexStore(world.a, MODEL)).appendRecords([...fromA, ...same]);
    await (await openIndexStore(b, MODEL)).appendRecords([...fromB, ...same]);
    expect(await syncIndex(world.a)).toBe(1);
    // B tenta enviar: é recusado (A enviou antes), busca, junta e envia
    const pushRef = await indexPushRef(b);
    expect(pushRef?.ref).toBe('refs/heads/cabecao/index');
    const raced = await gitTry(b, ['push', '--atomic', '--quiet', 'origin', `${pushRef?.sha}:${pushRef?.ref}`]);
    expect(raced.code).not.toBe(0);
    expect(await syncIndex(b)).toBe(1);
    await syncIndex(world.a);
    const all = [...makeRecords('base', 10), ...fromA, ...fromB, ...same].map((r) => r.key);
    for (const dir of [world.a, b]) {
      expect(await missing(dir, all)).toBe(0);
      expect(await collect(await openIndexStore(dir, MODEL))).toHaveLength(all.length);
    }
    // histórico linear, mesma ponta nas duas máquinas e no remoto
    const tip = await git(world.remote, ['rev-parse', 'refs/heads/cabecao/index']);
    expect(await git(world.a, ['rev-parse', 'cabecao/index'])).toBe(tip);
    expect(await git(b, ['rev-parse', 'cabecao/index'])).toBe(tip);
    expect(await git(world.remote, ['rev-list', '--merges', '--count', 'refs/heads/cabecao/index'])).toBe('0');
    // o trecho repetido existe em dois segmentos (duplicata), mas a leitura devolve uma vez; compact remove
    expect((await readIndexManifest(world.a))?.vectors).toBe(all.length + same.length);
    expect(await git(world.a, ['fsck', '--no-progress', '--no-dangling'])).toBe('');
  });

  it('antes de integrar, listKeys já soma o que chegou do remoto (não recalcula o que a outra máquina calculou)', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('base', 5));
    await syncIndex(world.a);
    const b = await world.clone('b');
    await (await openIndexStore(b, MODEL)).appendRecords(makeRecords('b', 5));
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 7));
    await syncIndex(world.a);
    expect((await fetchRemoteIndex(b)).ok).toBe(true);
    // B ainda não integrou, mas já enxerga os 7 de A
    expect(
      await missing(
        b,
        makeRecords('a', 7).map((r) => r.key),
      ),
    ).toBe(0);
    const merged = await mergeRemoteIndex(b);
    expect(merged.outcome).toBe('merged');
    expect(await git(b, ['rev-parse', 'cabecao/index^'])).toBe(await git(world.a, ['rev-parse', 'cabecao/index']));
    // integrar de novo não faz nada
    expect((await mergeRemoteIndex(b)).outcome).toBe('none');
  });

  it('avanço simples quando só o remoto andou; manifesto regenerado na junção', async ({ onTestFinished }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 5));
    await syncIndex(world.a);
    const b = await world.clone('b');
    await mergeRemoteIndex(b);
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a2', 5));
    await syncIndex(world.a);
    await fetchRemoteIndex(b);
    const ff = await mergeRemoteIndex(b);
    expect(ff.outcome).toBe('fast-forward');
    expect(ff.commit).toBe(await git(world.a, ['rev-parse', 'cabecao/index']));
    expect(await indexPushRef(b)).toBeNull();
    await (await openIndexStore(b, MODEL)).appendRecords(makeRecords('b', 3));
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a3', 4));
    await syncIndex(world.a);
    await syncIndex(b);
    const manifest = await readIndexManifest(b);
    expect(manifest?.models[MODEL]).toMatchObject({ segments: 4, vectors: 17 });
    expect(manifest?.vectors).toBe(17);
  });

  it('modelos diferentes em máquinas diferentes convivem; o grafo é preservado por três vias', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 6));
    await writeIndexFile(world.a, 'graph/nodes.jsonl', 'v1\n');
    await syncIndex(world.a);
    const b = await world.clone('b');
    // B troca de modelo (outra pasta) e regrava o grafo; A acrescenta no modelo antigo
    await (await openIndexStore(b, OTHER_MODEL)).appendRecords(makeRecords('a', 6, 32));
    await writeIndexFile(b, 'graph/nodes.jsonl', 'v2 de B\n');
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a2', 3));
    await writeIndexFile(world.a, 'graph/edges.jsonl', 'arestas de A\n');
    await syncIndex(world.a);
    await syncIndex(b);
    await syncIndex(world.a);
    for (const dir of [world.a, b]) {
      expect(await collect(await openIndexStore(dir, MODEL))).toHaveLength(9);
      expect(await collect(await openIndexStore(dir, OTHER_MODEL))).toHaveLength(6);
      expect((await readIndexFile(dir, 'graph/nodes.jsonl'))?.toString()).toBe('v2 de B\n');
      expect((await readIndexFile(dir, 'graph/edges.jsonl'))?.toString()).toBe('arestas de A\n');
      const manifest = await readIndexManifest(dir);
      expect(Object.keys(manifest?.models ?? {})).toEqual([OTHER_MODEL, MODEL]);
    }
    expect(await git(world.a, ['rev-parse', 'cabecao/index'])).toBe(await git(b, ['rev-parse', 'cabecao/index']));
  });

  it('duas máquinas criam o índice sem saber uma da outra (raízes independentes): a segunda drena o que falta', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    const b = await world.clone('b');
    await (await openIndexStore(world.a, MODEL)).appendRecords([...makeRecords('a', 8), ...makeRecords('comum', 3)]);
    await (await openIndexStore(b, MODEL)).appendRecords([...makeRecords('b', 5), ...makeRecords('comum', 3)]);
    await syncIndex(world.a);
    await syncIndex(b);
    await syncIndex(world.a);
    for (const dir of [world.a, b]) {
      expect(await collect(await openIndexStore(dir, MODEL))).toHaveLength(16);
    }
    // só os 5 de B foram copiados para um segmento novo; os 3 em comum não se repetem
    expect((await readIndexManifest(b))?.vectors).toBe(16);
    expect(await git(b, ['log', '-1', '--format=%B', 'cabecao/index'])).toMatch(
      /integrado de refs\/heads\/cabecao\/index/,
    );
  });

  it('recordIndexPushed: depois do envio, nada fica pendente', async ({ onTestFinished }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    const b = await world.clone('b', ['--single-branch', '--branch', 'main']);
    await (await openIndexStore(b, MODEL, { dims: DIMS })).appendRecords(makeRecords('b', 3));
    const ref = await indexPushRef(b);
    expect(ref).not.toBeNull();
    if (!ref) return;
    // o sync envia índice e conteúdo no mesmo push atômico
    await git(b, ['push', '--atomic', '--quiet', 'origin', `${ref.sha}:${ref.ref}`, 'HEAD:refs/heads/main']);
    await recordIndexPushed(b, 'origin', ref);
    expect(await indexPushRef(b)).toBeNull();
    expect(await git(world.remote, ['rev-parse', ref.ref])).toBe(ref.sha);
  });
});
