// Armazém de vetores em memória com busca por força bruta (doc 06, "Significado"; decisão 07).
// Todos os vetores ficam num único `Int8Array` contíguo (dims bytes por vetor), com um `Float32Array` de escalas e
// outro com o inverso da norma de cada vetor quantizado. O cosseno é `q̂ · v / |v|`: a escala se cancela, então a
// busca nem a lê (ela só serve para reconstruir o vetor em `get`).
//
// A pergunta fica em float32 (normalizada) e os vetores em int8. Medido nesta máquina (Apple M3 Pro, Node 24, 100 mil
// vetores): pergunta float32 e pergunta quantizada para int8 empatam dentro do ruído (384d: 17–25 ms contra 17–25 ms;
// 768d: 42–50 ms contra 47–50 ms, com o laço desenrolado por 4). Como não há ganho de velocidade, a pergunta não é
// quantizada: o lado da pergunta não perde precisão.

import type { VectorRecord } from './quantize.ts';
import { assertDims, assertFiniteVector, isVectorKey } from './quantize.ts';

export interface VectorStoreOptions {
  /** Dimensão de todos os vetores (a do modelo escolhido). */
  readonly dims: number;
  /** Capacidade inicial, em vetores. Cresce sozinha (dobrando) quando faltar espaço. */
  readonly capacity?: number;
}

export interface VectorSearchOptions {
  /**
   * Aceita ou recusa um vetor pela chave (escopo, tipo, nota arquivada...). Só é chamado para os vetores que
   * entrariam no top-k, nunca para todos: um filtro caro não multiplica o custo da busca.
   */
  readonly filter?: (key: string) => boolean;
}

export interface VectorHit {
  readonly key: string;
  /** Cosseno entre a pergunta (float32) e o vetor guardado (int8), em [-1, 1]. Vetor nulo guardado dá 0. */
  readonly cosine: number;
}

const MIN_CAPACITY = 16;
/** Bytes por vetor além dos `dims` do próprio vetor: escala (float32) e inverso da norma (float32). */
export const VECTOR_OVERHEAD_BYTES = 8;

/** Passo de cada vetor no array: `dims` arredondado para cima até múltiplo de 4, com zeros no fim. */
function strideOf(dims: number): number {
  return dims + ((4 - (dims % 4)) % 4);
}

export class VectorStore {
  readonly dims: number;
  /** Bytes ocupados por vetor no array contíguo (`dims` alinhado a 4). */
  readonly stride: number;
  #capacity: number;
  #size = 0;
  #vectors: Int8Array;
  #scales: Float32Array;
  #invNorms: Float32Array;
  #keys: string[] = [];
  readonly #positions = new Map<string, number>();

  /**
   * Cria o armazém e carrega os registros. Uma chave repetida substitui o vetor anterior (a chave é o hash do
   * texto embutido: duas máquinas que embutiram o mesmo texto produzem a mesma chave).
   */
  constructor(options: VectorStoreOptions, records: Iterable<VectorRecord> = []) {
    assertDims(options.dims);
    this.dims = options.dims;
    this.stride = strideOf(options.dims);
    const hint = Array.isArray(records) ? records.length : 0;
    const requested = options.capacity ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 0) throw new RangeError(`capacidade inválida: ${requested}`);
    this.#capacity = Math.max(MIN_CAPACITY, requested, hint);
    this.#vectors = new Int8Array(this.#capacity * this.stride);
    this.#scales = new Float32Array(this.#capacity);
    this.#invNorms = new Float32Array(this.#capacity);
    for (const record of records) this.add(record);
  }

  /** Quantos vetores estão guardados. */
  get size(): number {
    return this.#size;
  }

  /** Quantos vetores cabem sem realocar. */
  get capacity(): number {
    return this.#capacity;
  }

  /**
   * Bytes alocados nos arrays de vetores, escalas e normas: `capacity · (stride + 8)`, com `stride` = `dims`
   * alinhado a 4 (384 e 768 não mudam). As chaves (strings de 32
   * caracteres no array e no mapa chave → posição) ficam fora desta conta; o V8 gasta perto de 100 bytes por chave.
   */
  get byteLength(): number {
    return this.#vectors.byteLength + this.#scales.byteLength + this.#invNorms.byteLength;
  }

  has(key: string): boolean {
    return this.#positions.has(key);
  }

  /** Cópia do registro guardado, ou `undefined`. */
  get(key: string): VectorRecord | undefined {
    const pos = this.#positions.get(key);
    if (pos === undefined) return undefined;
    const start = pos * this.stride;
    return { key, scale: this.#scales[pos] as number, vector: this.#vectors.slice(start, start + this.dims) };
  }

  /** Chaves guardadas, em ordem de posição interna (que muda com `remove`). */
  keys(): IterableIterator<string> {
    return this.#keys.slice(0, this.#size)[Symbol.iterator]();
  }

  /**
   * Guarda um registro. Devolve `true` se a chave era nova e `false` se substituiu um vetor existente.
   *
   * @throws RangeError se a chave não tiver 32 dígitos hexadecimais minúsculos, a dimensão for diferente da do
   *   armazém ou a escala não for um número finito não negativo.
   */
  add(record: VectorRecord): boolean {
    const { key, scale, vector } = record;
    if (!isVectorKey(key)) throw new RangeError(`chave de vetor inválida: ${JSON.stringify(key)}`);
    if (!(vector instanceof Int8Array)) throw new TypeError('o vetor guardado precisa ser um Int8Array');
    if (vector.length !== this.dims) {
      throw new RangeError(`vetor de ${key} com ${vector.length} dimensões; esperado ${this.dims}`);
    }
    if (!Number.isFinite(scale) || scale < 0) throw new RangeError(`escala inválida em ${key}: ${scale}`);

    let pos = this.#positions.get(key);
    const isNew = pos === undefined;
    if (pos === undefined) {
      if (this.#size === this.#capacity) this.#grow();
      pos = this.#size++;
      this.#positions.set(key, pos);
      this.#keys[pos] = key;
    }
    this.#vectors.set(vector, pos * this.stride);
    this.#scales[pos] = scale;
    let squares = 0;
    for (let j = 0; j < vector.length; j++) {
      const v = vector[j] as number;
      squares += v * v;
    }
    this.#invNorms[pos] = squares === 0 ? 0 : 1 / Math.sqrt(squares);
    return isNew;
  }

  /** Tira um vetor. O último vetor ocupa o lugar dele, então o array continua contíguo. */
  remove(key: string): boolean {
    const pos = this.#positions.get(key);
    if (pos === undefined) return false;
    const last = this.#size - 1;
    if (pos !== last) {
      const lastKey = this.#keys[last] as string;
      this.#vectors.copyWithin(pos * this.stride, last * this.stride, (last + 1) * this.stride);
      this.#scales[pos] = this.#scales[last] as number;
      this.#invNorms[pos] = this.#invNorms[last] as number;
      this.#keys[pos] = lastKey;
      this.#positions.set(lastKey, pos);
    }
    this.#keys.length = last;
    this.#positions.delete(key);
    this.#size = last;
    return true;
  }

  /**
   * Os `k` vetores de maior cosseno com a pergunta, do maior para o menor. Empates são desfeitos pela chave (menor
   * primeiro), então o resultado não depende da ordem em que os vetores entraram. Não aloca nada por vetor.
   *
   * @throws RangeError se a pergunta tiver outra dimensão, NaN/Infinity ou for nula, ou se `k` não for um inteiro
   *   não negativo.
   */
  search(query: Float32Array, k: number, options: VectorSearchOptions = {}): VectorHit[] {
    assertFiniteVector(query, this.dims, 'pergunta');
    if (!Number.isSafeInteger(k) || k < 0) throw new RangeError(`k inválido: ${k}`);
    let squares = 0;
    for (let j = 0; j < query.length; j++) squares += (query[j] as number) ** 2;
    if (squares === 0) throw new RangeError('pergunta com vetor nulo');
    const limit = Math.min(k, this.#size);
    if (limit === 0) return [];

    const inv = 1 / Math.sqrt(squares);
    const q = new Float32Array(this.stride); // o preenchimento fica em zero, como nos vetores
    for (let j = 0; j < this.dims; j++) q[j] = (query[j] as number) * inv;

    const heap = new TopK(limit, this.#keys);
    scan(this.#vectors, this.#invNorms, this.#size, this.stride, q, heap, options.filter);
    return heap.drain();
  }

  #grow(): void {
    const capacity = this.#capacity * 2;
    const vectors = new Int8Array(capacity * this.stride);
    vectors.set(this.#vectors);
    const scales = new Float32Array(capacity);
    scales.set(this.#scales);
    const invNorms = new Float32Array(capacity);
    invNorms.set(this.#invNorms);
    this.#vectors = vectors;
    this.#scales = scales;
    this.#invNorms = invNorms;
    this.#capacity = capacity;
  }
}

/**
 * Laço quente, fora da classe para o V8 vê-lo sempre com os mesmos tipos. Produto interno desenrolado por 4 (quatro
 * acumuladores independentes). O passo é múltiplo de 4, então não há laço de resto: medido, ele custava ~30%.
 */
function scan(
  vectors: Int8Array,
  invNorms: Float32Array,
  size: number,
  stride: number,
  q: Float32Array,
  heap: TopK,
  filter: ((key: string) => boolean) | undefined,
): void {
  let floor = Number.NEGATIVE_INFINITY;
  for (let i = 0, o = 0; i < size; i++, o += stride) {
    let a0 = 0;
    let a1 = 0;
    let a2 = 0;
    let a3 = 0;
    for (let j = 0; j < stride; j += 4) {
      a0 += (vectors[o + j] as number) * (q[j] as number);
      a1 += (vectors[o + j + 1] as number) * (q[j + 1] as number);
      a2 += (vectors[o + j + 2] as number) * (q[j + 2] as number);
      a3 += (vectors[o + j + 3] as number) * (q[j + 3] as number);
    }
    const score = (a0 + a1 + a2 + a3) * (invNorms[i] as number);
    // `floor` é a pior pontuação guardada (-Infinity até o heap encher): o caso comum sai com uma comparação só
    if (score < floor) continue;
    if (heap.accepts(score, i) && (filter === undefined || filter(heap.keyAt(i)))) floor = heap.push(score, i);
  }
}

/**
 * Top-k por heap de mínimo de tamanho fixo: a raiz é o pior dos guardados. "Pior" é o cosseno menor; no empate, a
 * chave maior. Dois arrays tipados pré-alocados, nenhuma alocação durante a varredura.
 */
class TopK {
  readonly #k: number;
  readonly #keys: readonly string[];
  readonly #scores: Float64Array;
  readonly #positions: Int32Array;
  #count = 0;

  constructor(k: number, keys: readonly string[]) {
    this.#k = k;
    this.#keys = keys;
    this.#scores = new Float64Array(k);
    this.#positions = new Int32Array(k);
  }

  keyAt(position: number): string {
    return this.#keys[position] as string;
  }

  /** `a` (pontuação, posição) é pior que `b`. */
  #worse(sa: number, pa: number, sb: number, pb: number): boolean {
    return sa < sb || (sa === sb && (this.#keys[pa] as string) > (this.#keys[pb] as string));
  }

  /** O candidato entraria no heap. */
  accepts(score: number, position: number): boolean {
    if (this.#count < this.#k) return true;
    const root = this.#scores[0] as number;
    return score > root || (score === root && this.#worse(root, this.#positions[0] as number, score, position));
  }

  /** Guarda o candidato e devolve a nova pior pontuação guardada (-Infinity enquanto o heap não encheu). */
  push(score: number, position: number): number {
    const scores = this.#scores;
    const positions = this.#positions;
    if (this.#count < this.#k) {
      // sobe a partir da folha
      let i = this.#count++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!this.#worse(score, position, scores[parent] as number, positions[parent] as number)) break;
        scores[i] = scores[parent] as number;
        positions[i] = positions[parent] as number;
        i = parent;
      }
      scores[i] = score;
      positions[i] = position;
      return this.#count < this.#k ? Number.NEGATIVE_INFINITY : (scores[0] as number);
    }
    // substitui a raiz e desce
    const n = this.#count;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      let child = left;
      if (
        right < n &&
        this.#worse(
          scores[right] as number,
          positions[right] as number,
          scores[left] as number,
          positions[left] as number,
        )
      ) {
        child = right;
      }
      if (!this.#worse(scores[child] as number, positions[child] as number, score, position)) break;
      scores[i] = scores[child] as number;
      positions[i] = positions[child] as number;
      i = child;
    }
    scores[i] = score;
    positions[i] = position;
    return scores[0] as number;
  }

  /** Esvazia em ordem: maior cosseno primeiro, chave menor no empate. */
  drain(): VectorHit[] {
    const out: { key: string; cosine: number }[] = [];
    for (let i = 0; i < this.#count; i++) {
      const cosine = this.#scores[i] as number;
      out.push({
        key: this.#keys[this.#positions[i] as number] as string,
        cosine: Math.min(1, Math.max(-1, cosine)),
      });
    }
    out.sort((a, b) => b.cosine - a.cosine || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }
}
