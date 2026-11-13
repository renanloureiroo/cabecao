import type { Embedder } from './embedder.ts';
import { EmbeddingsError } from './errors.ts';
import { l2Normalize } from './inference.ts';
import type { EmbedInput } from './prompt.ts';

/**
 * Embedder determinístico, sem modelo e sem rede, para testes de outros módulos e da CLI.
 *
 * Cada palavra (minúsculas, sem acento) vai para uma dimensão escolhida por hash, com sinal também por hash; o vetor
 * é normalizado. Por isso textos com palavras em comum ficam mais próximos, e o mesmo texto dá sempre o mesmo vetor,
 * em qualquer máquina. Texto sem palavras recebe o vetor do hash do texto inteiro. O título entra como palavras, e o
 * tipo (`query`/`passage`) não muda o vetor: uma pergunta igual a um trecho dá cosseno 1.
 */
export function createFakeEmbedder(dims: number, options: { model?: string } = {}): Embedder {
  if (!Number.isInteger(dims) || dims < 1) throw new RangeError('dims deve ser um inteiro positivo');
  let disposed = false;
  return {
    model: options.model ?? `fake-${dims}`,
    dims,
    backend: 'fake',
    async embed(texts) {
      if (disposed) throw new EmbeddingsError('EMBEDDINGS_DISPOSED', 'o embedder já foi liberado');
      return texts.map((input) => fakeVector(input, dims));
    },
    async dispose() {
      disposed = true;
    },
  };
}

function fakeVector(input: EmbedInput, dims: number): Float32Array {
  const text = typeof input === 'string' ? input : `${input.title ?? ''} ${input.text}`;
  const words =
    text
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = new Float32Array(dims);
  for (const word of words.length > 0 ? words : [`\u0000${text}`]) {
    const h = fnv1a(word);
    const index = h % dims;
    vector[index] = (vector[index] ?? 0) + (fnv1a(`±${word}`) & 1 ? 1 : -1);
  }
  // Palavras que se cancelam deixariam o vetor nulo; aí vale o hash do texto inteiro.
  if (vector.every((value) => value === 0)) vector[fnv1a(text) % dims] = 1;
  return l2Normalize(vector);
}

/** FNV-1a de 32 bits sobre os bytes UTF-8. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
