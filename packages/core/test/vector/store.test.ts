import { describe, expect, it } from 'vitest';
import type { VectorRecord } from '../../src/vector/index.ts';
import { cosine, quantizeInt8, VECTOR_OVERHEAD_BYTES, VectorStore } from '../../src/vector/index.ts';
import { keyOf, prng, randomUnit } from './helpers.ts';

function records(count: number, dims: number, seed = 1): VectorRecord[] {
  const random = prng(seed);
  return Array.from({ length: count }, (_, i) => ({ key: keyOf(i), ...quantizeInt8(randomUnit(dims, random)) }));
}

/** Top-k de referência: cosseno em float64 sobre os vetores int8 guardados (a escala não muda o cosseno). */
function bruteForce(recs: readonly VectorRecord[], query: Float32Array, k: number): { key: string; cosine: number }[] {
  return recs
    .map((r) => ({ key: r.key, cosine: cosine(query, r.vector) }))
    .sort((a, b) => b.cosine - a.cosine || (a.key < b.key ? -1 : 1))
    .slice(0, k);
}

function expectSameHits(actual: { key: string; cosine: number }[], expected: { key: string; cosine: number }[]) {
  expect(actual.map((h) => h.key)).toEqual(expected.map((h) => h.key));
  actual.forEach((hit, i) => {
    expect(hit.cosine).toBeCloseTo((expected[i] as { cosine: number }).cosine, 5);
  });
}

describe('VectorStore: carga e memória', () => {
  it('carrega de qualquer iterável (gerador inclusive) e guarda tudo num array contíguo', () => {
    const recs = records(100, 384);
    function* generate() {
      yield* recs;
    }
    const store = new VectorStore({ dims: 384 }, generate());
    expect(store.size).toBe(100);
    expect(store.capacity).toBeGreaterThanOrEqual(100);
    expect(store.stride).toBe(384);
    expect(store.byteLength).toBe(store.capacity * (384 + VECTOR_OVERHEAD_BYTES));
    for (const r of recs) expect(store.has(r.key)).toBe(true);
    expect([...store.keys()].sort()).toEqual(recs.map((r) => r.key).sort());
  });

  it('memória previsível: com a capacidade certa, dims + 8 bytes por vetor', () => {
    const store = new VectorStore({ dims: 768, capacity: 1000 }, records(1000, 768));
    expect(store.capacity).toBe(1000);
    expect(store.byteLength).toBe(1000 * (768 + 8));
    // um array já conhecido define a capacidade sozinho
    expect(new VectorStore({ dims: 768 }, records(300, 768)).byteLength).toBe(300 * 776);
  });

  it('cresce além da capacidade inicial sem perder vetores', () => {
    const recs = records(100, 8);
    const store = new VectorStore({ dims: 8, capacity: 1 });
    for (const r of recs) store.add(r);
    expect(store.size).toBe(100);
    for (const r of recs) expect(store.get(r.key)?.vector).toEqual(r.vector);
  });

  it('get devolve uma cópia do registro guardado', () => {
    const [record] = records(1, 16) as [VectorRecord];
    const store = new VectorStore({ dims: 16 }, [record]);
    const got = store.get(record.key);
    expect(got).toEqual({ key: record.key, scale: Math.fround(record.scale), vector: record.vector });
    got?.vector.fill(0);
    expect(store.get(record.key)?.vector).toEqual(record.vector);
    expect(store.get(keyOf(999))).toBeUndefined();
  });

  it('chave repetida substitui o vetor (add devolve false)', () => {
    const store = new VectorStore({ dims: 4 });
    expect(store.add({ key: keyOf(1), ...quantizeInt8(new Float32Array([1, 0, 0, 0])) })).toBe(true);
    expect(store.add({ key: keyOf(1), ...quantizeInt8(new Float32Array([0, 1, 0, 0])) })).toBe(false);
    expect(store.size).toBe(1);
    const [hit] = store.search(new Float32Array([0, 1, 0, 0]), 1);
    expect(hit?.key).toBe(keyOf(1));
    expect(hit?.cosine).toBeCloseTo(1, 6); // o inverso da norma fica em float32
  });

  it('remove mantém o array contíguo e a busca correta', () => {
    const dims = 32;
    const recs = records(50, dims, 5);
    const store = new VectorStore({ dims }, recs);
    const removed = new Set([0, 7, 49, 13].map(keyOf));
    for (const key of removed) expect(store.remove(key)).toBe(true);
    expect(store.remove(keyOf(7))).toBe(false);
    expect(store.size).toBe(46);
    for (const key of removed) expect(store.has(key)).toBe(false);
    const kept = recs.filter((r) => !removed.has(r.key));
    for (const r of kept) expect(store.get(r.key)?.vector).toEqual(r.vector);
    const query = randomUnit(dims, prng(99));
    expectSameHits(store.search(query, 46), bruteForce(kept, query, 46));
    // removido e devolvido
    store.add(recs[0] as VectorRecord);
    expect(store.search(query, 47).map((h) => h.key)).toContain(keyOf(0));
  });

  it('recusa chave inválida, dimensão errada, escala inválida e vetor que não é Int8Array', () => {
    const store = new VectorStore({ dims: 4 });
    const vector = new Int8Array(4);
    expect(() => store.add({ key: 'abc', scale: 1, vector })).toThrow(/chave de vetor inválida/);
    expect(() => store.add({ key: keyOf(0xabc).toUpperCase(), scale: 1, vector })).toThrow(/chave/);
    expect(() => store.add({ key: keyOf(1), scale: 1, vector: new Int8Array(5) })).toThrow(/5 dimensões; esperado 4/);
    expect(() => store.add({ key: keyOf(1), scale: -1, vector })).toThrow(/escala/);
    expect(() => store.add({ key: keyOf(1), scale: Number.NaN, vector })).toThrow(/escala/);
    expect(() => store.add({ key: keyOf(1), scale: 1, vector: new Uint8Array(4) as unknown as Int8Array })).toThrow(
      TypeError,
    );
    expect(() => new VectorStore({ dims: 0 })).toThrow(/dimensão/);
    expect(() => new VectorStore({ dims: 1.5 })).toThrow(/dimensão/);
    expect(() => new VectorStore({ dims: 4, capacity: -1 })).toThrow(/capacidade/);
    expect(store.size).toBe(0);
  });
});

describe('VectorStore: busca', () => {
  it('top-k igual à força bruta de referência (384d e 768d)', () => {
    for (const dims of [384, 768]) {
      const recs = records(500, dims, dims);
      const store = new VectorStore({ dims }, recs);
      const random = prng(dims + 1);
      for (let q = 0; q < 5; q++) {
        const query = randomUnit(dims, random);
        expectSameHits(store.search(query, 10), bruteForce(recs, query, 10));
      }
    }
  });

  it('funciona com dimensão que não é múltipla de 4 (o preenchimento não interfere)', () => {
    for (const dims of [1, 5, 7, 382]) {
      const recs = records(60, dims, dims);
      const store = new VectorStore({ dims }, recs);
      expect(store.stride % 4).toBe(0);
      expect(store.stride - dims).toBeLessThan(4);
      const query = randomUnit(dims, prng(dims + 7));
      expectSameHits(store.search(query, 60), bruteForce(recs, query, 60));
      expect(store.get(keyOf(3))?.vector.length).toBe(dims);
    }
  });

  it('o cosseno não depende do tamanho da pergunta (normaliza por dentro)', () => {
    const store = new VectorStore({ dims: 64 }, records(100, 64));
    const query = randomUnit(64, prng(4));
    const scaled = query.map((v) => v * 37.5);
    expectSameHits(store.search(scaled, 10), store.search(query, 10));
  });

  it('k maior que o armazém devolve tudo; k = 0 e armazém vazio devolvem lista vazia', () => {
    const store = new VectorStore({ dims: 8 }, records(5, 8));
    const query = randomUnit(8, prng(2));
    expect(store.search(query, 50)).toHaveLength(5);
    expect(store.search(query, 0)).toEqual([]);
    expect(new VectorStore({ dims: 8 }).search(query, 10)).toEqual([]);
  });

  it('empates são desfeitos pela chave, qualquer que seja a ordem de inserção', () => {
    const v = quantizeInt8(new Float32Array([0.6, 0.8, 0, 0]));
    const keys = [5, 1, 9, 3, 7].map(keyOf);
    const forward = new VectorStore(
      { dims: 4 },
      keys.map((key) => ({ key, ...v })),
    );
    const backward = new VectorStore(
      { dims: 4 },
      [...keys].reverse().map((key) => ({ key, ...v })),
    );
    const query = new Float32Array([0.6, 0.8, 0, 0]);
    const expected = [1, 3, 5].map(keyOf);
    expect(forward.search(query, 3).map((h) => h.key)).toEqual(expected);
    expect(backward.search(query, 3).map((h) => h.key)).toEqual(expected);
  });

  it('vetor nulo guardado tem cosseno 0; cosseno fica em [-1, 1]', () => {
    const store = new VectorStore({ dims: 3 }, [
      { key: keyOf(1), scale: 0, vector: new Int8Array(3) },
      { key: keyOf(2), ...quantizeInt8(new Float32Array([1, 0, 0])) },
      { key: keyOf(3), ...quantizeInt8(new Float32Array([-1, 0, 0])) },
    ]);
    const hits = store.search(new Float32Array([1, 0, 0]), 3);
    expectSameHits(hits, [
      { key: keyOf(2), cosine: 1 },
      { key: keyOf(1), cosine: 0 },
      { key: keyOf(3), cosine: -1 },
    ]);
    expect(hits[1]?.cosine).toBe(0);
    for (const hit of hits) expect(Math.abs(hit.cosine)).toBeLessThanOrEqual(1);
  });

  it('filtro: aplicado só a quem entraria no top-k, e o resultado é o top-k dos aceitos', () => {
    const dims = 16;
    const recs = records(400, dims, 8);
    const store = new VectorStore({ dims }, recs);
    const query = randomUnit(dims, prng(81));
    const accept = (key: string) => Number.parseInt(key, 16) % 3 === 0;
    let calls = 0;
    const hits = store.search(query, 5, {
      filter: (key) => {
        calls++;
        return accept(key);
      },
    });
    expectSameHits(
      hits,
      bruteForce(
        recs.filter((r) => accept(r.key)),
        query,
        5,
      ),
    );
    expect(calls).toBeLessThan(400);
    expect(store.search(query, 5, { filter: () => false })).toEqual([]);
  });

  it('recusa pergunta de outra dimensão, com NaN/Infinity ou nula, e k inválido', () => {
    const store = new VectorStore({ dims: 4 }, records(3, 4));
    expect(() => store.search(new Float32Array(3), 1)).toThrow(/3 dimensões; esperado 4/);
    expect(() => store.search(new Float32Array([1, Number.NaN, 0, 0]), 1)).toThrow(/não finito/);
    expect(() => store.search(new Float32Array([1, Number.POSITIVE_INFINITY, 0, 0]), 1)).toThrow(/não finito/);
    expect(() => store.search(new Float32Array(4), 1)).toThrow(/nulo/);
    expect(() => store.search(new Float32Array([1, 0, 0, 0]), -1)).toThrow(/k inválido/);
    expect(() => store.search(new Float32Array([1, 0, 0, 0]), 1.5)).toThrow(/k inválido/);
  });

  it('é rápida: 20 mil vetores de 384 dimensões bem abaixo do limite folgado', () => {
    // Nesta máquina (Apple M3 Pro, Node 24): 100 mil × 384 em ~24 ms e 100 mil × 768 em ~47 ms. Aqui o limite é
    // largo de propósito, para os runners lentos do Windows: o teste pega uma regressão de ordem de grandeza.
    const dims = 384;
    const count = 20_000;
    const random = prng(123);
    const store = new VectorStore({ dims, capacity: count });
    const vector = new Int8Array(dims);
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < dims; j++) vector[j] = Math.floor(random() * 255) - 127;
      store.add({ key: keyOf(i), scale: 0.01, vector });
    }
    const query = randomUnit(dims, random);
    store.search(query, 10); // aquecimento do JIT
    const times: number[] = [];
    for (let r = 0; r < 5; r++) {
      const start = performance.now();
      const hits = store.search(query, 10);
      times.push(performance.now() - start);
      expect(hits).toHaveLength(10);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(1000);
  });
});
