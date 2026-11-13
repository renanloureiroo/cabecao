// Operações do marco 3 de leitura do grafo (doc 05): `graph` (vizinhos de uma nota, com tipo e direção de cada
// relação) e `facts` (fatos e se valem numa data, com a cadeia de versões), mais o bloco `related` da busca.
// Tudo o que sai é dado do cérebro: vem com `data_notice` e a proveniência (`trust`, `origin`, `edited_by`) de cada
// nota, como as outras leituras.
import type { EdgeFilter, GraphEdgeRow, GraphNoteRow, IndexedNote, NodeMatch, Validity } from '../db/index.ts';
import {
  indexedBodies,
  MAX_NODE_REF_LENGTH,
  neighborhood,
  originWeight,
  queryFacts,
  relatedCandidates,
  resolveNodeRef,
} from '../db/index.ts';
import { estimateTokens } from '../markdown/index.ts';
import type { RelationsConfig } from '../vault/index.ts';
import { isIsoDate, relationTypes, SUPERSEDE_FIELDS } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { today, withFreshIndex } from './context.ts';
import type { DataEnvelope, DataItem } from './envelope.ts';
import { DATA_NOTICE, dataItem, editedByOf } from './envelope.ts';
import { BrainError } from './errors.ts';

// ---------------------------------------------------------------------------------------------------------------
// Argumentos comuns

function invalid(message: string, nextStep?: string): BrainError {
  return new BrainError('invalid_argument', message, nextStep === undefined ? {} : { nextStep });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Data da consulta: `AAAA-MM-DD` (com hora opcional, que é ignorada). Sem ela, hoje. Uma data impossível
 * (`2026-02-30`), um texto qualquer ou um tipo errado são recusados.
 */
export function parseAsOf(ctx: BrainContext, value: unknown): string {
  if (value === undefined || value === null) return today(ctx);
  if (typeof value !== 'string' || value.length > 64 || !isIsoDate(value.trim())) {
    throw invalid('"as_of" deveria ser uma data AAAA-MM-DD, como "2026-05-03"');
  }
  return value.trim().slice(0, 10);
}

/** Referência a uma nota (id, caminho, wikilink ou título): texto curto, sem caractere de controle. */
export function requireRef(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`"${name}" deveria ser o título, o caminho ou o id de uma nota`);
  }
  if (value.length > MAX_NODE_REF_LENGTH) {
    throw invalid(`"${name}" é grande demais: o limite é ${MAX_NODE_REF_LENGTH} caracteres`);
  }
  if (CONTROL_RE.test(value)) throw invalid(`"${name}" tem um caractere de controle`);
  return value.trim();
}

function optionalInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`"${name}" deveria ser um inteiro de ${min} a ${max}`);
  }
  return value;
}

/** Resolve a referência ou lança `not_found` / `invalid_argument` (ambígua, com os candidatos). */
export function resolveOrThrow(ctx: BrainContext, ref: string, name: string): { note: IndexedNote; by: NodeMatch } {
  const found = resolveNodeRef(ctx.index, ref);
  if (found.kind === 'found') return { note: found.note, by: found.by };
  if (found.kind === 'ambiguous') {
    const candidates = found.candidates.map((note) => note.path);
    throw new BrainError('invalid_argument', `"${name}" é ambíguo: ${candidates.length} notas têm esse nome`, {
      details: { candidates: candidates.slice(0, 20) },
      nextStep: `Passe o caminho de uma delas em "${name}": ${candidates.slice(0, 5).join('; ')}.`,
    });
  }
  throw new BrainError('not_found', `nenhuma nota corresponde a ${JSON.stringify(ref)} ("${name}")`, {
    nextStep: 'Use search para achar a nota e passe o caminho ou o id dela.',
  });
}

/** Tipos aceitos em `relation_types`, na ordem: relações do cérebro, versões e as origens que não são relação. */
export function graphEdgeKinds(config: RelationsConfig): string[] {
  return [...relationTypes(config), ...SUPERSEDE_FIELDS, 'wikilink', 'fact', 'mention'];
}

function edgeFilters(value: unknown, config: RelationsConfig): EdgeFilter[] | undefined {
  if (value === undefined || value === null) return undefined;
  const allowed = graphEdgeKinds(config);
  if (!Array.isArray(value) || value.length > 50 || !value.every((item) => typeof item === 'string')) {
    throw invalid(`"relation_types" deveria ser uma lista com: ${allowed.join(', ')}`);
  }
  const relations = new Set(relationTypes(config));
  const filters: EdgeFilter[] = [];
  for (const kind of new Set(value as string[])) {
    if (!allowed.includes(kind)) {
      throw invalid(`tipo de relação desconhecido: ${JSON.stringify(kind)}; os tipos são: ${allowed.join(', ')}`);
    }
    if (relations.has(kind)) filters.push({ origin: 'relation', type: kind });
    else if ((SUPERSEDE_FIELDS as readonly string[]).includes(kind)) filters.push({ origin: 'supersedes', type: kind });
    else filters.push({ origin: kind as EdgeFilter['origin'] });
  }
  return filters.length === 0 ? undefined : filters;
}

// ---------------------------------------------------------------------------------------------------------------
// Saídas comuns

/** Uma nota do grafo: identificação, validade na data e proveniência. Sem conteúdo (use `read`). */
export interface GraphNodeOutput {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly scope: string | null;
  readonly validity: Validity;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly edited_by: string | null;
}

/** Uma relação no caminho até o vizinho. */
export interface GraphLinkOutput {
  /** Nota de onde a aresta sai (caminho). */
  readonly from: string;
  /** Nota aonde a aresta chega (caminho). */
  readonly to: string;
  /** `uses`, `part_of`... (relação), `link`/`embed`/campo (wikilink), `subject`/`object` (fato), `supersedes`, `mention`. */
  readonly type: string;
  readonly origin: string;
  /** `out`: sai da nota mais perto da consulta para o vizinho; `in`: chega nela vinda do vizinho. */
  readonly direction: 'out' | 'in';
  /** Validade da relação na data: a da nota de onde ela sai. */
  readonly validity: Validity;
}

function nodeOutput(note: GraphNoteRow): GraphNodeOutput {
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    type: note.type,
    scope: note.scope,
    validity: note.validity,
    trust: note.trust,
    origin: note.origin,
    edited_by: editedByOf(note.frontmatter),
  };
}

const costOf = (value: unknown): number => estimateTokens(JSON.stringify(value));

// ---------------------------------------------------------------------------------------------------------------
// graph

export const DEFAULT_GRAPH_LIMIT = 50;
export const MAX_GRAPH_LIMIT = 200;
export const DEFAULT_GRAPH_BUDGET_TOKENS = 3000;
/** Relações mostradas no máximo por vizinho. */
export const MAX_LINKS_PER_NEIGHBOR = 5;

export interface GraphInput {
  /** Título, caminho, wikilink ou id da nota. */
  readonly node: string;
  /** 1 (padrão) ou 2 saltos. */
  readonly depth?: number;
  /** Só estes tipos (`uses`, `part_of`..., `supersedes`, `superseded_by`, `wikilink`, `fact`, `mention`). */
  readonly relation_types?: readonly string[];
  /** Data da validade (padrão: hoje). */
  readonly as_of?: string;
  /** Máximo de vizinhos (padrão 50, máximo 200). */
  readonly limit?: number;
  /** Orçamento aproximado de tokens da resposta (padrão 3000). */
  readonly budget_tokens?: number;
}

export interface GraphNeighborOutput extends GraphNodeOutput {
  /** 1: ligado direto à nota; 2: ligado a um vizinho de distância 1. */
  readonly distance: number;
  readonly links: readonly GraphLinkOutput[];
}

export interface GraphOutput extends DataEnvelope {
  readonly node: GraphNodeOutput;
  /** Como `node` foi resolvido: `id`, `path`, `link` (nome do arquivo), `title` ou `alias`. */
  readonly resolved_by: NodeMatch;
  readonly as_of: string;
  readonly depth: 1 | 2;
  readonly relation_types: readonly string[] | null;
  /** Mais perto primeiro; na mesma distância, os vigentes e os mais ligados primeiro. */
  readonly neighbors: readonly GraphNeighborOutput[];
  /** Vizinhos achados (antes do corte por `limit` e orçamento). */
  readonly total: number;
  /** Algum vizinho ficou de fora (limite, orçamento ou teto da consulta). */
  readonly truncated: boolean;
  readonly omitted: number;
  readonly next_step?: string;
}

const VALIDITY_RANK: Readonly<Record<Validity, number>> = { current: 0, not_yet_valid: 1, expired: 2 };

export async function graph(ctx: BrainContext, input: GraphInput): Promise<GraphOutput> {
  const ref = requireRef(input?.node, 'node');
  const depthValue = optionalInt(input.depth, 'depth', 1, 2) ?? 1;
  const depth: 1 | 2 = depthValue === 2 ? 2 : 1;
  const asOf = parseAsOf(ctx, input.as_of);
  const limit = optionalInt(input.limit, 'limit', 1, MAX_GRAPH_LIMIT) ?? DEFAULT_GRAPH_LIMIT;
  const budget = optionalInt(input.budget_tokens, 'budget_tokens', 1, 1_000_000) ?? DEFAULT_GRAPH_BUDGET_TOKENS;
  const filters = edgeFilters(input.relation_types, ctx.config);
  const kinds = input.relation_types === undefined ? null : [...new Set(input.relation_types)];

  const { center, by, hood } = await withFreshIndex(ctx, () => {
    const found = resolveOrThrow(ctx, ref, 'node');
    return {
      center: found.note,
      by: found.by,
      hood: neighborhood(ctx.index, {
        start: found.note.id,
        depth,
        asOf,
        ...(filters === undefined ? {} : { filters }),
      }),
    };
  });

  const pathOf = (id: string): string => hood.notes.get(id)?.path ?? id;
  const linksOf = new Map<string, GraphEdgeRow[]>();
  for (const edge of hood.edges) {
    // a ponta mais longe da consulta é o vizinho que a aresta explica
    const far =
      (hood.distance.get(edge.src) ?? 0) > (hood.distance.get(edge.dst) ?? 0) || edge.dst === center.id
        ? edge.src
        : edge.dst;
    const list = linksOf.get(far) ?? [];
    list.push(edge);
    linksOf.set(far, list);
  }
  const strength = (id: string): number =>
    (linksOf.get(id) ?? []).reduce((sum, edge) => sum + originWeight(edge.origin), 0);
  const order = [...hood.distance.entries()]
    .filter(([id]) => hood.notes.has(id))
    .sort(
      ([a, da], [b, db]) =>
        da - db ||
        VALIDITY_RANK[(hood.notes.get(a) as GraphNoteRow).validity] -
          VALIDITY_RANK[(hood.notes.get(b) as GraphNoteRow).validity] ||
        strength(b) - strength(a) ||
        (pathOf(a) < pathOf(b) ? -1 : 1),
    );

  const centerRow = hood.notes.get(center.id);
  const node: GraphNodeOutput =
    centerRow === undefined
      ? {
          id: center.id,
          path: center.path,
          title: center.title,
          type: center.type,
          scope: center.scope,
          validity: 'current',
          trust: center.trust,
          origin: center.origin,
          edited_by: editedByOf(center.frontmatter),
        }
      : nodeOutput(centerRow);
  let used = costOf({ data_notice: DATA_NOTICE, node, as_of: asOf, depth, relation_types: kinds, total: 0 }) + 20;
  const neighbors: GraphNeighborOutput[] = [];
  let truncated = hood.capped;
  for (const [id, distance] of order) {
    if (neighbors.length >= limit) {
      truncated = true;
      break;
    }
    const row = hood.notes.get(id) as GraphNoteRow;
    const links = [...(linksOf.get(id) ?? [])]
      .sort(
        (a, b) =>
          VALIDITY_RANK[a.validity] - VALIDITY_RANK[b.validity] ||
          originWeight(b.origin) - originWeight(a.origin) ||
          (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
      )
      .slice(0, MAX_LINKS_PER_NEIGHBOR)
      .map(
        (edge): GraphLinkOutput => ({
          from: pathOf(edge.src),
          to: pathOf(edge.dst),
          type: edge.type,
          origin: edge.origin,
          direction: edge.dst === id ? 'out' : 'in',
          validity: edge.validity,
        }),
      );
    const item: GraphNeighborOutput = { ...nodeOutput(row), distance, links };
    const cost = costOf(item);
    if (used + cost > budget) {
      truncated = true;
      break;
    }
    used += cost;
    neighbors.push(item);
  }
  const total = order.length;
  const omitted = total - neighbors.length;
  const steps: string[] = [];
  if (total === 0) steps.push('A nota não tem vizinhos com esses filtros. Tente sem relation_types ou com depth 2.');
  if (truncated) {
    steps.push(
      'A resposta foi cortada: filtre por relation_types, aumente budget_tokens ou consulte um vizinho direto.',
    );
  }
  return {
    data_notice: DATA_NOTICE,
    node,
    resolved_by: by,
    as_of: asOf,
    depth,
    relation_types: kinds,
    neighbors,
    total,
    truncated: truncated || omitted > 0,
    omitted,
    ...(steps.length === 0 ? {} : { next_step: steps.join(' ') }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// facts

export const DEFAULT_FACTS_LIMIT = 50;
export const MAX_FACTS_LIMIT = 200;
/** Corpo de um fato maior que isto sai cortado (`content_kind: 'excerpt'`). */
export const FACT_CONTENT_MAX_CHARS = 600;
const PREDICATE_RE = /^[a-z][a-z0-9_]*$/;

export interface FactsInput {
  /** Título, caminho, wikilink ou id da nota do sujeito; sem nota, compara com o texto do sujeito. */
  readonly subject?: string;
  readonly predicate?: string;
  /** Como `subject`; o objeto também pode ser um valor simples. */
  readonly object?: string;
  readonly as_of?: string;
  readonly limit?: number;
}

export interface FactItem extends DataItem {
  readonly subject: string | null;
  /** Nota do sujeito, se o sujeito é um link que resolve. */
  readonly subject_path: string | null;
  readonly predicate: string | null;
  readonly object: string | null;
  readonly object_path: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  /** Data em que outro fato passou a substituir este (pelo encadeamento), se houver. */
  readonly superseded_on: string | null;
  /** Fatos (ou notas) que este substitui (caminhos). */
  readonly supersedes: readonly string[];
  /** Fatos (ou notas) que substituem este (caminhos). */
  readonly superseded_by: readonly string[];
}

export interface FactRefOutput {
  /** Como veio no pedido. */
  readonly query: string;
  /** Nota a que o pedido corresponde, ou `null` (aí a comparação é com o texto do fato). */
  readonly path: string | null;
}

export interface FactsOutput extends DataEnvelope {
  readonly as_of: string;
  readonly subject: FactRefOutput | null;
  readonly predicate: string | null;
  readonly object: FactRefOutput | null;
  /** Vigentes, depois ainda não vigentes, depois vencidos; os mais recentes primeiro. Nenhum é escondido. */
  readonly facts: readonly FactItem[];
  readonly total: number;
  readonly truncated: boolean;
  readonly next_step?: string;
}

function optionalRef(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : requireRef(value, name);
}

export async function facts(ctx: BrainContext, input: FactsInput = {}): Promise<FactsOutput> {
  if (typeof input !== 'object' || input === null)
    throw invalid('facts precisa de um objeto (todos os campos opcionais)');
  const subject = optionalRef(input.subject, 'subject');
  const object = optionalRef(input.object, 'object');
  let predicate: string | undefined;
  if (input.predicate !== undefined && input.predicate !== null) {
    if (typeof input.predicate !== 'string' || input.predicate.length > 200 || !PREDICATE_RE.test(input.predicate)) {
      throw invalid('"predicate" deveria ser um identificador em minúsculas, como "uses_queue"');
    }
    predicate = input.predicate;
  }
  const asOf = parseAsOf(ctx, input.as_of);
  const limit = optionalInt(input.limit, 'limit', 1, MAX_FACTS_LIMIT) ?? DEFAULT_FACTS_LIMIT;

  const found = await withFreshIndex(ctx, () => {
    const side = (ref: string | undefined, name: string) => {
      if (ref === undefined) return { id: undefined, text: undefined, path: null };
      const resolved = resolveNodeRef(ctx.index, ref);
      if (resolved.kind === 'ambiguous') resolveOrThrow(ctx, ref, name); // lança com os candidatos
      return resolved.kind === 'found'
        ? { id: resolved.note.id, text: undefined, path: resolved.note.path }
        : { id: undefined, text: ref.replace(/^\[\[|\]\]$/g, ''), path: null };
    };
    const s = side(subject, 'subject');
    const o = side(object, 'object');
    const rows = queryFacts(ctx.index, {
      asOf,
      ...(s.id === undefined ? {} : { subjectId: s.id }),
      ...(s.text === undefined ? {} : { subjectText: s.text }),
      ...(o.id === undefined ? {} : { objectId: o.id }),
      ...(o.text === undefined ? {} : { objectText: o.text }),
      ...(predicate === undefined ? {} : { predicate }),
    });
    const shown = rows.slice(0, limit);
    return {
      s,
      o,
      rows,
      shown,
      bodies: indexedBodies(
        ctx.index,
        shown.map((row) => row.noteId),
      ),
    };
  });

  const items = found.shown.map((row): FactItem => {
    const body = (found.bodies.get(row.noteId) ?? '').trim();
    const cut = body.length > FACT_CONTENT_MAX_CHARS;
    const base = dataItem(
      {
        id: row.noteId,
        path: row.path,
        type: 'fact',
        title: row.title,
        scope: row.scope,
        trust: row.trust,
        origin: row.origin,
        frontmatter: row.frontmatter,
      },
      row.validity,
      cut ? 'excerpt' : 'note',
      cut ? `${body.slice(0, FACT_CONTENT_MAX_CHARS).trimEnd()}…` : body,
    );
    return {
      ...base,
      subject: row.subject,
      subject_path: row.subjectNote?.path ?? null,
      predicate: row.predicate,
      object: row.object,
      object_path: row.objectNote?.path ?? null,
      valid_from: row.validFrom,
      valid_until: row.validUntil,
      superseded_on: row.supersededOn,
      supersedes: row.supersedes.map((ref) => ref.path),
      superseded_by: row.supersededBy.map((ref) => ref.path),
    };
  });
  const truncated = found.rows.length > items.length;
  const steps: string[] = [];
  if (items.length === 0) {
    steps.push('Nenhum fato com esses filtros. Tente sem predicate, ou use search para achar o assunto.');
  }
  if (truncated) steps.push('Há mais fatos: aumente limit ou filtre por subject, predicate ou object.');
  return {
    data_notice: DATA_NOTICE,
    as_of: asOf,
    subject: subject === undefined ? null : { query: subject, path: found.s.path },
    predicate: predicate ?? null,
    object: object === undefined ? null : { query: object, path: found.o.path },
    facts: items,
    total: found.rows.length,
    truncated,
    ...(steps.length === 0 ? {} : { next_step: steps.join(' ') }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// related (bloco da busca)

/** Vizinhos mostrados no máximo no bloco `related` (doc 06: "5 vizinhos dos melhores resultados"). */
export const RELATED_LIMIT = 5;
/** Quantos dos melhores resultados servem de ponto de partida do `related`. */
export const RELATED_SEEDS = 5;

export interface RelatedReason {
  /** O resultado da busca a partir do qual o vizinho foi achado (caminho). */
  readonly from: string;
  readonly type: string;
  readonly origin: string;
  /** `out`: a relação sai do resultado para o vizinho; `in`: sai do vizinho para o resultado. */
  readonly direction: 'out' | 'in';
  readonly validity: Validity;
}

export interface RelatedOutput extends GraphNodeOutput {
  /** Maior é mais ligado aos melhores resultados (não é comparável com o `score` dos hits). */
  readonly score: number;
  /** Por que entrou: por qual relação, a partir de qual resultado (até 3). */
  readonly reasons: readonly RelatedReason[];
}

/**
 * Bloco `related`: até 5 vizinhos dos melhores resultados, fora do ranking (`hits` não muda de ordem), sem menções,
 * na validade de `asOf`. Chamar com o banco já atualizado (dentro de `withFreshIndex`).
 */
export function relatedBlock(
  ctx: BrainContext,
  hits: readonly { readonly id: string; readonly path: string }[],
  asOf: string,
): RelatedOutput[] {
  if (hits.length === 0) return [];
  const pathOf = new Map(hits.map((hit) => [hit.id, hit.path]));
  return relatedCandidates(ctx.index, {
    seeds: hits.slice(0, RELATED_SEEDS).map((hit) => hit.id),
    exclude: new Set(hits.map((hit) => hit.id)),
    asOf,
    limit: RELATED_LIMIT,
  }).map((candidate) => ({
    ...nodeOutput(candidate.note),
    score: candidate.score,
    reasons: candidate.via.slice(0, 3).map((edge) => ({
      from: pathOf.get(edge.seed) ?? edge.seed,
      type: edge.type,
      origin: edge.origin,
      direction: edge.src === edge.seed ? 'out' : 'in',
      validity: edge.validity,
    })),
  }));
}
