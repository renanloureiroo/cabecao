/**
 * Partes puras do cálculo dos vetores: corte em tokens, montagem dos lotes, agregação e normalização. Ficam aqui,
 * longe do onnxruntime, para serem testadas sem modelo.
 */
import type { Pooling } from './catalog.ts';

/** Tokenizador mínimo de que o embedder precisa (o de `@huggingface/tokenizers` serve). */
export interface TokenizerLike {
  encode(text: string, options?: { add_special_tokens?: boolean }): { ids: number[] };
  token_to_id(token: string): number | undefined;
}

/**
 * Tokeniza com os tokens especiais e, se passar de `maxTokens`, corta o conteúdo no fim mantendo os especiais do
 * começo e do fim (o mesmo que o corte do transformers.js faz para uma sequência só).
 */
export function encodeTruncated(tokenizer: TokenizerLike, text: string, maxTokens: number): number[] {
  const full = tokenizer.encode(text).ids;
  if (full.length <= maxTokens) return full;
  const content = tokenizer.encode(text, { add_special_tokens: false }).ids;
  const specials = full.length - content.length;
  const lead = specials > 0 ? leadingSpecials(full, content) : 0;
  const trail = Math.max(0, specials - lead);
  const room = Math.max(1, maxTokens - lead - trail);
  return [...full.slice(0, lead), ...content.slice(0, room), ...(trail > 0 ? full.slice(full.length - trail) : [])];
}

/** Quantos tokens especiais vêm antes do conteúdo: a posição em que o conteúdo começa dentro da sequência cheia. */
function leadingSpecials(full: readonly number[], content: readonly number[]): number {
  if (content.length === 0) return full.length;
  const maxLead = full.length - content.length;
  for (let lead = 0; lead <= maxLead; lead++) {
    let same = true;
    for (let i = 0; i < Math.min(content.length, 8); i++) {
      if (full[lead + i] !== content[i]) {
        same = false;
        break;
      }
    }
    if (same) return lead;
  }
  return 0;
}

export interface BatchLimits {
  /** Textos por lote. */
  batchSize: number;
  /** Tokens por lote, contando o preenchimento (lote × maior sequência): limita a memória da inferência. */
  maxBatchTokens: number;
}

/**
 * Agrupa os textos em lotes de tamanhos parecidos (ordenados pelo número de tokens, para preencher pouco), sem passar
 * dos limites. Devolve os índices originais de cada lote. Um texto sozinho sempre forma um lote, mesmo que passe de
 * `maxBatchTokens`.
 */
export function planBatches(lengths: readonly number[], limits: BatchLimits): number[][] {
  const order = lengths.map((_, index) => index).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0));
  const batches: number[][] = [];
  let current: number[] = [];
  let currentMax = 0;
  for (const index of order) {
    const length = lengths[index] ?? 0;
    const nextMax = Math.max(currentMax, length);
    const fits = current.length < limits.batchSize && nextMax * (current.length + 1) <= limits.maxBatchTokens;
    if (current.length > 0 && !fits) {
      batches.push(current);
      current = [];
      currentMax = 0;
    }
    current.push(index);
    currentMax = Math.max(currentMax, length);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Matriz preenchida à direita: ids, máscara de atenção e o comprimento real de cada linha. */
export interface PaddedBatch {
  rows: number;
  width: number;
  ids: BigInt64Array;
  mask: BigInt64Array;
  lengths: number[];
}

export function padBatch(sequences: readonly (readonly number[])[], padId: number): PaddedBatch {
  const rows = sequences.length;
  const width = Math.max(1, ...sequences.map((seq) => seq.length));
  const ids = new BigInt64Array(rows * width).fill(BigInt(padId));
  const mask = new BigInt64Array(rows * width);
  const lengths: number[] = [];
  sequences.forEach((seq, row) => {
    for (let i = 0; i < seq.length; i++) {
      ids[row * width + i] = BigInt(seq[i] ?? padId);
      mask[row * width + i] = 1n;
    }
    lengths.push(seq.length);
  });
  return { rows, width, ids, mask, lengths };
}

/**
 * Agrega a saída do grafo em um vetor por linha.
 * - Saída 3D `[linhas, tokens, dims]`: `mean`, `cls` ou `last_token`, usando o comprimento real de cada linha.
 * - Saída 2D `[linhas, dims]`: o vetor já agregado (`graph`).
 */
export function poolOutput(
  data: Float32Array,
  dims: readonly number[],
  lengths: readonly number[],
  pooling: Pooling,
): Float32Array[] {
  if (dims.length === 2) {
    const [rows = 0, size = 0] = dims;
    return Array.from({ length: rows }, (_, row) => data.slice(row * size, (row + 1) * size));
  }
  if (dims.length !== 3) throw new Error(`saída do modelo com forma inesperada: [${dims.join(', ')}]`);
  if (pooling === 'graph') throw new Error('agregação "graph" exige uma saída já agregada ([linhas, dims])');
  const [rows = 0, width = 0, size = 0] = dims;
  const out: Float32Array[] = [];
  for (let row = 0; row < rows; row++) {
    const length = Math.max(1, Math.min(width, lengths[row] ?? width));
    const base = row * width * size;
    if (pooling === 'cls') {
      out.push(data.slice(base, base + size));
    } else if (pooling === 'last_token') {
      const start = base + (length - 1) * size;
      out.push(data.slice(start, start + size));
    } else {
      const vector = new Float32Array(size);
      for (let token = 0; token < length; token++) {
        const start = base + token * size;
        for (let j = 0; j < size; j++) vector[j] = (vector[j] ?? 0) + (data[start + j] ?? 0);
      }
      for (let j = 0; j < size; j++) vector[j] = (vector[j] ?? 0) / length;
      out.push(vector);
    }
  }
  return out;
}

/** Normaliza para comprimento 1, no lugar. Vetor nulo fica nulo. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** Produto escalar; igual ao cosseno quando os dois vetores estão normalizados. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/**
 * Converte a saída do onnxruntime para `Float32Array`. Modelos em fp16 devolvem meia precisão, como
 * `Float16Array` (Node recente) ou como os bits crus num `Uint16Array`.
 */
export function toFloat32(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) return Float32Array.from(data, halfToFloat);
  if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    const values = data as unknown as ArrayLike<number | bigint>;
    return Float32Array.from({ length: values.length }, (_, i) => Number(values[i]));
  }
  if (Array.isArray(data)) return Float32Array.from(data as number[]);
  throw new Error('saída do modelo não é numérica');
}

/** Bits de um float16 (IEEE 754 meia precisão) para número. */
export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
