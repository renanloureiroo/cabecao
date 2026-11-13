// Quantização dos vetores para `int8` com escala por vetor (doc 03, "Segmento de embeddings"; decisão 10).
// A escala é o maior valor absoluto do vetor dividido por 127, arredondada para float32 (o tamanho do campo no
// segmento). Cada componente vira `round(x / escala)`, com arredondamento simétrico (meio para longe do zero), em
// [-127, 127]: o -128 nunca é produzido, então negar um vetor quantizado dá o vetor quantizado do negado.
// Só usa aritmética IEEE 754 de precisão dupla e `Math.fround`, que são exatas e iguais em toda máquina: o mesmo
// `Float32Array` dá os mesmos bytes no x86 e no ARM, em qualquer versão do Node.

/** Maior módulo de um componente quantizado. */
export const INT8_MAX = 127;

/** Vetor quantizado: `vector[i] · scale` reconstrói o componente `i`. */
export interface QuantizedVector {
  /** Fator de reconstrução, representável em float32. Zero só para o vetor nulo. */
  readonly scale: number;
  readonly vector: Int8Array;
}

/** Registro de embedding como o `indexstore/` guarda e devolve. */
export interface VectorRecord extends QuantizedVector {
  /** Chave do trecho: 16 bytes do SHA-256 do texto embutido, em hexadecimal minúsculo (32 caracteres). */
  readonly key: string;
}

const KEY_RE = /^[0-9a-f]{32}$/;

/** Chave de trecho válida: 32 dígitos hexadecimais minúsculos (como `computeChunkKey` produz). */
export function isVectorKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** Dimensão aceitável: inteiro positivo. */
export function assertDims(dims: number): void {
  if (!Number.isSafeInteger(dims) || dims <= 0) {
    throw new RangeError(`dimensão inválida: ${dims} (esperado um inteiro positivo)`);
  }
}

/** Recusa vetor vazio, de dimensão diferente da esperada ou com NaN/Infinity. */
export function assertFiniteVector(values: ArrayLike<number>, dims?: number, what = 'vetor'): void {
  if (values.length === 0) throw new RangeError(`${what} vazio`);
  if (dims !== undefined && values.length !== dims) {
    throw new RangeError(`${what} com ${values.length} dimensões; esperado ${dims}`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new RangeError(`${what} com valor não finito na posição ${i}`);
  }
}

/**
 * Quantiza um vetor para `int8` com escala por vetor. Determinística. O vetor não precisa estar normalizado (o
 * cosseno ignora a escala). O vetor nulo vira escala 0 e componentes 0, que `dequantize` devolve como nulo.
 *
 * @throws RangeError se o vetor estiver vazio, tiver NaN/Infinity ou não tiver `dims` dimensões (quando informado).
 */
export function quantizeInt8(values: Float32Array, dims?: number): QuantizedVector {
  assertFiniteVector(values, dims);
  let maxAbs = 0;
  for (let i = 0; i < values.length; i++) {
    const abs = Math.abs(values[i] as number);
    if (abs > maxAbs) maxAbs = abs;
  }
  const vector = new Int8Array(values.length);
  if (maxAbs === 0) return { scale: 0, vector };
  // Valores minúsculos (subnormais) dariam escala 0 em float32: usa a menor escala positiva do float32, 2^-149.
  const scale = Math.fround(maxAbs / INT8_MAX) || 2 ** -149;
  for (let i = 0; i < values.length; i++) {
    const x = (values[i] as number) / scale;
    const q = x < 0 ? -Math.round(-x) : Math.round(x);
    vector[i] = Math.min(INT8_MAX, Math.max(-INT8_MAX, q));
  }
  return { scale, vector };
}

/** Reconstrói o vetor em float32: `vector[i] · scale`. */
export function dequantize(quantized: QuantizedVector): Float32Array {
  const { scale, vector } = quantized;
  if (!Number.isFinite(scale) || scale < 0) throw new RangeError(`escala inválida: ${scale}`);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) * scale;
  return out;
}

/** Cosseno entre dois vetores de mesma dimensão; 0 quando um deles é nulo. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError(`dimensões diferentes: ${a.length} e ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
