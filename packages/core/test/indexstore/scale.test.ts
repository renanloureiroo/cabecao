import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { compactIndex, type EmbeddingRecord, openIndexStore } from '../../src/indexstore/index.ts';
import { git, initRepo, MODEL, makeRecords, removeDir, TEST_TIMEOUT_MS, tempRoot } from './helpers.ts';

// Escala moderada por padrão; `CABECAO_INDEX_SCALE=100000` mede o caso do doc 03 (100 mil vetores). Com
// `CABECAO_INDEX_BENCH_OUT=<arquivo>`, os números medidos são gravados em JSON.
const N = Number(process.env.CABECAO_INDEX_SCALE ?? 20_000);
const DIMS = 384;
const BATCHES = 4;

async function load(dir: string, cache: boolean): Promise<{ ms: number; count: number; check: number }> {
  const store = await openIndexStore(dir, MODEL, { cache });
  const t0 = performance.now();
  const vectors = new Int8Array(N * DIMS);
  const scales = new Float32Array(N);
  let count = 0;
  for await (const record of store.readAll()) {
    vectors.set(record.vector, count * DIMS);
    scales[count] = record.scale;
    count++;
  }
  return { ms: performance.now() - t0, count, check: (vectors[DIMS * 7 + 3] ?? 0) + (scales[11] ?? 0) };
}

describe('indexstore: escala e tamanho no git', { timeout: TEST_TIMEOUT_MS * 4 }, () => {
  it(`${N} vetores de ${DIMS} dimensões: carga em lote e bytes por vetor no git`, async ({ onTestFinished }) => {
    const root = tempRoot();
    onTestFinished(() => removeDir(root));
    const dir = join(root, 'c');
    await initRepo(dir);
    const store = await openIndexStore(dir, MODEL, { dims: DIMS });
    const all: EmbeddingRecord[] = makeRecords('escala', N, DIMS, 42);
    const tAppend = performance.now();
    for (let b = 0; b < BATCHES; b++) {
      await store.appendRecords(all.slice((b * N) / BATCHES, ((b + 1) * N) / BATCHES));
    }
    const appendMs = performance.now() - tAppend;

    const cold = await load(dir, false);
    const warm = await load(dir, false);
    await load(dir, true); // grava o cache
    const cached = await load(dir, true);
    const tBulk = performance.now();
    const snapshot = await (await openIndexStore(dir, MODEL)).loadAll();
    const loadAllMs = performance.now() - tBulk;
    expect(snapshot.count).toBe(N);
    expect(snapshot.vectors.length).toBe(N * DIMS);
    const sample = all[1234];
    const row = snapshot.keys.indexOf(sample?.key ?? '');
    expect([...snapshot.vectors.subarray(row * DIMS, row * DIMS + 8)]).toEqual([
      ...(sample?.vector.subarray(0, 8) ?? []),
    ]);
    expect(snapshot.scales[row]).toBe(sample?.scale);
    expect(cold.count).toBe(N);
    expect(cached.count).toBe(N);
    const tKeys = performance.now();
    const keys = await (await openIndexStore(dir, MODEL)).listKeys();
    const keysMs = performance.now() - tKeys;
    expect(keys.size).toBe(N);

    // tamanho real dos segmentos no banco de objetos (zlib dos objetos soltos; vetores aleatórios não comprimem)
    const blobs = (await git(dir, ['ls-tree', '-r', '--format=%(objectname)', 'cabecao/index', '--', 'embeddings/']))
      .split('\n')
      .filter(Boolean);
    const disk = (await git(dir, ['cat-file', '--batch-check=%(objectsize:disk)'], `${blobs.join('\n')}\n`))
      .split('\n')
      .reduce((sum, n) => sum + Number(n), 0);
    const bytesPerVector = disk / N;
    expect(bytesPerVector).toBeLessThan((16 + 4 + DIMS) * 1.05);

    const tCompact = performance.now();
    const compacted = await compactIndex(dir);
    const compactMs = performance.now() - tCompact;
    expect(compacted?.after.vectors).toBe(N);
    expect(compacted?.before.segments).toBe(BATCHES);

    // limites folgados (CI no Windows); os números reais vão para o relatório
    expect(cold.ms).toBeLessThan(N <= 20_000 ? 5_000 : 15_000);
    expect(loadAllMs).toBeLessThan(N <= 20_000 ? 5_000 : 15_000);
    const numbers = {
      vectors: N,
      dims: DIMS,
      appendMs: Math.round(appendMs),
      loadAllMs: Math.round(loadAllMs),
      readAllColdMs: Math.round(cold.ms),
      readAllWarmMs: Math.round(warm.ms),
      readAllFromCacheMs: Math.round(cached.ms),
      listKeysMs: Math.round(keysMs),
      bytesInGit: disk,
      bytesPerVector: Number(bytesPerVector.toFixed(1)),
      compactMs: Math.round(compactMs),
      compact: { before: compacted?.before, after: compacted?.after },
    };
    if (process.env.CABECAO_INDEX_BENCH_OUT)
      writeFileSync(process.env.CABECAO_INDEX_BENCH_OUT, JSON.stringify(numbers, null, 2));
  });
});
