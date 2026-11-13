import { describe, expect, it } from 'vitest';
import { findCatalogModel } from '../src/catalog.ts';
import {
  dot,
  encodeTruncated,
  halfToFloat,
  l2Normalize,
  padBatch,
  planBatches,
  poolOutput,
  type TokenizerLike,
  toFloat32,
} from '../src/inference.ts';
import { applyTemplate, formatInput } from '../src/prompt.ts';

const e5 = findCatalogModel('multilingual-e5-small')?.prompts;
const gemma = findCatalogModel('embeddinggemma-300m')?.prompts;
const bge = findCatalogModel('bge-m3')?.prompts;
if (!e5 || !gemma || !bge) throw new Error('catálogo incompleto');

describe('formatInput', () => {
  it('aplica os prefixos de pergunta e de trecho de cada modelo', () => {
    expect(formatInput(e5, 'filas', 'query')).toBe('query: filas');
    expect(formatInput(e5, 'texto', 'passage')).toBe('passage: texto');
    expect(formatInput(e5, { text: 'texto', title: 'Projeto › Decisões' }, 'passage')).toBe(
      'passage: Projeto › Decisões\ntexto',
    );
    expect(formatInput(gemma, 'filas', 'query')).toBe('task: search result | query: filas');
    expect(formatInput(gemma, 'texto', 'passage')).toBe('title: none | text: texto');
    expect(formatInput(gemma, { text: 'texto', title: 'A › B' }, 'passage')).toBe('title: A › B | text: texto');
    expect(formatInput(bge, { text: 'texto', title: 'A' }, 'passage')).toBe('A\ntexto');
  });

  it('ignora o título na pergunta e trata título vazio como ausente', () => {
    expect(formatInput(e5, { text: 'x', title: 'T' }, 'query')).toBe('query: x');
    expect(formatInput(gemma, { text: 'x', title: '' }, 'passage')).toBe('title: none | text: x');
    expect(formatInput(gemma, { text: 'x', title: null }, 'passage')).toBe('title: none | text: x');
  });

  it('não relê como molde o texto inserido', () => {
    expect(applyTemplate('a {{b}} {text}', { text: '{title} {{x}}', title: 'T' })).toBe('a {b} {title} {{x}}');
  });
});

/** Um caractere = um token; especiais 1 (início) e 2 (fim). */
const tokenizer: TokenizerLike = {
  encode: (text, options) => {
    const ids = Array.from(text, (c) => c.codePointAt(0) ?? 0);
    return { ids: options?.add_special_tokens === false ? ids : [1, ...ids, 2] };
  },
  token_to_id: () => undefined,
};

describe('encodeTruncated', () => {
  it('não mexe no que cabe', () => {
    expect(encodeTruncated(tokenizer, 'abc', 10)).toEqual([1, 97, 98, 99, 2]);
  });

  it('corta o conteúdo e mantém os especiais do começo e do fim', () => {
    expect(encodeTruncated(tokenizer, 'abcdefgh', 5)).toEqual([1, 97, 98, 99, 2]);
  });

  it('funciona com tokenizador sem especiais de fim', () => {
    const onlyStart: TokenizerLike = {
      encode: (text, options) => {
        const ids = Array.from(text, (c) => c.codePointAt(0) ?? 0);
        return { ids: options?.add_special_tokens === false ? ids : [1, ...ids] };
      },
      token_to_id: () => undefined,
    };
    expect(encodeTruncated(onlyStart, 'abcdef', 3)).toEqual([1, 97, 98]);
  });
});

describe('planBatches', () => {
  it('ordena por tamanho e respeita os dois limites', () => {
    const lengths = [10, 3, 50, 4, 9, 2];
    const batches = planBatches(lengths, { batchSize: 2, maxBatchTokens: 1000 });
    expect(batches).toEqual([
      [5, 1],
      [3, 4],
      [0, 2],
    ]);
    const byTokens = planBatches(lengths, { batchSize: 10, maxBatchTokens: 20 });
    for (const batch of byTokens) {
      const width = Math.max(...batch.map((i) => lengths[i] ?? 0));
      if (batch.length > 1) expect(width * batch.length).toBeLessThanOrEqual(20);
    }
    expect(byTokens.flat().sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('um texto maior que o limite vai sozinho', () => {
    expect(planBatches([100, 1], { batchSize: 4, maxBatchTokens: 10 })).toEqual([[1], [0]]);
  });
});

describe('padBatch e poolOutput', () => {
  it('preenche à direita e monta a máscara', () => {
    const batch = padBatch([[5, 6, 7], [8]], 0);
    expect(batch.width).toBe(3);
    expect(Array.from(batch.ids)).toEqual([5n, 6n, 7n, 8n, 0n, 0n]);
    expect(Array.from(batch.mask)).toEqual([1n, 1n, 1n, 1n, 0n, 0n]);
    expect(batch.lengths).toEqual([3, 1]);
  });

  // 2 linhas × 3 tokens × 2 dims; o terceiro token da segunda linha é preenchimento (valor 99).
  const hidden = Float32Array.from([1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 99, 99]);
  const dims = [2, 3, 2];
  const lengths = [3, 2];

  it('mean ignora o preenchimento', () => {
    const [a, b] = poolOutput(hidden, dims, lengths, 'mean');
    expect(Array.from(a ?? [])).toEqual([3, 4]);
    expect(Array.from(b ?? [])).toEqual([20, 30]);
  });

  it('cls pega o primeiro token e last_token o último válido', () => {
    expect(poolOutput(hidden, dims, lengths, 'cls').map((v) => Array.from(v))).toEqual([
      [1, 2],
      [10, 20],
    ]);
    expect(poolOutput(hidden, dims, lengths, 'last_token').map((v) => Array.from(v))).toEqual([
      [5, 6],
      [30, 40],
    ]);
  });

  it('saída já agregada passa direto; graph exige saída agregada', () => {
    expect(poolOutput(Float32Array.from([1, 2, 3, 4]), [2, 2], [1, 1], 'graph').map((v) => Array.from(v))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(() => poolOutput(hidden, dims, lengths, 'graph')).toThrow(/graph/);
    expect(() => poolOutput(hidden, [12], lengths, 'mean')).toThrow(/forma inesperada/);
  });
});

describe('normalização e conversões', () => {
  it('l2Normalize deixa comprimento 1 e não divide por zero', () => {
    const v = l2Normalize(Float32Array.from([3, 4]));
    expect(Array.from(v)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(dot(v, v)).toBeCloseTo(1, 6);
    expect(Array.from(l2Normalize(new Float32Array(3)))).toEqual([0, 0, 0]);
  });

  it('converte meia precisão e outros tipos para Float32Array', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x3800)).toBe(0.5);
    expect(halfToFloat(0x7c00)).toBe(Number.POSITIVE_INFINITY);
    expect(Array.from(toFloat32(Uint16Array.from([0x3c00, 0x4000])))).toEqual([1, 2]);
    expect(Array.from(toFloat32(Float64Array.from([1.5])))).toEqual([1.5]);
    const same = Float32Array.from([1]);
    expect(toFloat32(same)).toBe(same);
    expect(() => toFloat32('x')).toThrow();
  });
});
