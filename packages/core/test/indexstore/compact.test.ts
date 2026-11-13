import { describe, expect, it } from 'vitest';
import {
  compactIndex,
  fetchRemoteIndex,
  indexPushRef,
  mergeRemoteIndex,
  openIndexStore,
  pruneRemoteGenerations,
  readIndexFile,
  readIndexManifest,
  writeIndexFile,
} from '../../src/indexstore/index.ts';
import {
  collect,
  createWorld,
  git,
  gitTry,
  indexRefs,
  initRepo,
  MODEL,
  makeRecords,
  OTHER_MODEL,
  removeDir,
  syncIndex,
  TEST_TIMEOUT_MS,
  tempRoot,
} from './helpers.ts';

async function keysOf(dir: string, model = MODEL): Promise<Set<string>> {
  return new Set((await (await openIndexStore(dir, model)).listKeys()).values());
}

async function remoteBranches(remote: string): Promise<string[]> {
  const out = await git(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/cabecao/']);
  return out.split('\n').filter(Boolean);
}

describe('indexstore: compactação e gerações', { timeout: TEST_TIMEOUT_MS * 2 }, () => {
  it('junta segmentos, remove órfãos e duplicatas, e abre a geração seguinte num commit raiz', async ({
    onTestFinished,
  }) => {
    const root = tempRoot();
    onTestFinished(() => removeDir(root));
    const dir = `${root}/c`;
    await initRepo(dir);
    const store = await openIndexStore(dir, MODEL);
    const live = makeRecords('vivo', 30);
    const orphans = makeRecords('orfao', 10);
    await store.appendRecords(live.slice(0, 20));
    await store.appendRecords([...live.slice(20), ...orphans]);
    await store.appendRecords(live.slice(0, 5), { skipExisting: false }); // duplicatas
    await (await openIndexStore(dir, OTHER_MODEL)).appendRecords(makeRecords('outro', 4, 32));
    await writeIndexFile(dir, 'graph/nodes.jsonl', 'grafo\n');
    const old = await git(dir, ['rev-parse', 'cabecao/index']);

    const result = await compactIndex(dir, {
      liveKeys: [...live.map((r) => r.key), ...makeRecords('outro', 4, 32).map((r) => r.key)],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.generation).toEqual({ from: 0, to: 1 });
    expect(result.ref).toBe('refs/heads/cabecao/index-1');
    expect(result.before).toMatchObject({ segments: 4, vectors: 30 + 10 + 5 + 4 });
    expect(result.after).toMatchObject({ segments: 2, vectors: 34 });
    expect(result.after.bytes).toBeLessThan(result.before.bytes);
    expect(result.removed).toMatchObject({ orphans: 10, duplicates: 5, invalidSegments: 0 });
    expect(result.previous).toMatchObject({ ref: 'refs/heads/cabecao/index', commit: old });
    expect(result.previous.segments).toHaveLength(4);
    // geração nova: commit raiz, branch local antiga apagada, nada mexido fora
    expect([...(await indexRefs(dir)).keys()]).toEqual(['refs/heads/cabecao/index-1']);
    expect(await git(dir, ['rev-list', '--count', 'cabecao/index-1'])).toBe('1');
    expect(await git(dir, ['log', '-1', '--format=%P', 'cabecao/index-1'])).toBe('');
    expect(await git(dir, ['log', '-1', '--format=%B', 'cabecao/index-1'])).toMatch(
      /^vault index: .+\n\ngeração: 1\nvetores: 34\ncompactação de refs\/heads\/cabecao\/index /,
    );
    const manifest = await readIndexManifest(dir);
    expect(manifest).toMatchObject({ generation: 1, vectors: 34, previous: { commit: old } });
    expect((await readIndexFile(dir, 'graph/nodes.jsonl'))?.toString()).toBe('grafo\n');
    expect(await keysOf(dir)).toEqual(new Set(live.map((r) => r.key)));
    expect(await collect(await openIndexStore(dir, MODEL))).toHaveLength(30);
    // novas escritas vão para a geração 1
    const appended = await store.appendRecords(makeRecords('novo', 3));
    expect(appended.ref).toBe('refs/heads/cabecao/index-1');
    // compactar o mesmo conteúdo dá os mesmos segmentos (determinística)
    const again = await compactIndex(dir);
    expect(again?.generation.to).toBe(2);
    expect(again?.after.vectors).toBe(33 + 4);
    expect(again?.removed.models).toEqual([]);
    const dropped = await compactIndex(dir, { dropModels: [OTHER_MODEL] });
    expect(dropped?.removed.models).toEqual([OTHER_MODEL]);
    expect(Object.keys((await readIndexManifest(dir))?.models ?? {})).toEqual([MODEL]);
  });

  it('a outra máquina migra sozinha ao sincronizar: adota a geração nova, traz o que não tinha enviado e não ressuscita órfãos', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    const live = makeRecords('vivo', 20);
    const orphans = makeRecords('orfao', 8);
    await (await openIndexStore(world.a, MODEL)).appendRecords([...live, ...orphans]);
    await syncIndex(world.a);
    const b = await world.clone('b');
    await syncIndex(b);
    const pending = makeRecords('b-pendente', 6);
    await (await openIndexStore(b, MODEL)).appendRecords(pending); // B não enviou

    const compacted = await compactIndex(world.a, { liveKeys: live.map((r) => r.key) });
    expect(compacted?.removed.orphans).toBe(8);
    expect(await indexPushRef(world.a)).toMatchObject({ ref: 'refs/heads/cabecao/index-1' });
    await syncIndex(world.a);
    // a geração antiga continua no servidor: nada exige apagar branch
    expect(await remoteBranches(world.remote)).toEqual(['cabecao/index', 'cabecao/index-1']);

    expect(await syncIndex(b)).toBe(1);
    expect([...(await indexRefs(b)).keys()]).toEqual(['refs/heads/cabecao/index-1']);
    const expected = new Set([...live, ...pending].map((r) => r.key));
    expect(await keysOf(b)).toEqual(expected);
    await syncIndex(world.a);
    expect(await keysOf(world.a)).toEqual(expected);
    expect(await git(world.a, ['rev-parse', 'cabecao/index-1'])).toBe(await git(b, ['rev-parse', 'cabecao/index-1']));
    const message = await git(b, ['log', '-1', '--format=%B', 'refs/remotes/origin/cabecao/index-1']);
    expect(message).toMatch(/integrado de refs\/heads\/cabecao\/index /);
    // clone novo depois da compactação lê tudo, sem os órfãos
    const c = await world.clone('c');
    expect(await keysOf(c)).toEqual(expected);
  });

  it('corrida: outra máquina envia para a geração antiga depois da compactação; o vetor é drenado e ninguém perde nada', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('base', 10));
    await syncIndex(world.a);
    const b = await world.clone('b');
    await syncIndex(b);
    // B busca ANTES de A compactar e enviar; depois envia o que tem para a geração 0
    await (await openIndexStore(b, MODEL)).appendRecords(makeRecords('tarde', 4));
    expect((await fetchRemoteIndex(b)).ok).toBe(true);
    await compactIndex(world.a);
    await syncIndex(world.a);
    await mergeRemoteIndex(b);
    const late = await indexPushRef(b);
    expect(late?.ref).toBe('refs/heads/cabecao/index');
    await git(b, ['push', '--atomic', '--quiet', 'origin', `${late?.sha}:${late?.ref}`]);
    // A sincroniza: a geração antiga avançou depois da compactação, então é buscada e drenada
    await syncIndex(world.a);
    const all = new Set([...makeRecords('base', 10), ...makeRecords('tarde', 4)].map((r) => r.key));
    expect(await keysOf(world.a)).toEqual(all);
    await syncIndex(b);
    expect(await keysOf(b)).toEqual(all);
    expect([...(await indexRefs(b)).keys()]).toEqual(['refs/heads/cabecao/index-1']);
    const c = await world.clone('c');
    expect(await keysOf(c)).toEqual(all);
  });

  it('servidor que proíbe reescrita e exclusão: compactação e migração funcionam; apagar a geração antiga é opcional', async ({
    onTestFinished,
  }) => {
    const world = await createWorld({ ascii: true });
    onTestFinished(() => world.cleanup());
    await git(world.remote, ['config', 'receive.denyNonFastForwards', 'true']);
    await git(world.remote, ['config', 'receive.denyDeletes', 'true']);
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 10));
    await syncIndex(world.a);
    const b = await world.clone('b');
    for (let i = 0; i < 3; i++) {
      await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords(`r${i}`, 3));
      await syncIndex(world.a);
    }
    await compactIndex(world.a);
    await syncIndex(world.a);
    expect(await git(world.remote, ['rev-list', '--count', 'refs/heads/cabecao/index-1'])).toBe('1');
    const denied = await pruneRemoteGenerations(world.a);
    expect(denied.deleted).toEqual([]);
    expect(denied.kept[0]?.ref).toBe('refs/heads/cabecao/index');
    expect(await git(world.a, ['config', '--get-all', 'cabecao.indexPruneDenied'])).toBe('refs/heads/cabecao/index');
    expect((await pruneRemoteGenerations(world.a)).kept[0]?.reason).toBe('o servidor não permite apagar');
    await (await openIndexStore(b, MODEL)).appendRecords(makeRecords('b', 2));
    await syncIndex(b);
    await syncIndex(world.a);
    expect((await keysOf(world.a)).size).toBe(21);
    expect(await keysOf(b)).toEqual(await keysOf(world.a));

    // servidor passa a permitir exclusão (padrão dos provedores): a geração antiga pode ser apagada
    await git(world.remote, ['config', 'receive.denyDeletes', 'false']);
    await git(world.a, ['config', '--unset-all', 'cabecao.indexPruneDenied']);
    const pruned = await pruneRemoteGenerations(world.a);
    expect(pruned.deleted).toEqual(['refs/heads/cabecao/index']);
    expect(await remoteBranches(world.remote)).toEqual(['cabecao/index-1']);
    expect(await fetchRemoteIndex(b)).toMatchObject({ ok: true, generation: 1 });
    expect((await gitTry(b, ['rev-parse', '--verify', 'refs/remotes/origin/cabecao/index'])).code).not.toBe(0);
    const c = await world.clone('c');
    expect((await keysOf(c)).size).toBe(21);
  });

  it('prune não apaga geração antiga que ainda tem vetores fora da geração corrente do remoto', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 5));
    await syncIndex(world.a);
    const b = await world.clone('b');
    await compactIndex(world.a);
    await syncIndex(world.a);
    // B envia para a geração antiga sem saber da nova
    await (await openIndexStore(b, MODEL)).appendRecords(makeRecords('b', 3));
    const ref = await indexPushRef(b);
    await git(b, ['push', '--quiet', 'origin', `${ref?.sha}:refs/heads/cabecao/index`]);
    await fetchRemoteIndex(world.a);
    const result = await pruneRemoteGenerations(world.a);
    expect(result.deleted).toEqual([]);
    expect(result.kept[0]?.reason).toMatch(/ainda não estão/);
    await syncIndex(world.a); // drena e envia
    expect((await pruneRemoteGenerations(world.a)).deleted).toEqual(['refs/heads/cabecao/index']);
    expect((await keysOf(world.a)).size).toBe(8);
  });

  it('compactação ao mesmo tempo nas duas máquinas: a segunda adota a geração que chegou primeiro, sem duplicar', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 10));
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a2', 10));
    await syncIndex(world.a);
    const b = await world.clone('b');
    await syncIndex(b);
    const ca = await compactIndex(world.a);
    const cb = await compactIndex(b);
    expect(ca?.generation.to).toBe(1);
    expect(cb?.generation.to).toBe(1);
    await syncIndex(world.a);
    expect(await syncIndex(b)).toBeGreaterThanOrEqual(1);
    const tip = await git(world.remote, ['rev-parse', 'refs/heads/cabecao/index-1']);
    expect(await git(b, ['rev-parse', 'cabecao/index-1'])).toBe(tip);
    expect(await git(world.remote, ['rev-list', '--count', tip])).toBe('1');
    expect((await readIndexManifest(b))?.vectors).toBe(20);
  });

  it('máquina offline durante duas compactações volta e não perde o que tinha calculado', async ({
    onTestFinished,
  }) => {
    const world = await createWorld();
    onTestFinished(() => world.cleanup());
    await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords('a', 10));
    await syncIndex(world.a);
    const b = await world.clone('b');
    await syncIndex(b);
    await (await openIndexStore(b, MODEL)).appendRecords(makeRecords('offline', 4));
    for (let i = 0; i < 2; i++) {
      await (await openIndexStore(world.a, MODEL)).appendRecords(makeRecords(`g${i}`, 2));
      await compactIndex(world.a);
      await syncIndex(world.a);
    }
    expect(await remoteBranches(world.remote)).toEqual(['cabecao/index', 'cabecao/index-1', 'cabecao/index-2']);
    await syncIndex(b);
    expect([...(await indexRefs(b)).keys()]).toEqual(['refs/heads/cabecao/index-2']);
    expect((await keysOf(b)).size).toBe(18);
    await syncIndex(world.a);
    expect(await keysOf(world.a)).toEqual(await keysOf(b));
  });
});
