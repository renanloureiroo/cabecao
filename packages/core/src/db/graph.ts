// Grafo das notas no SQLite (doc 06, "Grafo"): vizinhos de uma nota por consulta recursiva, até 2 saltos, com o
// tipo, a origem e a direção de cada aresta e a validade na data pedida (`as_of`). Também o bloco `related` da
// busca: vizinhos dos melhores resultados, SEPARADO do ranking (o spike 12 mediu que misturar o grafo no ranking
// derruba a busca por termo exato de 83% para 72–78%).
//
// Limites: a recursão para em `MAX_WALK_ROWS` linhas, e quem chama corta a resposta por orçamento de tokens. Todo
// valor vindo de fora entra por parâmetro (`?`), nunca concatenado no SQL.
import type { SQLInputValue } from 'node:sqlite';
import type { EdgeOrigin } from './extract.ts';
import type { LocalIndex } from './open.ts';
import { connection } from './open.ts';
import type { Validity } from './search.ts';
import { validityOf } from './search.ts';

/** Linhas que a consulta recursiva gera no máximo: um nó com milhares de vizinhos não estoura memória nem tempo. */
export const MAX_WALK_ROWS = 5000;
/** Arestas lidas no máximo entre os nós achados (para dizer como cada vizinho se liga). */
export const MAX_GRAPH_EDGE_ROWS = 20_000;

/** Filtro de aresta: a origem e, opcionalmente, o tipo (`relation` + `uses`; `mention`; `supersedes` + `supersedes`). */
export interface EdgeFilter {
  readonly origin: EdgeOrigin;
  readonly type?: string;
}

/** Uma nota do grafo, com o que decide a validade e a proveniência. */
export interface GraphNoteRow {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly scope: string | null;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly archived: boolean;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly validity: Validity;
}

/** Uma aresta entre duas notas, com a validade (a da nota de origem, de onde a aresta vem) na data pedida. */
export interface GraphEdgeRow {
  readonly src: string;
  readonly dst: string;
  readonly origin: EdgeOrigin;
  readonly type: string;
  readonly validity: Validity;
}

export interface NeighborhoodOptions {
  readonly start: string;
  readonly depth: 1 | 2;
  /** Sem filtro (ou lista vazia): todas as arestas. */
  readonly filters?: readonly EdgeFilter[];
  /** Data da validade (`AAAA-MM-DD`). */
  readonly asOf: string;
  /** Deixa as menções sem link de fora (o `related` da busca). Padrão: incluídas. */
  readonly excludeMentions?: boolean;
  /** Teto de linhas da recursão (testes). Padrão: `MAX_WALK_ROWS`. */
  readonly maxRows?: number;
}

export interface Neighborhood {
  /** Distância de cada vizinho (1 ou 2), sem o nó de partida. */
  readonly distance: ReadonlyMap<string, number>;
  readonly notes: ReadonlyMap<string, GraphNoteRow>;
  /** Arestas entre nós de distâncias vizinhas (partida–1, 1–2), já filtradas. */
  readonly edges: readonly GraphEdgeRow[];
  /** A recursão bateu no teto: pode haver vizinhos que não foram vistos. */
  readonly capped: boolean;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function parseObject(json: unknown): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(json));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Cláusula SQL do filtro de arestas (só `?`) e os parâmetros, na ordem. */
function filterClause(
  alias: string,
  filters: readonly EdgeFilter[] | undefined,
  excludeMentions: boolean,
): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (filters !== undefined && filters.length > 0) {
    const ors = filters.map((filter) => {
      params.push(filter.origin);
      if (filter.type === undefined) return `${alias}.origin = ?`;
      params.push(filter.type);
      return `(${alias}.origin = ? and ${alias}.type = ?)`;
    });
    parts.push(`(${ors.join(' or ')})`);
  }
  if (excludeMentions) parts.push(`${alias}.origin <> 'mention'`);
  return { sql: parts.map((part) => ` and ${part}`).join(''), params };
}

/** Notas pelos ids (via `json_each`, sem montar lista no SQL), com a validade em `asOf`. */
export function graphNotes(index: LocalIndex, ids: readonly string[], asOf: string): Map<string, GraphNoteRow> {
  const out = new Map<string, GraphNoteRow>();
  if (ids.length === 0) return out;
  const rows = connection(index)
    .prepare(
      `select n.id, n.path, n.title, n.type, n.scope, n.trust, n.origin, n.archived, n.frontmatter, n.valid_from,
         n.valid_until, n.expires_at, n.superseded_on
       from notes n where n.id in (select value from json_each(?))`,
    )
    .all(JSON.stringify(ids));
  for (const row of rows) {
    out.set(String(row.id), {
      id: String(row.id),
      path: String(row.path),
      title: text(row.title),
      type: text(row.type),
      scope: text(row.scope),
      trust: text(row.trust),
      origin: text(row.origin),
      archived: Number(row.archived) === 1,
      frontmatter: parseObject(row.frontmatter),
      validity: validityOf(
        {
          validFrom: text(row.valid_from),
          validUntil: text(row.valid_until),
          expiresAt: text(row.expires_at),
          supersededOn: text(row.superseded_on),
        },
        asOf,
      ),
    });
  }
  return out;
}

/**
 * Vizinhança de `start` até `depth` saltos, nas duas direções, por uma CTE recursiva. Notas arquivadas e cópias de
 * conflito não entram como vizinhas (nem servem de ponte). A aresta de uma nota para ela mesma e a aresta quebrada
 * (sem destino) não contam.
 */
export function neighborhood(index: LocalIndex, options: NeighborhoodOptions): Neighborhood {
  const db = connection(index);
  const depth = options.depth === 2 ? 2 : 1;
  const cap = Math.max(1, Math.min(MAX_WALK_ROWS, Math.trunc(options.maxRows ?? MAX_WALK_ROWS)));
  const filter = filterClause('e', options.filters, options.excludeMentions === true);
  const live = (alias: string): string => `${alias}.archived = 0 and ${alias}.conflict_of is null`;
  // duas partes recursivas (seguindo a aresta e voltando por ela); UNION tira as repetições de (nó, distância)
  const walkSql = `
    with recursive walk(node, depth) as (
      select ?, 0
      union
      select e.dst_note, w.depth + 1 from walk w
        join edges e on e.src_note = w.node
        join notes d on d.id = e.dst_note
        where w.depth < ? and e.dst_note <> e.src_note and ${live('d')}${filter.sql}
      union
      select e.src_note, w.depth + 1 from walk w
        join edges e on e.dst_note = w.node
        join notes s on s.id = e.src_note
        where w.depth < ? and e.dst_note <> e.src_note and ${live('s')}${filter.sql}
      limit ?
    )
    select node, min(depth) as distance, count(*) as n from walk group by node`;
  const walkRows = db.prepare(walkSql).all(options.start, depth, ...filter.params, depth, ...filter.params, cap);
  let generated = 0;
  const distance = new Map<string, number>();
  for (const row of walkRows) {
    generated += Number(row.n);
    const node = String(row.node);
    if (node === options.start) continue;
    distance.set(node, Number(row.distance));
  }
  const capped = generated >= cap;

  const all = [options.start, ...distance.keys()];
  const notes = graphNotes(index, all, options.asOf);
  const edgeFilter = filterClause('e', options.filters, options.excludeMentions === true);
  const edgeRows = db
    .prepare(
      `select e.src_note, e.dst_note, e.origin, e.type, e.valid_from, e.valid_until, s.expires_at, s.superseded_on
       from edges e join notes s on s.id = e.src_note
       where e.src_note in (select value from json_each(?)) and e.dst_note in (select value from json_each(?))
         and e.dst_note <> e.src_note${edgeFilter.sql}
       order by e.id limit ?`,
    )
    .all(JSON.stringify(all), JSON.stringify(all), ...edgeFilter.params, MAX_GRAPH_EDGE_ROWS);
  const level = (id: string): number => (id === options.start ? 0 : (distance.get(id) ?? -1));
  const edges: GraphEdgeRow[] = [];
  for (const row of edgeRows) {
    const src = String(row.src_note);
    const dst = String(row.dst_note);
    if (Math.abs(level(src) - level(dst)) !== 1) continue; // só as arestas do caminho (partida–1, 1–2)
    edges.push({
      src,
      dst,
      origin: String(row.origin) as EdgeOrigin,
      type: String(row.type),
      validity: validityOf(
        {
          validFrom: text(row.valid_from),
          validUntil: text(row.valid_until),
          expiresAt: text(row.expires_at),
          supersededOn: text(row.superseded_on),
        },
        options.asOf,
      ),
    });
  }
  return { distance, notes, edges, capped };
}

/** Peso de cada origem de aresta no `related`: relação tipada e fato pesam mais que um link solto no texto. */
const ORIGIN_WEIGHT: Readonly<Record<string, number>> = {
  relation: 1,
  fact: 1,
  supersedes: 0.8,
  wikilink: 0.6,
  mention: 0.3,
};

export function originWeight(origin: string): number {
  return ORIGIN_WEIGHT[origin] ?? 0.5;
}

/** Um vizinho candidato ao `related`, com as arestas que o ligam aos resultados. */
export interface RelatedCandidate {
  readonly note: GraphNoteRow;
  readonly score: number;
  /** Arestas entre o vizinho e um resultado (`seed`), da mais forte para a mais fraca. */
  readonly via: readonly (GraphEdgeRow & { readonly seed: string })[];
}

export interface RelatedOptions {
  /** Ids dos melhores resultados, do melhor para o pior. */
  readonly seeds: readonly string[];
  /** Ids que não podem aparecer (todos os resultados da busca). */
  readonly exclude: ReadonlySet<string>;
  readonly asOf: string;
  readonly limit: number;
}

/** Fator de um vizinho (ou de uma aresta) que não vale na data: rebaixado, como na busca. */
const NOT_CURRENT_FACTOR = 0.5;

/**
 * Vizinhos de 1 salto dos `seeds`, sem menções (o spike mediu que o dicionário não acrescenta nada na expansão:
 * 0,60 contra 0,61 só com wikilinks), sem os próprios resultados, sem arquivadas e cópias de conflito. Pontuação:
 * soma, por aresta, do peso da origem × 1/(posição do resultado + 1), com o vizinho ou a aresta que não vale na
 * data rebaixados. Empate: caminho.
 */
export function relatedCandidates(index: LocalIndex, options: RelatedOptions): RelatedCandidate[] {
  if (options.seeds.length === 0 || options.limit < 1) return [];
  const rank = new Map(options.seeds.map((id, i) => [id, i]));
  const rows = connection(index)
    .prepare(
      `select e.src_note, e.dst_note, e.origin, e.type, e.valid_from, e.valid_until, s.expires_at, s.superseded_on
       from edges e
         join notes s on s.id = e.src_note
         join notes d on d.id = e.dst_note
       where (e.src_note in (select value from json_each(?)) or e.dst_note in (select value from json_each(?)))
         and e.dst_note <> e.src_note and e.origin <> 'mention'
         and s.archived = 0 and s.conflict_of is null and d.archived = 0 and d.conflict_of is null
       order by e.id limit ?`,
    )
    .all(JSON.stringify(options.seeds), JSON.stringify(options.seeds), MAX_GRAPH_EDGE_ROWS);
  const found = new Map<string, { score: number; via: (GraphEdgeRow & { seed: string })[] }>();
  for (const row of rows) {
    const src = String(row.src_note);
    const dst = String(row.dst_note);
    const seed = rank.has(src) ? src : dst;
    const other = seed === src ? dst : src;
    if (options.exclude.has(other) || rank.has(other)) continue;
    const edge: GraphEdgeRow & { seed: string } = {
      src,
      dst,
      origin: String(row.origin) as EdgeOrigin,
      type: String(row.type),
      seed,
      validity: validityOf(
        {
          validFrom: text(row.valid_from),
          validUntil: text(row.valid_until),
          expiresAt: text(row.expires_at),
          supersededOn: text(row.superseded_on),
        },
        options.asOf,
      ),
    };
    const weight =
      (originWeight(edge.origin) * (edge.validity === 'current' ? 1 : NOT_CURRENT_FACTOR)) /
      ((rank.get(seed) ?? 0) + 1);
    const entry = found.get(other) ?? { score: 0, via: [] };
    entry.score += weight;
    entry.via.push(edge);
    found.set(other, entry);
  }
  const notes = graphNotes(index, [...found.keys()], options.asOf);
  const out: RelatedCandidate[] = [];
  for (const [id, entry] of found) {
    const note = notes.get(id);
    if (note === undefined) continue;
    const score = entry.score * (note.validity === 'current' ? 1 : NOT_CURRENT_FACTOR);
    const via = [...entry.via].sort(
      (a, b) =>
        (rank.get(a.seed) ?? 0) - (rank.get(b.seed) ?? 0) ||
        originWeight(b.origin) - originWeight(a.origin) ||
        (a.validity === 'current' ? 0 : 1) - (b.validity === 'current' ? 0 : 1),
    );
    out.push({ note, score: Math.round(score * 10_000) / 10_000, via });
  }
  out.sort((a, b) => b.score - a.score || (a.note.path < b.note.path ? -1 : 1));
  return out.slice(0, options.limit);
}
