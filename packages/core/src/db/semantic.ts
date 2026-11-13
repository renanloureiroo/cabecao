// Apoio do banco à busca por significado (marco 2; doc 06, "Busca híbrida" e "Fusão"):
//
// - `keywordCandidates`: os melhores TRECHOS da palavra-chave (sem agrupar por nota), com o BM25 cru e a soma dos idf
//   dos termos da pergunta, que é o que a fusão convexa com cobertura (`vector/fusion.ts`) precisa;
// - `chunkKeysMatching` e `chunksForKeys`: a tradução entre a chave do trecho (`chunk_key`, a chave dos vetores) e os
//   trechos do banco, com os mesmos filtros da busca;
// - `embeddingInputs` e `allChunkKeys`: o que o serviço de embeddings calcula e o que a compactação mantém.
//
// O rebaixamento de resultado vencido NÃO é feito aqui: o BM25 sai cru e a validade entra na fusão, por `noteFactor`.
import { connection, type LocalIndex } from './open.ts';
import {
  BM25_TEXT_WEIGHT,
  BM25_TITLE_WEIGHT,
  buildFtsQuery,
  type NoteFilterOptions,
  noteFilters,
  type QueryTerm,
  queryTerms,
} from './search.ts';

/** Trechos de cada lista que entram na fusão (o top-30 da medição). */
export const DEFAULT_CANDIDATE_DEPTH = 30;
/** Piso do idf, o mesmo do FTS5: termo presente em mais da metade dos trechos não dá idf negativo. */
export const MIN_IDF = 1e-6;

export interface KeywordCandidatesOptions extends NoteFilterOptions {
  readonly query: string;
  /** Quantos trechos devolver. Padrão 30. */
  readonly depth?: number;
  /** Peso do título no BM25. Padrão: o da busca por palavra-chave (`BM25_TITLE_WEIGHT`). */
  readonly titleWeight?: number;
}

/** Um trecho candidato da palavra-chave. */
export interface KeywordChunkCandidate {
  /** `chunks.id`, em texto. */
  readonly chunkId: string;
  readonly noteId: string;
  readonly chunkKey: string;
  /** BM25 com o sinal trocado (maior é melhor), sem rebaixamento por validade. */
  readonly bm25: number;
  /** Trecho com os termos marcados entre `«` e `»`. */
  readonly snippet: string;
}

export interface KeywordCandidates {
  /** `and`: todos os termos; `or`: recuo para qualquer termo; `none`: pergunta vazia depois da limpeza. */
  readonly mode: 'and' | 'or' | 'none';
  readonly terms: readonly string[];
  /** Do melhor para o pior trecho. */
  readonly candidates: readonly KeywordChunkCandidate[];
  /** Σ idf dos termos da pergunta, sobre a tabela inteira (sem filtros). 0 com a pergunta vazia. */
  readonly idfSum: number;
}

/**
 * idf de cada termo pela fórmula do FTS5 (`ln((N − n + 0,5) / (n + 0,5))`, piso 1e-6), com `N` = trechos na tabela e
 * `n` = trechos que contêm o termo, contados sobre a tabela inteira, sem filtros: é a mesma conta que o `bm25()` faz.
 */
export function termIdfs(index: LocalIndex, terms: readonly QueryTerm[]): number[] {
  const db = connection(index);
  const total = Number(db.prepare('select count(*) as n from chunks').get()?.n ?? 0);
  const count = db.prepare('select count(*) as n from chunks_fts where chunks_fts match ?');
  return terms.map((term) => {
    const n = Number(count.get(buildFtsQuery([term], 'AND'))?.n ?? 0);
    return Math.max(MIN_IDF, Math.log((total - n + 0.5) / (n + 0.5)));
  });
}

/**
 * Os melhores trechos da busca por palavra-chave, um por linha (vários da mesma nota podem aparecer), com o BM25 cru
 * e o Σ idf da pergunta. Mesma limpeza da pergunta, mesmos filtros e o mesmo recuo de AND para OR de `searchKeyword`.
 */
export function keywordCandidates(index: LocalIndex, options: KeywordCandidatesOptions): KeywordCandidates {
  const terms = queryTerms(options.query);
  const termTexts = terms.map((term) => `${term.text}${term.prefix ? '*' : ''}`);
  if (terms.length === 0) return { mode: 'none', terms: [], candidates: [], idfSum: 0 };
  const depth = Math.max(1, Math.trunc(options.depth ?? DEFAULT_CANDIDATE_DEPTH));
  const titleWeight = options.titleWeight ?? BM25_TITLE_WEIGHT;
  if (!Number.isFinite(titleWeight) || titleWeight < 0) throw new RangeError(`peso do título inválido: ${titleWeight}`);
  const db = connection(index);
  const { filters, params } = noteFilters(options);
  const statement = db.prepare(`
    select c.id as chunkId, c.note_id as noteId, c.chunk_key as chunkKey,
      snippet(chunks_fts, 0, '«', '»', '…', 24) as snippet,
      bm25(chunks_fts, ${BM25_TEXT_WEIGHT}, ${Number(titleWeight)}) as rank
    from chunks_fts
      join chunks c on c.id = chunks_fts.rowid
      join notes n on n.id = c.note_id
    where chunks_fts match ?${filters.map((filter) => ` and ${filter}`).join('')}
    order by rank, c.id
    limit ?`);
  const run = (operator: 'AND' | 'OR'): KeywordChunkCandidate[] =>
    statement.all(buildFtsQuery(terms, operator), ...params, depth).map((row) => ({
      chunkId: String(row.chunkId),
      noteId: String(row.noteId),
      chunkKey: String(row.chunkKey),
      bm25: -Number(row.rank),
      snippet: String(row.snippet ?? ''),
    }));
  let mode: 'and' | 'or' = 'and';
  let candidates = run('AND');
  if (candidates.length === 0 && terms.length > 1) {
    mode = 'or';
    candidates = run('OR');
  }
  const idfSum = termIdfs(index, terms).reduce((sum, idf) => sum + idf, 0);
  return { mode, terms: termTexts, candidates, idfSum };
}

/**
 * Chaves de trecho (`chunk_key`) dos trechos que passam nos filtros: o filtro da busca vetorial (o armazém de vetores
 * só conhece chaves).
 */
export function chunkKeysMatching(index: LocalIndex, options: NoteFilterOptions = {}): Set<string> {
  const { filters, params } = noteFilters(options);
  const rows = connection(index)
    .prepare(
      `select distinct c.chunk_key as chunkKey from chunks c join notes n on n.id = c.note_id${
        filters.length === 0 ? '' : ` where ${filters.join(' and ')}`
      }`,
    )
    .all(...params);
  return new Set(rows.map((row) => String(row.chunkKey)));
}

/** Um trecho do banco com a sua chave. */
export interface ChunkRef {
  readonly chunkId: string;
  readonly noteId: string;
  readonly chunkKey: string;
}

const KEYS_PER_QUERY = 500;

/**
 * Os trechos (que passam nos filtros) de cada chave. Uma chave pode ter vários trechos: o mesmo texto, com o mesmo
 * título, em duas notas. Em ordem de `chunks.id`.
 */
export function chunksForKeys(index: LocalIndex, keys: readonly string[], options: NoteFilterOptions = {}): ChunkRef[] {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  const { filters, params } = noteFilters(options);
  const db = connection(index);
  const out: ChunkRef[] = [];
  for (let i = 0; i < unique.length; i += KEYS_PER_QUERY) {
    const slice = unique.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(
        `select c.id as chunkId, c.note_id as noteId, c.chunk_key as chunkKey
         from chunks c join notes n on n.id = c.note_id
         where c.chunk_key in (${slice.map(() => '?').join(', ')})${filters.map((filter) => ` and ${filter}`).join('')}
         order by c.id`,
      )
      .all(...slice, ...params);
    for (const row of rows) {
      out.push({ chunkId: String(row.chunkId), noteId: String(row.noteId), chunkKey: String(row.chunkKey) });
    }
  }
  return out.sort((a, b) => Number(a.chunkId) - Number(b.chunkId));
}

/** O que vai para o modelo de um trecho: o texto e o contexto `Título › Seção`. */
export interface EmbeddingInput {
  readonly key: string;
  readonly text: string;
  /** Prefixo de contexto (`title_path`); vazio quando a nota não tem título nem seção. */
  readonly title: string;
}

/**
 * Um texto por chave de trecho, para o cálculo dos embeddings: todas as notas, menos as cópias de conflito (o texto
 * delas é o de uma versão que o sync guardou ao lado; quando é igual ao de outra nota, a chave é a mesma). Em ordem de
 * chave, para o cálculo ser o mesmo em qualquer máquina.
 */
export function embeddingInputs(index: LocalIndex): EmbeddingInput[] {
  return connection(index)
    .prepare(
      `select c.chunk_key as key, min(c.id) as id, c.text as text, c.title_path as title
       from chunks c join notes n on n.id = c.note_id
       where n.conflict_of is null
       group by c.chunk_key
       order by c.chunk_key`,
    )
    .all()
    .map((row) => ({ key: String(row.key), text: String(row.text), title: String(row.title ?? '') }));
}

/** Só as chaves dos trechos que recebem embedding (as mesmas de `embeddingInputs`), sem carregar os textos. */
export function embeddingKeys(index: LocalIndex): string[] {
  return connection(index)
    .prepare(
      `select distinct c.chunk_key as key
       from chunks c join notes n on n.id = c.note_id
       where n.conflict_of is null`,
    )
    .all()
    .map((row) => String(row.key));
}

/** Todas as chaves de trecho do banco, de qualquer nota: o que a compactação do índice mantém. */
export function allChunkKeys(index: LocalIndex): Set<string> {
  const rows = connection(index).prepare('select distinct chunk_key as key from chunks').all();
  return new Set(rows.map((row) => String(row.key)));
}

/** Um trecho com o que a resposta da busca mostra. */
export interface ChunkDetail {
  readonly chunkId: string;
  readonly noteId: string;
  readonly headingPath: readonly string[];
  readonly text: string;
}

/** Texto e seção de trechos, pelo `chunks.id`. */
export function chunkDetails(index: LocalIndex, chunkIds: readonly string[]): Map<string, ChunkDetail> {
  const out = new Map<string, ChunkDetail>();
  const ids = [...new Set(chunkIds)].map(Number).filter(Number.isSafeInteger);
  const db = connection(index);
  for (let i = 0; i < ids.length; i += KEYS_PER_QUERY) {
    const slice = ids.slice(i, i + KEYS_PER_QUERY);
    const rows = db
      .prepare(
        `select id, note_id as noteId, heading_path as headingPath, text from chunks where id in (${slice
          .map(() => '?')
          .join(', ')})`,
      )
      .all(...slice);
    for (const row of rows) {
      let headingPath: string[] = [];
      try {
        const value: unknown = JSON.parse(String(row.headingPath));
        if (Array.isArray(value)) headingPath = value.map(String);
      } catch {
        // caminho de títulos ilegível: fica vazio
      }
      out.set(String(row.id), {
        chunkId: String(row.id),
        noteId: String(row.noteId),
        headingPath,
        text: String(row.text),
      });
    }
  }
  return out;
}
