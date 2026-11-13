// Busca híbrida (doc 06, "Busca híbrida"): candidatos da palavra-chave (trechos, BM25 cru) e do vetor (trechos,
// cosseno), fusão convexa com cobertura (α 0,5) e um resultado por nota. A validade na data da consulta entra como
// fator da nota (vencido e ainda não vigente valem metade), igual ao rebaixamento da busca só por palavra-chave.
// Funções síncronas: rodam dentro de `withFreshIndex`, com o banco só para elas.
import type { IndexedNote, KeywordChunkCandidate, KeywordHit, LocalIndex } from '../db/index.ts';
import {
  chunkDetails,
  chunkKeysMatching,
  chunksForKeys,
  DEFAULT_CANDIDATE_DEPTH,
  EXPIRED_SCORE_FACTOR,
  getNote,
  isStaleMemory,
  keywordCandidates,
  queryTerms,
  STALE_SCORE_FACTOR,
  validityOf,
} from '../db/index.ts';
import { estimateTokens, HEADING_PATH_SEPARATOR } from '../markdown/index.ts';
import type { FusionInput, VectorCandidate, VectorStore } from '../vector/index.ts';
import { DEFAULT_FUSION_ALPHA, fuse } from '../vector/index.ts';

/** Modos da busca (`search`): `auto` decide pela configuração e pelo runtime desta máquina. */
export const SEARCH_MODES = ['auto', 'keyword', 'semantic', 'hybrid'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
/** O modo de fato usado. */
export type SearchModeUsed = Exclude<SearchMode, 'auto'>;

/** Caracteres do trecho mostrado quando o trecho veio só do vetor (sem marcação de termos). */
const EXCERPT_CHARS = 200;

export interface CandidateFilters {
  readonly scope?: readonly string[];
  readonly types?: readonly string[];
}

/** Candidatos de uma pergunta para a fusão, mais o que a resposta mostra de cada trecho da palavra-chave. */
export interface SearchCandidates {
  readonly input: FusionInput;
  readonly keyword: readonly KeywordChunkCandidate[];
  readonly mode: 'and' | 'or' | 'none';
  readonly terms: readonly string[];
}

/**
 * Candidatos da palavra-chave e do vetor para uma pergunta. Sem `vector` (ou sem armazém), só palavra-chave; sem
 * `keyword: false`, os dois. Um trecho sem vetor concorre só pela palavra-chave.
 */
export function searchCandidates(
  index: LocalIndex,
  options: {
    readonly query: string;
    readonly filters: CandidateFilters;
    readonly store?: VectorStore | null;
    readonly vector?: Float32Array | null;
    readonly keyword?: boolean;
    readonly depth?: number;
    readonly titleWeight?: number;
  },
): SearchCandidates {
  const depth = options.depth ?? DEFAULT_CANDIDATE_DEPTH;
  const filters = {
    ...(options.filters.scope === undefined ? {} : { scope: options.filters.scope }),
    ...(options.filters.types === undefined ? {} : { types: options.filters.types }),
  };
  const kw =
    options.keyword === false
      ? null
      : keywordCandidates(index, {
          query: options.query,
          depth,
          ...filters,
          ...(options.titleWeight === undefined ? {} : { titleWeight: options.titleWeight }),
        });
  let vector: VectorCandidate[] = [];
  if (options.store && options.vector && options.store.size > 0) {
    const allowed = chunkKeysMatching(index, filters);
    const hits = options.store.search(options.vector, depth, { filter: (key) => allowed.has(key) });
    const cosines = new Map(hits.map((hit) => [hit.key, hit.cosine]));
    vector = chunksForKeys(
      index,
      hits.map((hit) => hit.key),
      filters,
    ).map((ref) => ({ chunkId: ref.chunkId, noteId: ref.noteId, cosine: cosines.get(ref.chunkKey) ?? 0 }));
  }
  const keyword = kw?.candidates ?? [];
  return {
    input: {
      ...(keyword.length === 0 ? {} : { keyword, idfSum: kw?.idfSum ?? 0 }),
      ...(vector.length === 0 ? {} : { vector }),
    },
    keyword,
    mode: kw?.mode ?? 'none',
    terms: kw?.terms ?? queryTerms(options.query).map((term) => `${term.text}${term.prefix ? '*' : ''}`),
  };
}

/**
 * Fator de validade de uma nota na data: 1 vigente, 0,5 vencida ou ainda não vigente; vezes 0,8 numa memória velha
 * nunca confirmada (`isStaleMemory`).
 */
export function validityFactor(index: LocalIndex, asOf: string): (noteId: string) => number {
  const cache = new Map<string, number>();
  return (noteId) => {
    let factor = cache.get(noteId);
    if (factor === undefined) {
      const note = getNote(index, { id: noteId });
      factor = note === null || validityOf(note, asOf) === 'current' ? 1 : EXPIRED_SCORE_FACTOR;
      if (note !== null && isStaleMemory(note, asOf)) factor *= STALE_SCORE_FACTOR;
      cache.set(noteId, factor);
    }
    return factor;
  };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const cut = flat.lastIndexOf(' ', EXCERPT_CHARS);
  return `${flat.slice(0, cut > EXCERPT_CHARS / 2 ? cut : EXCERPT_CHARS).trimEnd()}…`;
}

function hitTokens(hit: KeywordHit): number {
  return (
    estimateTokens(
      [
        hit.noteId,
        hit.path,
        hit.title ?? '',
        hit.type ?? '',
        hit.scope ?? '',
        hit.headingPath.join(HEADING_PATH_SEPARATOR),
        hit.snippet,
      ].join(' '),
    ) + 24
  );
}

export interface FusedSearchResult {
  readonly hits: readonly KeywordHit[];
  readonly mode: 'and' | 'or' | 'none';
  readonly terms: readonly string[];
  readonly truncated: boolean;
}

/**
 * Busca híbrida (ou só vetor, com `semanticOnly`): um resultado por nota, do melhor para o pior, com a pontuação da
 * fusão (0 a 1, já com o fator de validade), cortada por `limit` e pelo orçamento de tokens como a busca por
 * palavra-chave.
 */
export function fusedSearch(
  index: LocalIndex,
  options: {
    readonly query: string;
    readonly filters: CandidateFilters;
    readonly store: VectorStore;
    readonly vector: Float32Array;
    readonly asOf: string;
    readonly limit: number;
    readonly budgetTokens?: number;
    readonly semanticOnly?: boolean;
  },
): FusedSearchResult {
  const candidates = searchCandidates(index, {
    query: options.query,
    filters: options.filters,
    store: options.store,
    vector: options.vector,
    keyword: options.semanticOnly !== true,
  });
  const fused = fuse(candidates.input, {
    alpha: DEFAULT_FUSION_ALPHA,
    noteFactor: validityFactor(index, options.asOf),
  });
  const snippets = new Map(candidates.keyword.map((c) => [c.chunkId, c.snippet]));
  const top = fused.notes.slice(0, options.limit * 2);
  const details = chunkDetails(
    index,
    top.map((note) => note.chunkId),
  );
  const notes = new Map<string, IndexedNote>();
  const hits: KeywordHit[] = [];
  let truncated = false;
  let spent = 0;
  for (const item of top) {
    if (hits.length >= options.limit) break;
    let note = notes.get(item.noteId);
    if (note === undefined) {
      const found = getNote(index, { id: item.noteId });
      if (found === null) continue;
      note = found;
      notes.set(item.noteId, note);
    }
    const detail = details.get(item.chunkId);
    const hit: KeywordHit = {
      noteId: note.id,
      path: note.path,
      title: note.title,
      type: note.type,
      scope: note.scope,
      headingPath: detail?.headingPath ?? [],
      snippet: snippets.get(item.chunkId) ?? excerpt(detail?.text ?? ''),
      score: Math.round(item.score * 10_000) / 10_000,
      trust: note.trust,
      origin: note.origin,
      validFrom: note.validFrom,
      validUntil: note.validUntil,
      expiresAt: note.expiresAt,
      validity: validityOf(note, options.asOf),
    };
    if (options.budgetTokens !== undefined) {
      const cost = hitTokens(hit);
      if (spent + cost > options.budgetTokens) {
        truncated = true;
        break;
      }
      spent += cost;
    }
    hits.push(hit);
  }
  return { hits, mode: candidates.mode, terms: candidates.terms, truncated };
}
