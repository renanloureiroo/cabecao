// Recorte do grafo para os mapas (`cabecao export canvas`): as notas de um escopo, do cérebro inteiro ou da vizinhança
// de uma nota, e TODAS as arestas entre elas (o `graph` mostra só o caminho até cada vizinho). Sem menções (seriam
// ruído num mapa), sem notas arquivadas e sem cópias de conflito.
import { neighborhood } from './graph.ts';
import type { LocalIndex } from './open.ts';
import { connection } from './open.ts';

export interface SubgraphNote {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly scope: string | null;
  /** Distância até a nota de partida (0 = ela); ausente fora do modo vizinhança. */
  readonly distance?: number;
}

export interface SubgraphEdge {
  readonly src: string;
  readonly dst: string;
  readonly origin: string;
  readonly type: string;
}

export interface SubgraphOptions {
  /** Id da nota de partida (modo vizinhança). */
  readonly start?: string;
  readonly depth?: 1 | 2;
  /** Só notas deste escopo, exatamente (`global` ou `project:<nome>`). */
  readonly scope?: string;
  /** Máximo de notas; as que sobram saem (as mais longe e as menos ligadas primeiro). */
  readonly limit: number;
  readonly asOf: string;
}

export interface SubgraphResult {
  readonly notes: readonly SubgraphNote[];
  readonly edges: readonly SubgraphEdge[];
  /** Notas achadas antes do corte por `limit`. */
  readonly total: number;
  /** A vizinhança bateu no teto da consulta recursiva. */
  readonly capped: boolean;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function edgesAmong(index: LocalIndex, ids: readonly string[]): SubgraphEdge[] {
  if (ids.length === 0) return [];
  const list = JSON.stringify(ids);
  return connection(index)
    .prepare(
      `select src_note, dst_note, origin, type from edges
       where origin <> 'mention' and dst_note is not null and src_note <> dst_note
         and src_note in (select value from json_each(?)) and dst_note in (select value from json_each(?))`,
    )
    .all(list, list)
    .map((row) => ({
      src: String(row.src_note),
      dst: String(row.dst_note),
      origin: String(row.origin),
      type: String(row.type),
    }));
}

export function subgraph(index: LocalIndex, options: SubgraphOptions): SubgraphResult {
  const db = connection(index);
  let notes: SubgraphNote[];
  let capped = false;
  const rowNote = (row: Record<string, unknown>, distance?: number): SubgraphNote => ({
    id: String(row.id),
    path: String(row.path),
    title: text(row.title),
    type: text(row.type),
    scope: text(row.scope),
    ...(distance === undefined ? {} : { distance }),
  });
  if (options.start !== undefined) {
    const hood = neighborhood(index, {
      start: options.start,
      depth: options.depth ?? 1,
      asOf: options.asOf,
      excludeMentions: true,
    });
    capped = hood.capped;
    const distances = new Map<string, number>([[options.start, 0], ...hood.distance]);
    const rows = db
      .prepare(
        `select id, path, title, type, scope from notes
         where id in (select value from json_each(?)) and conflict_of is null and (archived = 0 or id = ?)`,
      )
      .all(JSON.stringify([...distances.keys()]), options.start);
    notes = rows.map((row) => rowNote(row, distances.get(String(row.id)) ?? 0));
  } else {
    const rows =
      options.scope === undefined
        ? db.prepare('select id, path, title, type, scope from notes where archived = 0 and conflict_of is null').all()
        : db
            .prepare(
              'select id, path, title, type, scope from notes where archived = 0 and conflict_of is null and scope = ?',
            )
            .all(options.scope);
    notes = rows.map((row) => rowNote(row));
  }

  const total = notes.length;
  if (notes.length > options.limit) {
    const degree = new Map<string, number>();
    for (const edge of edgesAmong(
      index,
      notes.map((note) => note.id),
    )) {
      degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1);
      degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1);
    }
    notes = [...notes]
      .sort(
        (a, b) =>
          (a.distance ?? 0) - (b.distance ?? 0) ||
          (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
          compare(a.path, b.path),
      )
      .slice(0, options.limit);
  }
  notes.sort((a, b) => compare(a.path, b.path));

  const edges = edgesAmong(
    index,
    notes.map((note) => note.id),
  );
  // o mesmo par ligado por uma relação tipada não repete o wikilink do frontmatter, e `superseded_by` não repete o
  // `supersedes` do outro lado
  const typed = new Set(edges.filter((edge) => edge.origin !== 'wikilink').map((edge) => `${edge.src}\0${edge.dst}`));
  const supersedes = new Set(
    edges.filter((edge) => edge.type === 'supersedes').map((edge) => `${edge.src}\0${edge.dst}`),
  );
  const kept = edges
    .filter((edge) => edge.origin !== 'wikilink' || !typed.has(`${edge.src}\0${edge.dst}`))
    .filter((edge) => edge.type !== 'superseded_by' || !supersedes.has(`${edge.dst}\0${edge.src}`))
    .sort((a, b) => compare(a.src, b.src) || compare(a.dst, b.dst) || compare(a.type, b.type));
  return { notes, edges: kept, total, capped };
}
