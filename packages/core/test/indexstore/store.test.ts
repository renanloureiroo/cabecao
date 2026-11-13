import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeSegment,
  generationRef,
  modelDirName,
  openIndexStore,
  parseManifest,
  readIndexFile,
  readIndexManifest,
  type SegmentIssue,
  writeIndexFile,
} from '../../src/indexstore/index.ts';
import {
  collect,
  DIMS,
  git,
  gitTry,
  initRepo,
  MODEL,
  makeRecords,
  OTHER_MODEL,
  removeDir,
  sameRecord,
  spawnChild,
  TEST_TIMEOUT_MS,
  tempRoot,
  waitChild,
  write,
} from './helpers.ts';

async function repo(): Promise<{ dir: string; root: string; cleanup: () => void }> {
  const root = tempRoot();
  const dir = join(root, 'cérebro');
  await initRepo(dir);
  return { dir, root, cleanup: () => removeDir(root) };
}

describe('indexstore: escrita e leitura na branch, sem worktree', { timeout: TEST_TIMEOUT_MS }, () => {
  it('ida e volta: appendRecords grava um segmento num commit raiz órfão; readAll devolve tudo', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL, { dims: DIMS });
    expect(await store.head()).toBeNull();
    expect((await store.listKeys()).size).toBe(0);
    const records = makeRecords('a', 50);
    const result = await store.appendRecords(records, { contentCommit: await git(dir, ['rev-parse', 'HEAD']) });
    expect(result).toMatchObject({
      appended: 50,
      skipped: 0,
      generation: 0,
      ref: 'refs/heads/cabecao/index',
      created: true,
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.path).toMatch(/^embeddings\/teste-q8-r1\/seg-[0-9a-f]{32}\.bin$/);

    const read = await collect(store);
    expect(read).toHaveLength(50);
    const byKey = new Map(read.map((r) => [r.key, r]));
    for (const r of records) expect(sameRecord(byKey.get(r.key), r)).toBe(true);
    expect(await store.hasKey(records[3]?.key ?? '')).toBe(true);
    expect(await store.hasKey('0'.repeat(32))).toBe(false);

    // branch órfã: sem histórico em comum com as notas
    expect((await gitTry(dir, ['merge-base', 'main', 'cabecao/index'])).code).toBe(1);
    expect(await git(dir, ['rev-list', '--count', 'cabecao/index'])).toBe('1');
    expect(await git(dir, ['ls-tree', '-r', '--name-only', 'cabecao/index'])).toBe(
      `${result.segments[0]?.path}\nmanifest.json`,
    );
    // mensagem: assunto do doc 12, geração e vetores no corpo, sem atribuição
    const message = await git(dir, ['log', '-1', '--format=%B', 'cabecao/index']);
    expect(message).toMatch(/^vault index: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\n\ngeração: 0\nvetores: 50\n/);
    expect(message).not.toMatch(/co-authored|claude|generated|anthropic/i);
    expect(await git(dir, ['log', '-1', '--format=%G?', 'cabecao/index'])).toBe('N');
    // manifesto
    const manifest = await readIndexManifest(dir);
    expect(manifest).toMatchObject({
      formatVersion: 1,
      generation: 0,
      vectors: 50,
      previous: null,
      contentCommit: await git(dir, ['rev-parse', 'HEAD']),
      models: { [MODEL]: { recipe: 1, dims: DIMS, segments: 1, vectors: 50 } },
    });
    // a pasta de trabalho e o main não foram tocados
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    expect(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect((await git(dir, ['worktree', 'list'])).split('\n')).toHaveLength(1);
  });

  it('nunca altera segmento existente; chave já presente não é regravada (não recalcula)', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL);
    const first = await store.appendRecords(makeRecords('a', 20));
    const firstPath = first.segments[0]?.path ?? '';
    const firstBlob = await git(dir, ['rev-parse', `cabecao/index:${firstPath}`]);
    const again = await store.appendRecords([...makeRecords('a', 20), ...makeRecords('b', 5)]);
    expect(again).toMatchObject({ appended: 5, skipped: 20, created: true });
    expect(await git(dir, ['rev-parse', `cabecao/index:${firstPath}`])).toBe(firstBlob);
    expect(await git(dir, ['rev-list', '--count', 'cabecao/index'])).toBe('2');
    const noop = await store.appendRecords(makeRecords('a', 20));
    expect(noop).toMatchObject({ appended: 0, skipped: 20, created: false, segments: [] });
    expect(await git(dir, ['rev-list', '--count', 'cabecao/index'])).toBe('2');
    expect((await store.listKeys()).size).toBe(25);
  });

  it('recusa chave inválida e dimensão diferente da do modelo', async ({ onTestFinished }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL);
    await store.appendRecords(makeRecords('a', 3, 8));
    await expect(store.appendRecords(makeRecords('b', 3, 16))).rejects.toThrow(/dimensões/);
    await expect(store.appendRecords([{ key: 'nao-hex', scale: 1, vector: new Int8Array(8) }])).rejects.toThrow(
      /chave inválida/,
    );
    await expect(openIndexStore(dir, '../fora')).rejects.toThrow(/pasta de modelo inválida/);
    expect(modelDirName({ model: 'embeddinggemma-300m', variant: 'q4', recipe: 1 })).toBe('embeddinggemma-300m-q4-r1');
  });

  it('dois modelos convivem em pastas diferentes, com o manifesto descrevendo os dois', async ({ onTestFinished }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const one = await openIndexStore(dir, { model: 'teste', variant: 'q8', recipe: 1 });
    const two = await openIndexStore(dir, OTHER_MODEL, { dims: 32 });
    await one.appendRecords(makeRecords('a', 10, DIMS));
    await two.appendRecords(makeRecords('a', 7, 32));
    expect(await collect(one)).toHaveLength(10);
    expect(await collect(two)).toHaveLength(7);
    const manifest = await readIndexManifest(dir);
    expect(manifest?.models).toEqual({
      [MODEL]: { model: 'teste', variant: 'q8', recipe: 1, dims: DIMS, segments: 1, vectors: 10 },
      [OTHER_MODEL]: { recipe: 2, dims: 32, segments: 1, vectors: 7 },
    });
    expect(manifest?.vectors).toBe(17);
  });

  it('pasta de trabalho em qualquer estado: mudanças preparadas, edição pendente e merge em conflito ficam intactos', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    // conflito de merge em andamento no main
    await git(dir, ['checkout', '--quiet', '-b', 'lado']);
    write(dir, 'wiki/x.md', '# Nota X\n\nLado.\n');
    await git(dir, ['commit', '--quiet', '-am', 'lado']);
    await git(dir, ['checkout', '--quiet', 'main']);
    write(dir, 'wiki/x.md', '# Nota X\n\nMain.\n');
    await git(dir, ['commit', '--quiet', '-am', 'main']);
    expect((await gitTry(dir, ['merge', 'lado'])).code).not.toBe(0);
    write(dir, 'wiki/nova.md', 'preparada\n');
    await git(dir, ['add', 'wiki/nova.md']);
    write(dir, 'wiki/solta.md', 'não preparada\n');
    const statusBefore = await git(dir, ['status', '--porcelain']);
    const staged = await git(dir, ['diff', '--cached', '--name-only']);

    const store = await openIndexStore(dir, MODEL);
    await store.appendRecords(makeRecords('a', 10));
    await writeIndexFile(dir, 'graph/nodes.jsonl', '{"id":"wiki/x.md"}\n');
    expect(await collect(store)).toHaveLength(10);
    expect(await git(dir, ['status', '--porcelain'])).toBe(statusBefore);
    expect(await git(dir, ['diff', '--cached', '--name-only'])).toBe(staged);
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('vault movido de lugar e .cabecao/ apagada: tudo continua legível e gravável', async ({ onTestFinished }) => {
    const { dir, root, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL, { cache: true });
    await store.appendRecords(makeRecords('a', 10));
    expect(await collect(store)).toHaveLength(10);
    const moved = join(root, 'movido para cá');
    renameSync(dir, moved);
    removeDir(join(moved, '.cabecao'));
    const reopened = await openIndexStore(moved, MODEL, { cache: true });
    expect(await collect(reopened)).toHaveLength(10);
    await reopened.appendRecords(makeRecords('b', 5));
    expect((await reopened.listKeys()).size).toBe(15);
    // o cache foi reconstruído a partir do git
    expect(readdirSync(join(moved, '.cabecao', 'index', 'embeddings', MODEL))).toHaveLength(2);
  });

  it('cache local: segmento corrompido no cache é relido do git e regravado; segmento que saiu da branch é apagado', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL, { cache: true });
    const { segments } = await store.appendRecords(makeRecords('a', 10));
    await collect(store);
    const cached = join(dir, '.cabecao', 'index', ...(segments[0]?.path ?? '').split('/'));
    const good = readFileSync(cached);
    writeFileSync(cached, good.subarray(0, 30));
    const stray = join(dir, '.cabecao', 'index', 'embeddings', MODEL, `seg-${'a'.repeat(32)}.bin`);
    writeFileSync(stray, 'lixo');
    expect(await collect(store)).toHaveLength(10);
    expect(store.issues).toEqual([]);
    expect(readFileSync(cached).equals(good)).toBe(true);
    expect(existsSync(stray)).toBe(false);
  });

  it('segmento inválido DENTRO da branch (truncado, nome errado, outra dimensão) é ignorado e reportado, sem derrubar a leitura', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL);
    await store.appendRecords(makeRecords('ok', 10));
    // planta segmentos ruins direto no banco de objetos (como chegariam de um remoto danificado)
    const good = encodeSegment(makeRecords('ruim', 5), DIMS);
    const otherDims = encodeSegment(makeRecords('dim', 5, 8), 8);
    const blobOf = async (bytes: Buffer) => {
      const tmp = join(dir, '.git', 'tmp-blob');
      writeFileSync(tmp, bytes);
      return git(dir, ['hash-object', '-w', tmp]);
    };
    const lines = [
      `100644 blob ${await blobOf(good.bytes.subarray(0, 40))}\tembeddings/${MODEL}/${good.name}`,
      `100644 blob ${await blobOf(good.bytes)}\tembeddings/${MODEL}/seg-${'0'.repeat(32)}.bin`,
      `100644 blob ${await blobOf(otherDims.bytes)}\tembeddings/${MODEL}/${otherDims.name}`,
    ];
    const tip = await git(dir, ['rev-parse', 'cabecao/index']);
    const env = { GIT_INDEX_FILE: join(dir, '.git', 'tmp-index') };
    const { runGit } = await import('../../src/git/index.ts');
    await runGit(['read-tree', tip], { cwd: dir, env });
    await runGit(['update-index', '--index-info'], { cwd: dir, env, input: `${lines.join('\n')}\n` });
    const tree = (await runGit(['write-tree'], { cwd: dir, env })).stdout.trim();
    const commit = (await runGit(['commit-tree', tree, '-p', tip, '-m', 'danificado'], { cwd: dir })).stdout.trim();
    await git(dir, ['update-ref', 'refs/heads/cabecao/index', commit]);

    const fresh = await openIndexStore(dir, MODEL, { dims: DIMS });
    const issues: SegmentIssue[] = [];
    const records = [];
    for await (const r of fresh.readAll({ onIssue: (i) => issues.push(i) })) records.push(r);
    expect(records).toHaveLength(10);
    expect(issues.map((i) => i.problem).sort()).toEqual(['dims', 'name', 'truncated']);
    expect((await fresh.listKeys()).size).toBe(10);
    // e a escrita seguinte continua funcionando
    await fresh.appendRecords(makeRecords('depois', 3));
    expect(await collect(fresh)).toHaveLength(13);
  });

  it('arquivos derivados (grafo) são gravados por função genérica e preservados pelas escritas de embeddings', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL);
    await store.appendRecords(makeRecords('a', 5));
    const nodes = '{"id":"wiki/x.md","title":"Nota X"}\n';
    const w = await writeIndexFile(dir, 'graph/nodes.jsonl', nodes);
    expect(w.created).toBe(true);
    expect((await writeIndexFile(dir, 'graph/nodes.jsonl', nodes)).created).toBe(false);
    await writeIndexFile(dir, 'graph/edges.jsonl', '');
    await store.appendRecords(makeRecords('b', 5));
    expect((await readIndexFile(dir, 'graph/nodes.jsonl'))?.toString()).toBe(nodes);
    expect((await readIndexFile(dir, 'graph/edges.jsonl'))?.toString()).toBe('');
    await expect(writeIndexFile(dir, 'manifest.json', '{}')).rejects.toThrow(/manifest/);
    await expect(writeIndexFile(dir, 'embeddings/x/seg.bin', 'x')).rejects.toThrow(/embeddings/);
    await expect(writeIndexFile(dir, '../fora.txt', 'x')).rejects.toThrow(/inválido/);
    expect(parseManifest((await readIndexFile(dir, 'manifest.json')) ?? '')?.vectors).toBe(10);
  });

  it('commit sem assinatura mesmo com commit.gpgsign ligado, e identidade neutra quando o git não tem nenhuma', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    await git(dir, ['config', 'commit.gpgsign', 'true']);
    await git(dir, ['config', 'gpg.program', 'programa-que-nao-existe']);
    await git(dir, ['config', '--unset', 'user.email']);
    await git(dir, ['config', '--unset', 'user.name']);
    const store = await openIndexStore(dir, MODEL);
    const previous = { ...process.env };
    // sem identidade global também (HOME e XDG apontando para uma pasta vazia)
    process.env.HOME = join(dir, '.git');
    process.env.XDG_CONFIG_HOME = join(dir, '.git');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.EMAIL = '';
    try {
      await store.appendRecords(makeRecords('a', 3));
    } finally {
      process.env = previous;
    }
    expect(await git(dir, ['log', '-1', '--format=%G?', 'cabecao/index'])).toBe('N');
    expect(await git(dir, ['log', '-1', '--format=%an <%ae>', 'cabecao/index'])).toMatch(/<.+@.+>/);
  });

  it('segmentos grandes são divididos (limite de tamanho por segmento)', async ({ onTestFinished }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL, { maxSegmentBytes: 2_000 });
    const result = await store.appendRecords(makeRecords('a', 200));
    expect(result.segments.length).toBeGreaterThan(1);
    expect(result.segments.every((s) => s.bytes <= 2_000)).toBe(true);
    expect(await collect(store)).toHaveLength(200);
  });

  it('dois escritores ao mesmo tempo (mesmo processo e processos diferentes): a trava serializa, nada se perde', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL, { dims: DIMS });
    await Promise.all([1, 2, 3, 4].map((i) => store.appendRecords(makeRecords(`p${i}`, 10))));
    const children = [1, 2, 3].map((i) => waitChild(spawnChild([dir, 'append', `c${i}`, '15'])));
    const results = await Promise.all(children);
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect((await store.listKeys()).size).toBe(4 * 10 + 3 * 15);
    expect(await git(dir, ['rev-list', '--count', 'cabecao/index'])).toBe('7');
    expect(existsSync(join(dir, '.cabecao', 'locks', 'index-branch.lock'))).toBe(false);
  });

  it('update-ref condicional: branch movida por fora entre a leitura e a escrita é detectada, não sobrescrita', async ({
    onTestFinished,
  }) => {
    const { dir, cleanup } = await repo();
    onTestFinished(cleanup);
    const store = await openIndexStore(dir, MODEL);
    await store.appendRecords(makeRecords('a', 3));
    const before = await git(dir, ['rev-parse', 'cabecao/index']);
    let moved = '';
    const racing = await openIndexStore(dir, MODEL, {
      faultAt: async (step) => {
        if (step !== 'commit-written' || moved) return;
        // um processo que não respeita a trava move a branch neste instante
        moved = (await git(dir, ['commit-tree', `${before}^{tree}`, '-p', before, '-m', 'por fora'])).trim();
        await git(dir, ['update-ref', generationRef(0), moved]);
      },
    });
    await expect(racing.appendRecords(makeRecords('b', 3))).rejects.toThrow(/mudou durante a operação/);
    expect(await git(dir, ['rev-parse', 'cabecao/index'])).toBe(moved);
    // a próxima escrita parte do valor novo
    await store.appendRecords(makeRecords('b', 3));
    expect(await git(dir, ['rev-parse', 'cabecao/index^'])).toBe(moved);
  });
});
