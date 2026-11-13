// Fatos atômicos (doc 03, "Fatos atômicos"; tool `facts` do doc 05): consulta por sujeito, predicado e objeto, com
// a validade numa data e o encadeamento `supersedes` / `superseded_by` (nos dois sentidos: a nota nova que diz
// `supersedes: [[antiga]]` e a antiga que diz `superseded_by: [[nova]]` contam igual).
import type { SQLInputValue } from 'node:sqlite';
import { nameKey } from './mentions.ts';
import type { LocalIndex } from './open.ts';
import { connection } from './open.ts';
import type { Validity } from './search.ts';
import { validityOf } from './search.ts';

export interface FactQuery {
  /** Nota do sujeito (já resolvida). */
  readonly subjectId?: string;
  /** Sem nota resolvida: o texto do sujeito, comparado sem maiúsculas nem acentos. */
  readonly subjectText?: string;
  readonly predicate?: string;
  readonly objectId?: string;
  readonly objectText?: string;
  readonly asOf: string;
  /** Inclui fatos arquivados. Padrão: não. */
  readonly includeArchived?: boolean;
}

export interface NoteRefRow {
  readonly id: string;
  readonly path: string;
}

export interface FactRow {
  readonly noteId: string;
  readonly path: string;
  readonly title: string | null;
  readonly subject: string | null;
  readonly subjectNote: NoteRefRow | null;
  readonly predicate: string | null;
  readonly object: string | null;
  readonly objectNote: NoteRefRow | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly supersededOn: string | null;
  readonly validity: Validity;
  readonly scope: string | null;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly supersedes: readonly NoteRefRow[];
  readonly supersededBy: readonly NoteRefRow[];
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

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const VALIDITY_ORDER: Readonly<Record<Validity, number>> = { current: 0, not_yet_valid: 1, expired: 2 };

/**
 * Encadeamento de versões das notas `ids`: quem cada uma substitui e por quem foi substituída, juntando os dois
 * lados da relação. Cópias de conflito ficam de fora.
 */
export function supersedeChains(
  index: LocalIndex,
  ids: readonly string[],
): Map<string, { supersedes: NoteRefRow[]; supersededBy: NoteRefRow[] }> {
  const out = new Map<string, { supersedes: NoteRefRow[]; supersededBy: NoteRefRow[] }>();
  for (const id of ids) out.set(id, { supersedes: [], supersededBy: [] });
  if (ids.length === 0) return out;
  const rows = connection(index)
    .prepare(
      `select e.src_note, e.dst_note, e.type, s.path as src_path, d.path as dst_path
       from edges e join notes s on s.id = e.src_note join notes d on d.id = e.dst_note
       where e.origin = 'supersedes' and e.src_note <> e.dst_note
         and s.conflict_of is null and d.conflict_of is null
         and (e.src_note in (select value from json_each(?)) or e.dst_note in (select value from json_each(?)))
       order by e.id`,
    )
    .all(JSON.stringify(ids), JSON.stringify(ids));
  const add = (list: NoteRefRow[], ref: NoteRefRow): void => {
    if (!list.some((item) => item.id === ref.id)) list.push(ref);
  };
  for (const row of rows) {
    const src = { id: String(row.src_note), path: String(row.src_path) };
    const dst = { id: String(row.dst_note), path: String(row.dst_path) };
    // `src supersedes dst` (nova → antiga) ou `src superseded_by dst` (antiga → nova)
    const [newer, older] = row.type === 'superseded_by' ? [dst, src] : [src, dst];
    const ofNewer = out.get(newer.id);
    if (ofNewer !== undefined) add(ofNewer.supersedes, older);
    const ofOlder = out.get(older.id);
    if (ofOlder !== undefined) add(ofOlder.supersededBy, newer);
  }
  return out;
}

/**
 * Fatos que atendem aos filtros, com a validade em `asOf`. Ordem: vigentes, depois ainda não vigentes, depois
 * vencidos; dentro de cada grupo, `valid_from` mais recente primeiro e o caminho no empate.
 */
export function queryFacts(index: LocalIndex, query: FactQuery): FactRow[] {
  const filters: string[] = [];
  const params: SQLInputValue[] = [];
  if (query.includeArchived !== true) filters.push('n.archived = 0');
  filters.push('n.conflict_of is null');
  if (query.subjectId !== undefined) {
    filters.push('f.subject_note = ?');
    params.push(query.subjectId);
  }
  if (query.objectId !== undefined) {
    filters.push('f.object_note = ?');
    params.push(query.objectId);
  }
  if (query.predicate !== undefined) {
    filters.push('f.predicate = ?');
    params.push(query.predicate);
  }
  const rows = connection(index)
    .prepare(
      `select f.note_id, n.path, n.title, f.subject, f.predicate, f.object, f.subject_note, sn.path as subject_path,
         f.object_note, obn.path as object_path, n.valid_from, n.valid_until, n.expires_at, n.superseded_on,
         n.scope, n.trust, n.origin, n.frontmatter
       from facts f
         join notes n on n.id = f.note_id
         left join notes sn on sn.id = f.subject_note
         left join notes obn on obn.id = f.object_note
       where ${filters.join(' and ')}`,
    )
    .all(...params);
  const subjectKey = query.subjectText === undefined ? null : nameKey(query.subjectText);
  const objectKey = query.objectText === undefined ? null : nameKey(query.objectText);
  const picked = rows.filter(
    (row) =>
      (subjectKey === null || nameKey(String(row.subject ?? '')) === subjectKey) &&
      (objectKey === null || nameKey(String(row.object ?? '')) === objectKey),
  );
  const chains = supersedeChains(
    index,
    picked.map((row) => String(row.note_id)),
  );
  const facts = picked.map((row): FactRow => {
    const id = String(row.note_id);
    const validFrom = text(row.valid_from);
    const validUntil = text(row.valid_until);
    const supersededOn = text(row.superseded_on);
    const chain = chains.get(id);
    return {
      noteId: id,
      path: String(row.path),
      title: text(row.title),
      subject: text(row.subject),
      subjectNote: row.subject_note === null ? null : { id: String(row.subject_note), path: String(row.subject_path) },
      predicate: text(row.predicate),
      object: text(row.object),
      objectNote: row.object_note === null ? null : { id: String(row.object_note), path: String(row.object_path) },
      validFrom,
      validUntil,
      supersededOn,
      validity: validityOf({ validFrom, validUntil, expiresAt: text(row.expires_at), supersededOn }, query.asOf),
      scope: text(row.scope),
      trust: text(row.trust),
      origin: text(row.origin),
      frontmatter: parseObject(row.frontmatter),
      supersedes: chain?.supersedes ?? [],
      supersededBy: chain?.supersededBy ?? [],
    };
  });
  return facts.sort(
    (a, b) =>
      VALIDITY_ORDER[a.validity] - VALIDITY_ORDER[b.validity] ||
      compareText(b.validFrom ?? '', a.validFrom ?? '') ||
      compareText(a.path, b.path),
  );
}

/** Corpo indexado de cada nota (os trechos juntos, na ordem), para mostrar o texto de um fato sem ler o disco. */
export function indexedBodies(index: LocalIndex, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = connection(index)
    .prepare(`select note_id, text from chunks where note_id in (select value from json_each(?)) order by note_id, ord`)
    .all(JSON.stringify(ids));
  for (const row of rows) {
    const id = String(row.note_id);
    const current = out.get(id);
    out.set(id, current === undefined ? String(row.text) : `${current}\n\n${String(row.text)}`);
  }
  return out;
}
