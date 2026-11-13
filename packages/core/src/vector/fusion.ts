// Fusão convexa com cobertura, a mesma fórmula medida na prova de conceito dos modelos de embeddings:
//
//   score = α · minmax(cosseno) + (1 − α) · min(1, bm25 / Σ idf dos termos da pergunta)      α = 0,5
//
// - minmax(cosseno) é calculado sobre os candidatos do vetor (o top-30 da busca vetorial).
// - A cobertura diz quanto da pergunta, ponderada pela raridade dos termos, o trecho cobre: uma palavra solta em comum
//   dá ~0,2; um identificador exato dá ~0,9–1,0. Ela NÃO passa por min-max: é isso que impede um trecho que casa por
//   uma palavra solta de ganhar só por estar no topo da lista da palavra-chave (o defeito do RRF, que só olha posição).
// - Um candidato que só aparece numa das listas recebe 0 no componente da outra.
//
// Tudo é feito por trecho; `aggregateByNote` fica com o melhor trecho de cada nota, como a busca atual.

/** Peso do vetor na fusão (doc 06). Entre 0,4 e 0,6 a variação medida foi ≤ 0,02 em todos os conjuntos. */
export const DEFAULT_FUSION_ALPHA = 0.5;
/** Quantos candidatos de cada lista entram na fusão (top-30 de cada uma, como na medição). */
export const DEFAULT_FUSION_DEPTH = 30;

/** Candidato da busca por palavra-chave: um trecho, com o BM25 cru. */
export interface KeywordCandidate {
  /** Identificador do trecho, o mesmo usado em `VectorCandidate.chunkId` (ex.: `chunks.id` do banco, em texto). */
  readonly chunkId: string;
  readonly noteId: string;
  /** BM25 cru, com o sinal trocado (maior é melhor): `-bm25(chunks_fts, ...)`. Sem rebaixamento por validade. */
  readonly bm25: number;
}

/** Candidato da busca por significado: um trecho, com o cosseno contra a pergunta. */
export interface VectorCandidate {
  readonly chunkId: string;
  readonly noteId: string;
  readonly cosine: number;
}

export interface FusionInput {
  /** Trechos da palavra-chave. Ausente ou vazio: só vetor. */
  readonly keyword?: readonly KeywordCandidate[];
  /**
   * Soma dos idf (fórmula do FTS5) dos termos da pergunta, sobre a tabela inteira. Obrigatória quando há
   * candidatos de palavra-chave.
   */
  readonly idfSum?: number;
  /** Trechos do vetor. Ausente ou vazio: só palavra-chave (embeddings desligados ou nenhum trecho com vetor). */
  readonly vector?: readonly VectorCandidate[];
}

export interface FusionOptions {
  /** Peso do vetor, em [0, 1]. Padrão 0,5. */
  readonly alpha?: number;
  /** Candidatos de cada lista que entram na fusão (os melhores de cada uma). Padrão 30. */
  readonly depth?: number;
  /**
   * Fator multiplicado na pontuação final de cada nota (ex.: 0,5 para resultado vencido; doc 06, "Validade no
   * tempo"). Aplicado antes da ordenação. Padrão: 1.
   */
  readonly noteFactor?: (noteId: string) => number;
}

/** Quais listas contribuíram. */
export type FusionMode = 'hybrid' | 'keyword' | 'vector' | 'empty';

/** Um trecho depois da fusão, com os componentes expostos para depuração e para o `eval`. */
export interface FusedChunk {
  readonly chunkId: string;
  readonly noteId: string;
  /** Pontuação final: `(α · vector + (1 − α) · coverage) · factor`. */
  readonly score: number;
  /** minmax(cosseno) sobre os candidatos do vetor, em [0, 1]; 0 se o trecho não veio do vetor. */
  readonly vector: number;
  /** Cosseno cru, ou `null` se o trecho não veio do vetor. */
  readonly cosine: number | null;
  /** min(1, bm25 / Σidf), em [0, 1]; 0 se o trecho não veio da palavra-chave. */
  readonly coverage: number;
  /** BM25 cru, ou `null` se o trecho não veio da palavra-chave. */
  readonly bm25: number | null;
  /** Fator de `noteFactor` (1 sem ele). */
  readonly factor: number;
}

/** Uma nota: o melhor trecho dela, mais quantos trechos dela estavam entre os candidatos. */
export interface FusedNote extends FusedChunk {
  readonly matchedChunks: number;
}

export interface FusionResult {
  readonly mode: FusionMode;
  readonly alpha: number;
  /** Todos os trechos fundidos, do melhor para o pior. */
  readonly chunks: readonly FusedChunk[];
  /** Um resultado por nota (o melhor trecho), do melhor para o pior. */
  readonly notes: readonly FusedNote[];
}

function checkAlpha(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new RangeError(`α inválido: ${alpha} (use 0 a 1)`);
  return alpha;
}

function checkDepth(depth: number): number {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new RangeError(`profundidade inválida: ${depth}`);
  return depth;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ordem total e determinística: pontuação; depois BM25 cru (desfaz empates de cobertura saturada em 1 e reproduz a
 * ordem da busca atual quando só há palavra-chave); depois cosseno cru; depois `chunkId`.
 */
export function compareFused(a: FusedChunk, b: FusedChunk): number {
  return (
    b.score - a.score ||
    (b.bm25 ?? Number.NEGATIVE_INFINITY) - (a.bm25 ?? Number.NEGATIVE_INFINITY) ||
    (b.cosine ?? Number.NEGATIVE_INFINITY) - (a.cosine ?? Number.NEGATIVE_INFINITY) ||
    byText(a.chunkId, b.chunkId)
  );
}

/** Os `depth` melhores de uma lista, sem repetir trecho (fica a melhor ocorrência). */
function topUnique<T extends { readonly chunkId: string; readonly noteId: string }>(
  list: readonly T[],
  value: (item: T) => number,
  what: string,
  depth: number,
): T[] {
  const best = new Map<string, T>();
  for (const item of list) {
    const v = value(item);
    if (!Number.isFinite(v)) throw new RangeError(`${what} não finito no trecho ${item.chunkId}`);
    const seen = best.get(item.chunkId);
    if (seen !== undefined && seen.noteId !== item.noteId) {
      throw new RangeError(`trecho ${item.chunkId} atribuído às notas ${seen.noteId} e ${item.noteId}`);
    }
    if (seen === undefined || v > value(seen)) best.set(item.chunkId, item);
  }
  return [...best.values()].sort((a, b) => value(b) - value(a) || byText(a.chunkId, b.chunkId)).slice(0, depth);
}

/**
 * Funde as duas listas de trechos. Casos:
 * - só palavra-chave: `score = (1 − α) · cobertura`, ordem igual à do BM25 cru;
 * - só vetor: `score = α · minmax(cosseno)`, ordem igual à do cosseno;
 * - um candidato só no vetor (ou todos com o mesmo cosseno): min-max degenerado; todos recebem 1, já que são o
 *   melhor da lista (a prova de conceito dava 0, o que tirava o voto do vetor justamente quando ele tem um só);
 * - listas vazias: resultado vazio, modo `empty`.
 *
 * @throws RangeError com α fora de [0, 1], profundidade inválida, BM25/cosseno não finitos, Σidf ausente ou não
 *   positivo quando há candidatos de palavra-chave, ou um mesmo trecho atribuído a duas notas.
 */
export function fuse(input: FusionInput, options: FusionOptions = {}): FusionResult {
  const alpha = checkAlpha(options.alpha ?? DEFAULT_FUSION_ALPHA);
  const depth = checkDepth(options.depth ?? DEFAULT_FUSION_DEPTH);
  const keyword = topUnique(input.keyword ?? [], (c) => c.bm25, 'BM25', depth);
  const vector = topUnique(input.vector ?? [], (c) => c.cosine, 'cosseno', depth);

  let idfSum = 0;
  if (keyword.length > 0) {
    idfSum = input.idfSum ?? Number.NaN;
    if (!Number.isFinite(idfSum) || idfSum <= 0) {
      throw new RangeError(`Σidf inválido: ${input.idfSum} (precisa ser positivo quando há candidatos)`);
    }
  }

  interface Acc {
    noteId: string;
    cosine: number | null;
    vector: number;
    bm25: number | null;
    coverage: number;
  }
  const acc = new Map<string, Acc>();

  const first = vector[0];
  const last = vector[vector.length - 1];
  if (first !== undefined && last !== undefined) {
    const max = first.cosine;
    const range = max - last.cosine;
    for (const c of vector) {
      acc.set(c.chunkId, {
        noteId: c.noteId,
        cosine: c.cosine,
        vector: range > 0 ? (c.cosine - last.cosine) / range : 1,
        bm25: null,
        coverage: 0,
      });
    }
  }
  for (const c of keyword) {
    const coverage = Math.min(1, Math.max(0, c.bm25 / idfSum));
    const seen = acc.get(c.chunkId);
    if (seen === undefined) {
      acc.set(c.chunkId, { noteId: c.noteId, cosine: null, vector: 0, bm25: c.bm25, coverage });
    } else {
      if (seen.noteId !== c.noteId) {
        throw new RangeError(`trecho ${c.chunkId} atribuído às notas ${seen.noteId} e ${c.noteId}`);
      }
      seen.bm25 = c.bm25;
      seen.coverage = coverage;
    }
  }

  const factors = new Map<string, number>();
  const factorOf = (noteId: string): number => {
    if (options.noteFactor === undefined) return 1;
    let factor = factors.get(noteId);
    if (factor === undefined) {
      factor = options.noteFactor(noteId);
      if (!Number.isFinite(factor) || factor < 0) throw new RangeError(`fator inválido para ${noteId}: ${factor}`);
      factors.set(noteId, factor);
    }
    return factor;
  };

  const chunks: FusedChunk[] = [];
  for (const [chunkId, a] of acc) {
    const factor = factorOf(a.noteId);
    chunks.push({
      chunkId,
      noteId: a.noteId,
      score: (alpha * a.vector + (1 - alpha) * a.coverage) * factor,
      vector: a.vector,
      cosine: a.cosine,
      coverage: a.coverage,
      bm25: a.bm25,
      factor,
    });
  }
  chunks.sort(compareFused);

  const mode: FusionMode =
    keyword.length > 0 && vector.length > 0
      ? 'hybrid'
      : keyword.length > 0
        ? 'keyword'
        : vector.length > 0
          ? 'vector'
          : 'empty';
  return { mode, alpha, chunks, notes: aggregateByNote(chunks) };
}

/** Um resultado por nota: o melhor trecho dela (pela ordem de `compareFused`), mais a contagem de trechos. */
export function aggregateByNote(chunks: readonly FusedChunk[]): FusedNote[] {
  const best = new Map<string, FusedChunk>();
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    counts.set(chunk.noteId, (counts.get(chunk.noteId) ?? 0) + 1);
    const seen = best.get(chunk.noteId);
    if (seen === undefined || compareFused(chunk, seen) < 0) best.set(chunk.noteId, chunk);
  }
  return [...best.values()]
    .sort(compareFused)
    .map((chunk) => ({ ...chunk, matchedChunks: counts.get(chunk.noteId) ?? 1 }));
}
