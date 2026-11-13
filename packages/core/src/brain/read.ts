// Operações de leitura: `recall`, `search`, `read` e `status` (doc 05). Toda leitura começa pela varredura
// incremental (feita só se nenhuma começou depois do pedido) e devolve o conteúdo dentro do envelope de dado.
import type { IndexedNote, KeywordHit } from '../db/index.ts';
import { backlinks, getNote, indexStatus, listNotes, outgoingLinks, searchKeyword, validityOf } from '../db/index.ts';
import { readLocalEmbeddingState } from '../embeddings/index.ts';
import type { ParsedNote } from '../markdown/index.ts';
import { estimateTokens, HEADING_PATH_SEPARATOR } from '../markdown/index.ts';
import type { ConflictCopy, SyncStatusInfo } from '../sync/index.ts';
import { listConflicts, syncStatus } from '../sync/index.ts';
import { isSafeRelativePath, ulid } from '../util/index.ts';
import { isNoteType, isValidScope, NOTE_TYPE_DIRS, readNote } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { today, withFreshIndex } from './context.ts';
import type { EmbeddingsStatusOutput } from './embeddings.ts';
import { embeddingsStatus, refreshConfig } from './embeddings.ts';
import type { ContentKind, DataEnvelope, DataItem } from './envelope.ts';
import { DATA_NOTICE, dataItem } from './envelope.ts';
import { BrainError, toBrainError } from './errors.ts';
import type { RelatedOutput } from './graph.ts';
import { parseAsOf, relatedBlock } from './graph.ts';
import type { SearchMode, SearchModeUsed } from './semantic.ts';
import { fusedSearch, SEARCH_MODES } from './semantic.ts';

// ---------------------------------------------------------------------------------------------------------------
// Validação de argumentos comuns

function invalid(message: string, nextStep?: string): BrainError {
  return new BrainError('invalid_argument', message, nextStep === undefined ? {} : { nextStep });
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`"${name}" deveria ser um texto não vazio`);
  return value;
}

/**
 * Escopos aceitos numa consulta. `project:x` traz o projeto E o que é global (o que vale em todo lugar); `global` traz
 * só o global; sem escopo, todos.
 */
export function scopesFor(scope: unknown): string[] | undefined {
  if (scope === undefined || scope === null) return undefined;
  if (!isValidScope(scope)) throw invalid('"scope" deveria ser "global" ou "project:<slug>"');
  return scope === 'global' ? ['global'] : ['global', scope];
}

function typesFor(types: unknown): string[] | undefined {
  if (types === undefined || types === null) return undefined;
  if (!Array.isArray(types) || !types.every(isNoteType)) {
    throw invalid('"types" deveria ser uma lista de tipos de nota (decision, gotcha, fact...)');
  }
  return types.length === 0 ? undefined : [...types];
}

function positiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(`"${name}" deveria ser um inteiro positivo`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// recall

/** Orçamento padrão do briefing: cabe com folga no limite de 10 mil caracteres do hook de início (doc 07). */
export const DEFAULT_RECALL_BUDGET_TOKENS = 2000;
/** Corpo maior que isto entra cortado (`content_kind: 'excerpt'`). */
export const RECALL_ITEM_MAX_CHARS = 1200;
/** Quantas memórias relevantes (pela busca) entram no máximo. */
export const RECALL_MEMORY_LIMIT = 8;
/**
 * Ordem de prioridade do briefing. Com orçamento curto, os itens entram nesta ordem e o primeiro que não cabe
 * encerra o briefing: nada de prioridade menor entra no lugar de algo de prioridade maior que ficou de fora.
 *
 * 1. Regras: são a autoridade logo abaixo do usuário.
 * 2. Último handoff: onde a sessão anterior parou.
 * 3. Preferências do usuário.
 * 4. Armadilhas, as que casam com a tarefa primeiro.
 * 5. Memórias relevantes para a tarefa (trechos da busca por palavra-chave).
 */
export const RECALL_PRIORITY = ['rules', 'handoff', 'preferences', 'gotchas', 'memories'] as const;
export type RecallSection = (typeof RECALL_PRIORITY)[number];

export interface RecallInput {
  /** O que o agente vai fazer; é a pergunta da busca das memórias relevantes. */
  readonly task: string;
  /** `project:<slug>` (traz também o global) ou `global`. Sem ele, todos os escopos. */
  readonly scope?: string;
  /** Orçamento aproximado de tokens do briefing inteiro. Padrão: `DEFAULT_RECALL_BUDGET_TOKENS`. */
  readonly budget_tokens?: number;
}

export interface RecallOutput extends DataEnvelope {
  /** Identificador novo da sessão (ULID). Passe em `remember`, `write_page`, `patch_page` e `undo`. */
  readonly session_handle: string;
  readonly task: string;
  readonly scope: string | null;
  readonly rules: readonly DataItem[];
  readonly handoff: DataItem | null;
  readonly preferences: readonly DataItem[];
  readonly gotchas: readonly DataItem[];
  readonly memories: readonly DataItem[];
  readonly priority: readonly RecallSection[];
  readonly budget_tokens: number;
  /** Tokens estimados do briefing entregue. */
  readonly used_tokens: number;
  /** Algum item ficou de fora pelo orçamento. */
  readonly truncated: boolean;
  /** Quantos itens ficaram de fora pelo orçamento. */
  readonly omitted: number;
  readonly next_step: string;
}

interface Candidate {
  readonly section: RecallSection;
  readonly note: IndexedNote;
  /** Trecho pronto (memórias da busca); sem ele, o corpo é lido do disco. */
  readonly snippet?: string;
}

function cut(text: string, max: number): { text: string; kind: ContentKind } {
  const trimmed = text.trim();
  if (trimmed.length <= max) return { text: trimmed, kind: 'note' };
  return { text: `${trimmed.slice(0, max).trimEnd()}…`, kind: 'excerpt' };
}

const costOf = (value: unknown): number => estimateTokens(JSON.stringify(value));

const RULES_DIR_PREFIX = `${NOTE_TYPE_DIRS.rule.toLowerCase()}/`;

/**
 * Só é servida como regra a nota que o usuário gravou onde as regras moram: `origin: human` e dentro de
 * `memory/rules/`. Defesa em profundidade: as escritas já recusam `type: rule` vindo de agente, mas uma nota com
 * `type: rule` em outro lugar (escrita à mão, chegada pelo sync, gravada por uma versão antiga) não vira autoridade,
 * e fica fora do briefing (o `search` e o `read` ainda a mostram, com a proveniência).
 */
function isUserRule(note: IndexedNote): boolean {
  return note.origin === 'human' && note.path.toLowerCase().startsWith(RULES_DIR_PREFIX);
}

export async function recall(ctx: BrainContext, input: RecallInput): Promise<RecallOutput> {
  const task = requireText(input?.task, 'task');
  const scopes = scopesFor(input.scope);
  const budget = positiveInt(input.budget_tokens, 'budget_tokens') ?? DEFAULT_RECALL_BUDGET_TOKENS;
  const day = today(ctx);
  const current = (note: IndexedNote): boolean => validityOf(note, day) === 'current';
  const scopeFilter = scopes === undefined ? {} : { scope: scopes };

  const candidates = await withFreshIndex(ctx, (): Candidate[] => {
    const rules = listNotes(ctx.index, { types: ['rule'], ...scopeFilter, orderBy: 'path' }).filter(
      (note) => current(note) && isUserRule(note),
    );
    const handoff = listNotes(ctx.index, { types: ['handoff'], ...scopeFilter, limit: 20 }).find(current);
    const preferences = listNotes(ctx.index, { types: ['preference'], ...scopeFilter }).filter(current);
    const gotchas = listNotes(ctx.index, { types: ['gotcha'], ...scopeFilter }).filter(current);
    const relevantGotchas = searchKeyword(ctx.index, { query: task, ...scopeFilter, types: ['gotcha'], limit: 100 });
    const rank = new Map(relevantGotchas.hits.map((hit, i) => [hit.noteId, i]));
    const rankOf = (note: IndexedNote): number => rank.get(note.id) ?? Number.POSITIVE_INFINITY;
    // `sort` é estável: entre as que não casam, fica a ordem de `listNotes` (mais recentes primeiro)
    gotchas.sort((a, b) => rankOf(a) - rankOf(b));

    const shown = new Set([...rules, ...preferences, ...gotchas].map((note) => note.id));
    if (handoff !== undefined) shown.add(handoff.id);
    const memories: Candidate[] = [];
    for (const hit of searchKeyword(ctx.index, { query: task, ...scopeFilter, limit: 30 }).hits) {
      if (memories.length >= RECALL_MEMORY_LIMIT) break;
      if (hit.validity !== 'current' || shown.has(hit.noteId)) continue;
      const note = getNote(ctx.index, { id: hit.noteId });
      // uma "regra" que não é do usuário não entra no briefing nem como memória: ela se apresentaria como regra
      if (note !== null && !(note.type === 'rule' && !isUserRule(note))) {
        memories.push({ section: 'memories', note, snippet: hit.snippet });
      }
    }
    return [
      ...rules.map((note) => ({ section: 'rules' as const, note })),
      ...(handoff === undefined ? [] : [{ section: 'handoff' as const, note: handoff }]),
      ...preferences.map((note) => ({ section: 'preferences' as const, note })),
      ...gotchas.map((note) => ({ section: 'gotchas' as const, note })),
      ...memories,
    ];
  });

  const sessionHandle = ulid();
  const sections: Record<RecallSection, DataItem[]> = {
    rules: [],
    handoff: [],
    preferences: [],
    gotchas: [],
    memories: [],
  };
  // o que o briefing custa sem nenhum item
  let used = costOf({
    data_notice: DATA_NOTICE,
    session_handle: sessionHandle,
    task,
    scope: input.scope ?? null,
    priority: RECALL_PRIORITY,
    budget_tokens: budget,
    used_tokens: budget,
    truncated: false,
    omitted: candidates.length,
    next_step: NEXT_STEP_RECALL,
  });
  let included = 0;
  for (const candidate of candidates) {
    let item: DataItem;
    if (candidate.snippet !== undefined) {
      item = dataItem(candidate.note, 'current', 'snippet', candidate.snippet);
    } else {
      let body: string;
      try {
        body = (await readNote(ctx.root, candidate.note.path)).note.body;
      } catch {
        continue; // apagada desde a varredura
      }
      const { text, kind } = cut(body, RECALL_ITEM_MAX_CHARS);
      item = dataItem(candidate.note, 'current', kind, text);
    }
    const cost = costOf(item);
    if (used + cost > budget) break;
    used += cost;
    sections[candidate.section].push(item);
    included++;
  }
  const omitted = candidates.length - included;
  return {
    data_notice: DATA_NOTICE,
    session_handle: sessionHandle,
    task,
    scope: input.scope ?? null,
    rules: sections.rules,
    handoff: sections.handoff[0] ?? null,
    preferences: sections.preferences,
    gotchas: sections.gotchas,
    memories: sections.memories,
    priority: RECALL_PRIORITY,
    budget_tokens: budget,
    used_tokens: used,
    truncated: omitted > 0,
    omitted,
    next_step: NEXT_STEP_RECALL,
  };
}

const NEXT_STEP_RECALL =
  'Siga as regras. Use search antes de afirmar algo sobre o histórico do usuário e read para ver uma nota inteira. ' +
  'Grave com remember o que for durável e não óbvio, passando o session_handle.';

// ---------------------------------------------------------------------------------------------------------------
// search

export interface SearchInput {
  readonly query: string;
  /** Mesma regra do `recall`: `project:x` inclui o global. */
  readonly scope?: string;
  readonly types?: readonly string[];
  /** Máximo de resultados (notas). Padrão 10, máximo 100. */
  readonly limit?: number;
  readonly budget_tokens?: number;
  /** Data da consulta (`AAAA-MM-DD`; padrão hoje): a validade de cada resultado é calculada nela. */
  readonly as_of?: string;
  /**
   * `auto` (padrão): híbrida quando a busca por significado está ativada e o runtime está disponível nesta máquina;
   * senão, palavra-chave. `keyword`: só palavra-chave. `semantic`: só vetor. `hybrid`: fusão das duas.
   */
  readonly mode?: SearchMode;
}

export interface SearchHit extends DataItem {
  /**
   * Pontuação (maior é melhor), já rebaixada se o resultado estiver vencido. Na palavra-chave é o BM25 invertido; na
   * busca híbrida ou por significado é a da fusão, de 0 a 1.
   */
  readonly score: number;
  /** Seção do melhor trecho da nota. */
  readonly heading_path: readonly string[];
}

export interface SearchOutput extends DataEnvelope {
  readonly query: string;
  /**
   * Como a palavra-chave casou: `and` (todos os termos), `or` (recuo para qualquer termo) ou `none` (pergunta vazia
   * depois da limpeza, ou busca só por significado). O modo da busca está em `mode_used`.
   */
  readonly mode: 'and' | 'or' | 'none';
  /** Modo pedido (`auto` quando não veio). */
  readonly mode_requested: SearchMode;
  /** Modo de fato usado: `keyword`, `semantic` ou `hybrid`. */
  readonly mode_used: SearchModeUsed;
  /** Por que este modo (em português). */
  readonly mode_reason: string;
  /** Avisos, como a queda para palavra-chave quando o runtime falha no meio da busca. */
  readonly warnings: readonly string[];
  readonly terms: readonly string[];
  /** Data em que a validade foi calculada. */
  readonly as_of: string;
  /** Do melhor para o pior. Vencidos e ainda não vigentes na data vêm rebaixados, nunca escondidos. */
  readonly hits: readonly SearchHit[];
  /**
   * Bloco separado: até 5 vizinhos no grafo dos melhores resultados, com o motivo de cada um. Não mexe na ordem de
   * `hits` (o grafo misturado ao ranking piorou a busca por termo exato na medição).
   */
  readonly related: readonly RelatedOutput[];
  /** Algum resultado ficou de fora pelo orçamento de tokens. */
  readonly truncated: boolean;
  readonly next_step?: string;
}

function modeOf(value: unknown): SearchMode {
  if (value === undefined || value === null) return 'auto';
  if (typeof value !== 'string' || !(SEARCH_MODES as readonly string[]).includes(value)) {
    throw invalid(`"mode" deveria ser um de ${SEARCH_MODES.join(', ')}`);
  }
  return value as SearchMode;
}

interface ModeDecision {
  readonly used: SearchModeUsed;
  readonly reason: string;
  readonly warnings: string[];
}

/** Decide o modo sem carregar nada: configuração do cérebro, estado desta máquina e o runtime injetado. */
async function decideMode(ctx: BrainContext, requested: SearchMode): Promise<ModeDecision> {
  if (requested === 'keyword') return { used: 'keyword', reason: 'busca por palavra-chave, como pedido', warnings: [] };
  const fallback = (reason: string): ModeDecision => ({
    used: 'keyword',
    reason,
    warnings:
      requested === 'auto'
        ? []
        : [
            `a busca ${requested === 'semantic' ? 'por significado' : 'híbrida'} não está disponível: ${reason}; resultado só por palavra-chave`,
          ],
  });
  const config = await refreshConfig(ctx);
  const embedding = config.embedding;
  if (embedding === undefined) {
    return fallback('a busca por significado não está ativada neste cérebro ("cabecao embeddings on" ativa)');
  }
  if ((await readLocalEmbeddingState(ctx.root)).disabled) {
    return fallback('a busca por significado está desligada nesta máquina ("cabecao embeddings on" religa)');
  }
  const availability = await ctx.engine.available(embedding);
  if (!availability.ok) return fallback(availability.reason);
  return requested === 'semantic'
    ? { used: 'semantic', reason: `busca por significado com ${embedding.model}, como pedido`, warnings: [] }
    : {
        used: 'hybrid',
        reason: `${requested === 'auto' ? 'busca por significado ativada: ' : ''}fusão da palavra-chave com ${embedding.model}`,
        warnings: [],
      };
}

export async function search(ctx: BrainContext, input: SearchInput): Promise<SearchOutput> {
  const query = requireText(input?.query, 'query');
  const scopes = scopesFor(input.scope);
  const types = typesFor(input.types);
  const limit = positiveInt(input.limit, 'limit');
  const budget = positiveInt(input.budget_tokens, 'budget_tokens');
  const requested = modeOf(input.mode);
  const now = ctx.now();
  const asOf = parseAsOf(ctx, input.as_of);
  const decision = await decideMode(ctx, requested);
  let used = decision.used;
  let reason = decision.reason;
  const warnings = [...decision.warnings];
  // o modelo e os vetores carregam fora da trava do banco; uma falha aqui não derruba a busca
  let semantic: { store: Awaited<ReturnType<typeof ctx.engine.vectors>>; vector: Float32Array } | null = null;
  const embedding = ctx.config.embedding;
  if (used !== 'keyword' && embedding !== undefined) {
    try {
      const store = await ctx.engine.vectors(embedding);
      const vector = await ctx.engine.embedQuery(embedding, query);
      semantic = { store, vector };
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 300) ?? '';
      warnings.push(`a busca por significado falhou (${detail}); resultado só por palavra-chave`);
      reason = 'o runtime de embeddings falhou nesta busca';
      used = 'keyword';
    }
  }
  const { result, notes, related } = await withFreshIndex(ctx, () => {
    const filters = {
      ...(scopes === undefined ? {} : { scope: scopes }),
      ...(types === undefined ? {} : { types }),
    };
    const found =
      semantic === null
        ? searchKeyword(ctx.index, {
            query,
            now,
            asOf,
            ...filters,
            ...(limit === undefined ? {} : { limit }),
            ...(budget === undefined ? {} : { budgetTokens: budget }),
          })
        : fusedSearch(ctx.index, {
            query,
            filters,
            store: semantic.store,
            vector: semantic.vector,
            asOf,
            limit: Math.min(100, limit ?? 10),
            ...(budget === undefined ? {} : { budgetTokens: budget }),
            semanticOnly: used === 'semantic',
          });
    const byId = new Map<string, IndexedNote>();
    for (const hit of found.hits) {
      const note = getNote(ctx.index, { id: hit.noteId });
      if (note !== null) byId.set(hit.noteId, note);
    }
    const neighbors = relatedBlock(
      ctx,
      found.hits.map((hit) => ({ id: hit.noteId, path: hit.path })),
      asOf,
    );
    return { result: found, notes: byId, related: neighbors };
  });
  const hits = result.hits.map((hit: KeywordHit): SearchHit => {
    const note = notes.get(hit.noteId);
    const base = dataItem(
      {
        id: hit.noteId,
        path: hit.path,
        type: hit.type,
        title: hit.title,
        scope: hit.scope,
        trust: hit.trust,
        origin: hit.origin,
        frontmatter: note?.frontmatter ?? {},
      },
      hit.validity,
      'snippet',
      hit.snippet,
    );
    return { ...base, score: hit.score, heading_path: [...hit.headingPath] };
  });
  // o bloco `related` cabe no que sobrou do orçamento, se houver um
  let room = budget === undefined ? Number.POSITIVE_INFINITY : budget - estimateTokens(JSON.stringify(hits));
  const relatedShown: RelatedOutput[] = [];
  for (const item of related) {
    const cost = estimateTokens(JSON.stringify(item));
    if (cost > room) break;
    room -= cost;
    relatedShown.push(item);
  }
  return {
    data_notice: DATA_NOTICE,
    query,
    mode: result.mode,
    mode_requested: requested,
    mode_used: used,
    mode_reason: reason,
    warnings,
    terms: result.terms,
    as_of: asOf,
    hits,
    related: relatedShown,
    truncated: result.truncated,
    ...(hits.length > 0
      ? {}
      : {
          next_step:
            used === 'keyword'
              ? 'Nada encontrado. A busca foi por palavra-chave: tente sinônimos, o nome exato ou menos termos, sem filtros.'
              : 'Nada encontrado. Tente outras palavras, menos termos ou sem filtros.',
        }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// read

export type ReadInput =
  | { readonly path: string; readonly id?: undefined; readonly section?: string }
  | { readonly id: string; readonly path?: undefined; readonly section?: string };

export interface LinkOutput {
  /** `wikilink`, `relation`, `fact`, `supersedes`... */
  readonly origin: string;
  /** `link`, `embed`, o nome da relação (`uses`...), `subject`/`object`... */
  readonly type: string;
  /** Alvo como escrito. */
  readonly target: string;
  /** Nota de destino; `null` se o link está quebrado. */
  readonly path: string | null;
  readonly title: string | null;
  readonly note_type: string | null;
  readonly broken: boolean;
}

export interface BacklinkOutput {
  readonly origin: string;
  readonly type: string;
  /** Nota de onde vem o link. */
  readonly path: string;
  readonly title: string | null;
  readonly note_type: string | null;
  readonly archived: boolean;
  readonly line: number | null;
}

export interface ReadOutput extends DataEnvelope {
  /** `content` é o corpo (sem frontmatter) ou, com `section`, só aquela seção (com as subseções). */
  readonly note: DataItem;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Erro de YAML, se o frontmatter não pôde ser lido. */
  readonly frontmatter_error: string | null;
  readonly section: string | null;
  /** Títulos da nota, como caminho (`Contexto › Detalhe`), para pedir uma `section`. */
  readonly headings: readonly string[];
  readonly archived: boolean;
  readonly outgoing_links: readonly LinkOutput[];
  readonly backlinks: readonly BacklinkOutput[];
}

const normalizeHeading = (text: string): string =>
  text
    .normalize('NFC')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Texto da seção pedida (do título até o próximo título de nível igual ou maior), ou `null`. */
function sectionText(text: string, parsed: ParsedNote, wanted: string): string | null {
  const key = normalizeHeading(wanted);
  const keyPath = key.split(/\s*(?:›|>|\/)\s*/).join(' › ');
  const index = parsed.headings.findIndex(
    (heading) =>
      normalizeHeading(heading.text) === key ||
      normalizeHeading(heading.headingPath.join(HEADING_PATH_SEPARATOR)) === keyPath,
  );
  const heading = parsed.headings[index];
  if (heading === undefined) return null;
  const next = parsed.headings.slice(index + 1).find((other) => other.level <= heading.level);
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const end = next === undefined ? lines.length : next.line - 1;
  return lines
    .slice(heading.line - 1, end)
    .join('\n')
    .replace(/\s+$/, '');
}

export async function read(ctx: BrainContext, input: ReadInput): Promise<ReadOutput> {
  const byId = typeof input?.id === 'string' && input.id !== '';
  const byPath = typeof input?.path === 'string' && input.path !== '';
  if (byId === byPath) throw invalid('informe "path" ou "id" (só um dos dois)');
  if (input.section !== undefined && (typeof input.section !== 'string' || input.section.trim() === '')) {
    throw invalid('"section" deveria ser o texto de um título da nota');
  }
  if (byPath && !isSafeRelativePath(input.path)) {
    throw new BrainError('unsafe_path', `caminho recusado: ${JSON.stringify(input.path)} não fica dentro do cérebro`, {
      details: { path: String(input.path) },
    });
  }
  const ref = byId ? { id: String(input.id) } : { path: String(input.path) };
  const found = await withFreshIndex(ctx, () => {
    const note = getNote(ctx.index, ref);
    if (note === null) return null;
    return { note, outgoing: outgoingLinks(ctx.index, note.id), incoming: backlinks(ctx.index, note.id) };
  });
  if (found === null) {
    throw new BrainError(
      'not_found',
      byId
        ? `nenhuma nota com o id ${String(input.id)}`
        : `nenhuma nota em ${String(input.path)} (só são lidas notas .md dentro das pastas de notas do cérebro)`,
      {
        details: byPath ? { path: String(input.path) } : {},
        nextStep: 'Use search para achar a nota pelo assunto.',
      },
    );
  }
  const { note, outgoing, incoming } = found;
  let disk: Awaited<ReturnType<typeof readNote>>;
  try {
    disk = await readNote(ctx.root, note.path);
  } catch (error) {
    throw toBrainError(error);
  }
  const parsed = disk.note;
  let content = parsed.body;
  let kind: ContentKind = 'note';
  if (input.section !== undefined) {
    const text = sectionText(disk.text, parsed, input.section);
    const headings = parsed.headings.map((heading) => heading.headingPath.join(HEADING_PATH_SEPARATOR));
    if (text === null) {
      throw new BrainError('not_found', `a nota ${note.path} não tem a seção "${input.section}"`, {
        details: { path: note.path, headings },
        nextStep:
          headings.length === 0
            ? 'Esta nota não tem títulos; leia sem "section".'
            : `Peça uma destas seções: ${headings.join('; ')}.`,
      });
    }
    content = text;
    kind = 'section';
  }
  return {
    data_notice: DATA_NOTICE,
    note: dataItem(note, validityOf(note, today(ctx)), kind, content),
    frontmatter: parsed.frontmatter,
    frontmatter_error: parsed.frontmatterError?.message ?? null,
    section: input.section ?? null,
    headings: parsed.headings.map((heading) => heading.headingPath.join(HEADING_PATH_SEPARATOR)),
    archived: note.archived,
    outgoing_links: outgoing.map((link) => ({
      origin: link.origin,
      type: link.type,
      target: link.target,
      path: link.path,
      title: link.title,
      note_type: link.noteType,
      broken: link.broken,
    })),
    backlinks: incoming.map((link) => ({
      origin: link.origin,
      type: link.type,
      path: link.path,
      title: link.title,
      note_type: link.noteType,
      archived: link.archived,
      line: link.line,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// status

export interface ConflictOutput {
  /** Cópia com a versão desta máquina na hora do conflito. */
  readonly copy: string;
  readonly original: string;
  readonly original_exists: boolean;
  readonly machine: string;
  readonly date: string;
}

export interface StatusOutput {
  /** Sem conflitos pendentes, último sync sem erro e banco no esquema esperado. */
  readonly healthy: boolean;
  /** O que impede `healthy`, em português. */
  readonly problems: readonly string[];
  readonly root: string;
  readonly client: string;
  readonly machine: string;
  /** `schemaVersion` do `.cabecao.json`. */
  readonly brain_schema_version: number;
  readonly note_dirs: readonly string[];
  readonly notes: {
    /** Todas as notas indexadas, inclusive arquivadas. */
    readonly total: number;
    /** Por tipo, sem as arquivadas. */
    readonly by_type: Readonly<Record<string, number>>;
    readonly untyped: number;
    readonly archived: number;
    /** Sem `id` no frontmatter (fontes brutas, notas soltas). */
    readonly unmanaged: number;
  };
  readonly index: {
    readonly schema_version: number;
    readonly expected_schema_version: number;
    readonly chunks: number;
    readonly edges: number;
    readonly facts: number;
    readonly last_scan_at: string | null;
    readonly last_scan_ms: number | null;
  };
  readonly broken_links: number;
  readonly sync: {
    readonly branch: string | null;
    readonly remote_configured: boolean;
    readonly remote: { readonly name: string; readonly url: string; readonly branch: string } | null;
    readonly last_sync: { readonly at: string; readonly status: string; readonly message: string } | null;
    /** Commits locais ainda não enviados; `null` sem remoto ou sem informação. */
    readonly unpushed: number | null;
    readonly unpulled: number | null;
    /** Arquivos alterados fora do Cabeção que o próximo sync vai commitar. */
    readonly pending_changes: number;
    readonly running: boolean;
  } | null;
  readonly conflicts: readonly ConflictOutput[];
  /** Busca por significado: modelo, runtime nesta máquina, trechos com e sem vetor (a fila). `null` se não deu para ler. */
  readonly embeddings: EmbeddingsStatusOutput | null;
  readonly next_step?: string;
}

export async function status(ctx: BrainContext, machine: string): Promise<StatusOutput> {
  const index = await withFreshIndex(ctx, () => ({ status: indexStatus(ctx.index) }));
  const problems: string[] = [];
  let sync: SyncStatusInfo | null = null;
  let conflicts: ConflictCopy[] = [];
  try {
    sync = await syncStatus(ctx.root);
    conflicts = await listConflicts(ctx.root);
  } catch (error) {
    problems.push(
      `não consegui ler o estado do git: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
    );
  }
  if (conflicts.length > 0) {
    problems.push(`${conflicts.length} ${conflicts.length === 1 ? 'conflito pendente' : 'conflitos pendentes'}`);
  }
  const last = sync?.lastSync ?? null;
  if (last !== null && last.status !== 'ok' && last.status !== 'busy') {
    problems.push(`o último sync terminou como "${last.status}": ${last.message}`);
  }
  if (index.status.schemaVersion !== index.status.expectedSchemaVersion) {
    problems.push(
      'o banco local está num esquema diferente do esperado; rode "cabecao doctor" (apagar a pasta .cabecao/ é seguro: o banco é refeito a partir das notas)',
    );
  }
  let embeddings: EmbeddingsStatusOutput | null = null;
  try {
    embeddings = await embeddingsStatus(ctx);
    if (embeddings.problem !== null) problems.push(`embeddings: ${embeddings.problem}`);
  } catch (error) {
    problems.push(
      `não consegui ler o estado dos embeddings: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        400,
      ),
    );
  }
  const steps: string[] = [];
  if (conflicts.length > 0) {
    steps.push('Resolva os conflitos: compare cada cópia .conflict-* com a nota original, junte e apague a cópia.');
  }
  if ((sync?.unpushed ?? 0) > 0 || (sync?.pendingChanges ?? 0) > 0) steps.push('Rode sync para enviar as mudanças.');
  return {
    healthy: problems.length === 0,
    problems,
    root: ctx.root,
    client: ctx.client,
    machine,
    brain_schema_version: ctx.config.schemaVersion,
    note_dirs: ctx.config.noteDirs,
    notes: {
      total: index.status.notes,
      by_type: index.status.byType,
      untyped: index.status.untyped,
      archived: index.status.archived,
      unmanaged: index.status.unmanaged,
    },
    index: {
      schema_version: index.status.schemaVersion,
      expected_schema_version: index.status.expectedSchemaVersion,
      chunks: index.status.chunks,
      edges: index.status.edges,
      facts: index.status.facts,
      last_scan_at: index.status.lastScanAt,
      last_scan_ms: index.status.lastScanMs,
    },
    broken_links: index.status.brokenLinks,
    sync:
      sync === null
        ? null
        : {
            branch: sync.branch,
            remote_configured: sync.remote !== null,
            remote: sync.remote,
            last_sync: sync.lastSync,
            unpushed: sync.unpushed,
            unpulled: sync.unpulled,
            pending_changes: sync.pendingChanges,
            running: sync.running,
          },
    conflicts: conflicts.map((conflict) => ({
      copy: conflict.copy,
      original: conflict.original,
      original_exists: conflict.originalExists,
      machine: conflict.machine,
      date: conflict.date,
    })),
    embeddings,
    ...(steps.length === 0 ? {} : { next_step: steps.join(' ') }),
  };
}
