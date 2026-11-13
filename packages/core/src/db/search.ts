// Busca por palavra-chave (doc 06, "Palavra-chave"): FTS5 com remoção de acentos sobre o texto e o título,
// pergunta limpa de palavras vazias, AND primeiro e OR como recuo, BM25 com peso maior para o título.
// A validade é calculada na data da consulta (`asOf`, padrão hoje). Embeddings e fusão são do marco 2.

import type { SQLInputValue } from 'node:sqlite';
import { estimateTokens } from '../markdown/index.ts';
import { localDate } from '../vault/index.ts';
import type { LocalIndex } from './open.ts';
import { connection } from './open.ts';

/** Peso das colunas no BM25: texto do trecho e `Título › Seção`. */
export const BM25_TEXT_WEIGHT = 1.0;
export const BM25_TITLE_WEIGHT = 2.0;
/**
 * Fator aplicado à pontuação de um resultado vencido ou ainda não vigente na data da consulta: rebaixado, nunca
 * escondido (doc 06, "Validade no tempo").
 */
export const EXPIRED_SCORE_FACTOR = 0.5;
/** Termos além deste número são ignorados (uma pergunta colada de um texto longo não vira uma consulta enorme). */
export const MAX_QUERY_TERMS = 16;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;

// Palavras vazias de português e inglês, sem acento (a comparação também é feita sem acento).
const STOPWORDS = new Set(
  `a o as os um uma uns umas de do da dos das dum duma em no na nos nas num numa por pelo pela pelos pelas para pra
  pro com sem sob sobre ate entre que e ou se ao aos as como mais mas nao sim ja so tambem muito muita muitos muitas
  pouco porque por que qual quais quando onde quem cujo cuja isso isto aquilo esse essa esses essas este esta estes
  estas aquele aquela aqueles aquelas eu tu ele ela nos vos eles elas me te lhe lhes meu minha meus minhas seu sua seus
  suas nosso nossa nossos nossas voce voces ser sao era eram foi foram sera seja sejam ter tem tinha tinham teve
  estar esta estao estava estavam fica ficou ha havia houve vai vao ir fazer faz fez the an of to in on at by for from
  with without into onto about over under and or but nor not no yes so if then than as is are was were be been being
  am do does did done have has had having it its this that these those there here what which who whom whose when where
  why how all any both each few more most other some such only own same too very can could should would will shall
  may might must just i you he she we they me him her us them my your his our their`
    .split(/\s+/)
    .filter((word) => word !== ''),
);

const stripDiacritics = (text: string): string => text.normalize('NFD').replace(/\p{M}+/gu, '');

/** Palavra (letras e dígitos) ou identificador composto (`db-reset`, `make_db`, `v1.2`, `user:name`). */
const TERM_RE = /[\p{L}\p{N}]+(?:[-_.:/'’@][\p{L}\p{N}]+)*(\*)?/gu;

export interface QueryTerm {
  /** Texto do termo, em NFC e minúsculas. */
  readonly text: string;
  /** Digitado com `*` no fim: busca por prefixo. */
  readonly prefix: boolean;
}

/**
 * Limpa a pergunta: separa os termos, tira as palavras vazias e repetições. Aspas, `-`, `:`, `*`, parênteses e
 * operadores digitados pelo usuário viram texto comum (nunca sintaxe do FTS5).
 */
export function queryTerms(query: string): QueryTerm[] {
  const out: QueryTerm[] = [];
  const seen = new Set<string>();
  for (const match of query.normalize('NFC').toLowerCase().matchAll(TERM_RE)) {
    const prefix = match[1] === '*';
    const text = prefix ? match[0].slice(0, -1) : match[0];
    if (!prefix && STOPWORDS.has(stripDiacritics(text))) continue;
    const key = `${text}${prefix ? '*' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, prefix });
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

/** Termo como expressão FTS5: sempre entre aspas (frase), com `*` fora das aspas para prefixo. */
function ftsTerm(term: QueryTerm): string {
  return `"${term.text.replaceAll('"', '""')}"${term.prefix ? '*' : ''}`;
}

/** Expressão FTS5 de uma lista de termos. Exportada para testes e para o `eval`. */
export function buildFtsQuery(terms: readonly QueryTerm[], operator: 'AND' | 'OR'): string {
  return terms.map(ftsTerm).join(` ${operator} `);
}

/**
 * Validade de uma nota numa data (doc 06, "Validade no tempo"):
 * - `current`: vigente;
 * - `expired`: vencida (`valid_until`, `expires_at` ou a data em que outra nota a substituiu é a data ou antes);
 * - `not_yet_valid`: ainda não vigente (`valid_from` depois da data). Só aparece numa consulta com `as_of` no
 *   passado, ou numa nota com `valid_from` no futuro.
 * As duas últimas são rebaixadas na busca, nunca escondidas.
 */
export const VALIDITIES = ['current', 'expired', 'not_yet_valid'] as const;
export type Validity = (typeof VALIDITIES)[number];

/** Os campos de uma nota que decidem a validade. */
export interface ValidityFields {
  readonly validFrom?: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  /** Data em que outra nota passou a substituir esta (`supersedes`/`superseded_by`), derivada na varredura. */
  readonly supersededOn?: string | null;
}

/**
 * Validade em `date` (`AAAA-MM-DD`). `valid_until` é exclusivo (a decisão que vale até 03/05 e a que vale a partir
 * de 03/05 não se sobrepõem); `valid_from` é inclusivo. Datas com hora contam pelo dia.
 */
export function validityOf(note: ValidityFields, date: string): Validity {
  const day = date.slice(0, 10);
  const ended = (value: string | null | undefined): boolean => value != null && value.slice(0, 10) <= day;
  if (ended(note.validUntil) || ended(note.expiresAt) || ended(note.supersededOn)) return 'expired';
  if (note.validFrom != null && note.validFrom.slice(0, 10) > day) return 'not_yet_valid';
  return 'current';
}

export interface KeywordSearchOptions {
  readonly query: string;
  /** Escopos aceitos (`global`, `project:atlas`), comparados exatamente. Sem filtro quando ausente. */
  readonly scope?: string | readonly string[];
  /** Tipos de nota aceitos (`decision`, `fact`...). */
  readonly types?: readonly string[];
  /** Máximo de resultados (notas). Padrão 10, máximo 100. */
  readonly limit?: number;
  /** Orçamento aproximado de tokens da resposta; os resultados param antes de estourar. */
  readonly budgetTokens?: number;
  /** Inclui notas de `memory/_archive/`. Padrão: não. */
  readonly includeArchived?: boolean;
  /**
   * Inclui as cópias de conflito do sync (`nota.conflict-<máquina>-<data>.md`). Padrão: não; elas não são memória
   * vigente e repetiriam o texto da nota original.
   */
  readonly includeConflictCopies?: boolean;
  /** "Hoje" para calcular a validade. Padrão: a data local atual. */
  readonly now?: Date;
  /** Data da consulta (`AAAA-MM-DD`): a validade é calculada nela, não em `now` (doc 06, `as_of`). */
  readonly asOf?: string;
}

export interface KeywordHit {
  readonly noteId: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly scope: string | null;
  /** Seção do melhor trecho da nota. */
  readonly headingPath: readonly string[];
  /** Trecho com os termos marcados entre `«` e `»`. */
  readonly snippet: string;
  /** Pontuação (BM25 invertido; maior é melhor), já rebaixada se o resultado estiver vencido. */
  readonly score: number;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  readonly validity: Validity;
}

export interface KeywordSearchResult {
  readonly hits: readonly KeywordHit[];
  /** `and`: todos os termos casaram; `or`: recuo para qualquer termo; `none`: pergunta vazia depois da limpeza. */
  readonly mode: 'and' | 'or' | 'none';
  /** Termos usados, depois de tirar as palavras vazias. */
  readonly terms: readonly string[];
  /** Algum resultado ficou de fora por causa do orçamento de tokens. */
  readonly truncated: boolean;
}

interface CandidateRow {
  readonly noteId: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly scope: string | null;
  readonly headingPath: string;
  readonly snippet: string;
  readonly rank: number;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  readonly supersededOn: string | null;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function parseHeadingPath(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/** Tokens estimados de um resultado na resposta (campos de texto mais uma folga para a estrutura). */
export function hitTokens(hit: KeywordHit): number {
  return (
    estimateTokens(
      [
        hit.noteId,
        hit.path,
        hit.title ?? '',
        hit.type ?? '',
        hit.scope ?? '',
        hit.headingPath.join(' › '),
        hit.snippet,
      ].join(' '),
    ) + 24
  );
}

/**
 * Busca por palavra-chave. Uma pergunta vazia (ou só de palavras vazias) devolve resultado vazio, sem erro.
 * Devolve no máximo um trecho por nota (o melhor), em ordem de pontuação, com resultados vencidos rebaixados.
 */
export function searchKeyword(index: LocalIndex, options: KeywordSearchOptions): KeywordSearchResult {
  const terms = queryTerms(options.query);
  const termTexts = terms.map((term) => `${term.text}${term.prefix ? '*' : ''}`);
  if (terms.length === 0) return { hits: [], mode: 'none', terms: [], truncated: false };

  const db = connection(index);
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT)));
  // candidatos a mais: vários trechos da mesma nota viram um resultado só
  const candidates = Math.max(50, limit * 8);

  const filters: string[] = [];
  const params: SQLInputValue[] = [];
  if (options.includeArchived !== true) filters.push('n.archived = 0');
  if (options.includeConflictCopies !== true) filters.push('n.conflict_of is null');
  if (options.types !== undefined && options.types.length > 0) {
    filters.push(`n.type in (${options.types.map(() => '?').join(', ')})`);
    params.push(...options.types);
  }
  if (options.scope !== undefined) {
    const scopes = typeof options.scope === 'string' ? [options.scope] : [...options.scope];
    if (scopes.length > 0) {
      filters.push(`n.scope in (${scopes.map(() => '?').join(', ')})`);
      params.push(...scopes);
    }
  }
  const statement = db.prepare(`
    select c.note_id as noteId, n.path, n.title, n.type, n.scope, c.heading_path as headingPath,
      snippet(chunks_fts, 0, '«', '»', '…', 24) as snippet,
      bm25(chunks_fts, ${BM25_TEXT_WEIGHT}, ${BM25_TITLE_WEIGHT}) as rank,
      n.trust, n.origin, n.valid_from as validFrom, n.valid_until as validUntil, n.expires_at as expiresAt,
      n.superseded_on as supersededOn
    from chunks_fts
      join chunks c on c.id = chunks_fts.rowid
      join notes n on n.id = c.note_id
    where chunks_fts match ?${filters.map((filter) => ` and ${filter}`).join('')}
    order by rank
    limit ?`);

  const run = (operator: 'AND' | 'OR'): CandidateRow[] =>
    statement.all(buildFtsQuery(terms, operator), ...params, candidates).map((row) => ({
      noteId: String(row.noteId),
      path: String(row.path),
      title: text(row.title),
      type: text(row.type),
      scope: text(row.scope),
      headingPath: String(row.headingPath),
      snippet: String(row.snippet ?? ''),
      rank: Number(row.rank),
      trust: text(row.trust),
      origin: text(row.origin),
      validFrom: text(row.validFrom),
      validUntil: text(row.validUntil),
      expiresAt: text(row.expiresAt),
      supersededOn: text(row.supersededOn),
    }));

  let mode: 'and' | 'or' = 'and';
  let rows = run('AND');
  if (rows.length === 0 && terms.length > 1) {
    mode = 'or';
    rows = run('OR');
  }

  const today = options.asOf ?? localDate(options.now ?? new Date());
  const best = new Map<string, KeywordHit>();
  for (const row of rows) {
    if (best.has(row.noteId)) continue; // as linhas vêm do melhor para o pior trecho
    const validity = validityOf(row, today);
    const score = -row.rank * (validity === 'current' ? 1 : EXPIRED_SCORE_FACTOR);
    best.set(row.noteId, {
      noteId: row.noteId,
      path: row.path,
      title: row.title,
      type: row.type,
      scope: row.scope,
      headingPath: parseHeadingPath(row.headingPath),
      snippet: row.snippet,
      score: Math.round(score * 10_000) / 10_000,
      trust: row.trust,
      origin: row.origin,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      expiresAt: row.expiresAt,
      validity,
    });
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));

  const hits: KeywordHit[] = [];
  let truncated = false;
  let spent = 0;
  for (const hit of ranked) {
    if (hits.length >= limit) break;
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
  return { hits, mode, terms: termTexts, truncated };
}
