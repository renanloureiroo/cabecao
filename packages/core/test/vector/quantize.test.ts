import { describe, expect, it } from 'vitest';
import { cosine, dequantize, INT8_MAX, isVectorKey, quantizeInt8, VectorStore } from '../../src/vector/index.ts';
import { keyOf, prng, randomUnit, withCosine } from './helpers.ts';

describe('quantizeInt8 e dequantize', () => {
  it('usa escala por vetor: o maior módulo vira ±127 e a escala é maxAbs / 127 em float32', () => {
    const { scale, vector } = quantizeInt8(new Float32Array([0.5, -1, 0.25, 0]));
    expect(scale).toBe(Math.fround(1 / 127));
    expect([...vector]).toEqual([64, -127, 32, 0]); // 63,5 → 64 (meio para longe do zero)
    expect([...dequantize({ scale, vector })]).toEqual([64, -127, 32, 0].map((v) => Math.fround(v * scale)));
  });

  it('arredonda de forma simétrica e nunca produz -128', () => {
    // maior módulo 127 → escala exatamente 1, então os meios são exatos
    const values = new Float32Array([127, -127, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5]);
    const { scale, vector } = quantizeInt8(values);
    expect(scale).toBe(1);
    expect([...vector]).toEqual([127, -127, 1, -1, 2, -2, 3, -3]);
    const negated = quantizeInt8(values.map((v) => -v));
    expect([...negated.vector]).toEqual([...vector].map((v) => -v));
    const random = prng(3);
    for (let n = 0; n < 200; n++) {
      const q = quantizeInt8(randomUnit(17, random));
      expect(Math.min(...q.vector)).toBeGreaterThanOrEqual(-INT8_MAX);
      expect(Math.max(...q.vector.map(Math.abs))).toBe(INT8_MAX);
    }
  });

  it('é determinística: o mesmo vetor dá os mesmos bytes e a mesma escala', () => {
    const v = randomUnit(768, prng(11));
    const a = quantizeInt8(v);
    const b = quantizeInt8(Float32Array.from(v));
    expect(b.scale).toBe(a.scale);
    expect(Buffer.from(b.vector.buffer).equals(Buffer.from(a.vector.buffer))).toBe(true);
    // a escala ignora o tamanho do vetor: o dobro do vetor dá os mesmos bytes e o dobro da escala
    const doubled = quantizeInt8(v.map((x) => x * 2));
    expect([...doubled.vector]).toEqual([...a.vector]);
    expect(doubled.scale).toBe(Math.fround(a.scale * 2));
  });

  it('perde quase nada: cosseno entre original e reconstruído ≥ 0,9999 (384d e 768d)', () => {
    const random = prng(42);
    for (const dims of [384, 768]) {
      let min = 1;
      let sum = 0;
      const n = 500;
      for (let i = 0; i < n; i++) {
        const v = randomUnit(dims, random);
        const c = cosine(v, dequantize(quantizeInt8(v)));
        min = Math.min(min, c);
        sum += c;
      }
      // medido: média 0,99997 e mínimo 0,99993 nas duas dimensões
      expect(min).toBeGreaterThan(0.9999);
      expect(sum / n).toBeGreaterThan(0.99995);
    }
  });

  it('preserva a ordem do top-10 quando os vizinhos têm folga entre si', () => {
    const random = prng(7);
    const dims = 384;
    const query = randomUnit(dims, random);
    // 10 vizinhos plantados com cossenos de 0,90 a 0,45 e 3 mil distratores aleatórios (cosseno ~ ±0,15)
    const targets = Array.from({ length: 10 }, (_, i) => 0.9 - i * 0.05);
    const records = targets.map((t, i) => ({ key: keyOf(i), ...quantizeInt8(withCosine(query, t, random)) }));
    for (let i = 0; i < 3000; i++) records.push({ key: keyOf(1000 + i), ...quantizeInt8(randomUnit(dims, random)) });
    const store = new VectorStore({ dims }, records);
    const hits = store.search(query, 10);
    expect(hits.map((h) => h.key)).toEqual(targets.map((_, i) => keyOf(i)));
    hits.forEach((hit, i) => {
      expect(Math.abs(hit.cosine - (targets[i] as number))).toBeLessThan(5e-3);
    });
  });

  it('em vetores aleatórios sem folga, o top-10 int8 coincide com o float32 em ≥ 95%', () => {
    const random = prng(42);
    const dims = 384;
    const docs = Array.from({ length: 2000 }, () => randomUnit(dims, random));
    const store = new VectorStore(
      { dims },
      docs.map((d, i) => ({ key: keyOf(i), ...quantizeInt8(d) })),
    );
    let overlap = 0;
    let maxError = 0;
    const queries = 50;
    for (let q = 0; q < queries; q++) {
      const query = randomUnit(dims, random);
      const exact = docs
        .map((d, i) => ({ i, c: cosine(query, d) }))
        .sort((a, b) => b.c - a.c)
        .slice(0, 10)
        .map((e) => e.i);
      const got = store.search(query, 10);
      overlap += got.filter((h) => exact.includes(Number.parseInt(h.key, 16))).length / 10;
      for (const h of got) {
        maxError = Math.max(
          maxError,
          Math.abs(h.cosine - cosine(query, docs[Number.parseInt(h.key, 16)] as Float32Array)),
        );
      }
    }
    // medido: sobreposição 0,985 e erro máximo do cosseno 1,3e-3
    expect(overlap / queries).toBeGreaterThanOrEqual(0.95);
    expect(maxError).toBeLessThan(5e-3);
  });

  it('vetor nulo vira escala 0 e volta como nulo', () => {
    const q = quantizeInt8(new Float32Array(4));
    expect(q.scale).toBe(0);
    expect([...q.vector]).toEqual([0, 0, 0, 0]);
    expect([...dequantize(q)]).toEqual([0, 0, 0, 0]);
  });

  it('valores subnormais não dão escala 0 (que apagaria o vetor)', () => {
    const q = quantizeInt8(new Float32Array([1e-45, 0, -1e-45]));
    expect(q.scale).toBeGreaterThan(0);
    expect(Math.max(...q.vector.map(Math.abs))).toBeGreaterThan(0);
  });

  it('recusa NaN, Infinity, vetor vazio e dimensão errada', () => {
    expect(() => quantizeInt8(new Float32Array([0.1, Number.NaN]))).toThrow(/não finito na posição 1/);
    expect(() => quantizeInt8(new Float32Array([Number.POSITIVE_INFINITY]))).toThrow(RangeError);
    expect(() => quantizeInt8(new Float32Array([Number.NEGATIVE_INFINITY, 1]))).toThrow(RangeError);
    expect(() => quantizeInt8(new Float32Array(0))).toThrow(/vazio/);
    expect(() => quantizeInt8(new Float32Array(3), 4)).toThrow(/3 dimensões; esperado 4/);
    expect(() => dequantize({ scale: -1, vector: new Int8Array(2) })).toThrow(/escala/);
    expect(() => dequantize({ scale: Number.NaN, vector: new Int8Array(2) })).toThrow(/escala/);
  });

  it('cosine trata vetor nulo e recusa dimensões diferentes', () => {
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 12);
    expect(() => cosine([1], [1, 2])).toThrow(RangeError);
  });

  it('isVectorKey aceita só 32 hex minúsculos', () => {
    expect(isVectorKey('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isVectorKey('0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(isVectorKey('0123456789abcdef')).toBe(false);
    expect(isVectorKey('0123456789abcdef0123456789abcdeg')).toBe(false);
  });
});
