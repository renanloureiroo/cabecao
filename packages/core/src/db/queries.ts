// Consultas de apoio às tools `read`, `recall` e `status` (docs/05-mcp.md).
import type { SQLInputValue } from 'node:sqlite';
import { normalizeRelPath } from '../vault/index.ts';
import type { EdgeOrigin } from './extract.ts';
import type { LocalIndex } from './open.ts';
import { connection } from './open.ts';
import { INDEX_SCHEMA_VERSION, STATE_KEYS } from './schema.ts';

/** Uma nota como está no banco. */
export interface IndexedNote {
  readonly id: string;
  readonly path: string;
  readonly type: string | null;
  readonly title: string | null;
  readonly scope: string | null;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly created: string | null;
  readonly updated: string | null;
  readonly confirmed: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  /** Está em `memory/_archive/`. */
  readonly archived: boolean;
  /** Tem `id` no frontmatter (as fontes em `raw/` e as notas soltas não têm; o id é derivado do caminho). */
  readonly managed: boolean;
  readonly contentHash: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Mensagem do erro de YAML, se o frontmatter não pôde ser lido. */
  readonly frontmatterError: string | null;
}

const NOTE_COLUMNS = `n.id, n.path, n.type, n.title, n.scope, n.trust, n.origin, n.created, n.updated, n.confirmed,
  n.valid_from, n.valid_until, n.expires_at, n.archived, n.managed, n.content_hash, n.mtime, n.size, n.frontmatter,
  n.frontmatter_error`;

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

function toNote(row: Record<string, unknown>): IndexedNote {
  return {
    id: String(row.id),
    path: String(row.path),
    type: text(row.type),
    title: text(row.title),
    scope: text(row.scope),
    trust: text(row.trust),
    origin: text(row.origin),
    created: text(row.created),
    updated: text(row.updated),
    confirmed: text(row.confirmed),
    validFrom: text(row.valid_from),
    validUntil: text(row.valid_until),
    expiresAt: text(row.expires_at),
    archived: Number(row.archived) === 1,
    managed: Number(row.managed) === 1,
    contentHash: String(row.content_hash),
    mtimeMs: Number(row.mtime),
    size: Number(row.size),
    frontmatter: parseObject(row.frontmatter),
    frontmatterError: text(row.frontmatter_error),
  };
}

export type NoteRef = { readonly id: string } | { readonly path: string };

/**
 * Nota por `id` ou por caminho. O caminho aceita `\\`, NFD e a falta do `.md`; sem achar o caminho exato, tenta
 * sem diferenciar maiúsculas (e só aceita se houver uma única nota assim).
 */
export function getNote(index: LocalIndex, ref: NoteRef): IndexedNote | null {
  const db = connection(index);
  if ('id' in ref) {
    const row = db.prepare(`select ${NOTE_COLUMNS} from notes n where n.id = ?`).get(ref.id);
    return row === undefined ? null : toNote(row);
  }
  const path = normalizeRelPath(ref.path);
  const tries = /\.md$/i.test(path) ? [path] : [path, `${path}.md`];
  const exact = db.prepare(`select ${NOTE_COLUMNS} from notes n where n.path = ?`);
  for (const candidate of tries) {
    const row = exact.get(candidate);
    if (row !== undefined) return toNote(row);
  }
  const loose = db.prepare(`select ${NOTE_COLUMNS} from notes n where lower(n.path) = lower(?) limit 2`);
  for (const candidate of tries) {
    const rows = loose.all(candidate);
    if (rows.length === 1 && rows[0] !== undefined) return toNote(rows[0]);
  }
  return null;
}

/** Link de saída de uma nota. */
export interface OutgoingLink {
  readonly origin: EdgeOrigin;
  /** `link`, `embed`, nome da relação (`uses`...), `supersedes`, `subject`/`object`, ou o campo do frontmatter. */
  readonly type: string;
  readonly target: string;
  readonly anchor: string | null;
  readonly alias: string | null;
  readonly line: number | null;
  /** O alvo não corresponde a nenhuma nota. */
  readonly broken: boolean;
  readonly noteId: string | null;
  readonly path: string | null;
  readonly title: string | null;
  readonly noteType: string | null;
}

/** Links de saída da nota `noteId`, na ordem em que foram gravados (frontmatter, depois corpo). */
export function outgoingLinks(index: LocalIndex, noteId: string): OutgoingLink[] {
  return connection(index)
    .prepare(
      `select e.origin, e.type, e.target, e.anchor, e.alias, e.line, e.dst_note, d.path, d.title, d.type as note_type
       from edges e left join notes d on d.id = e.dst_note
       where e.src_note = ? order by e.id`,
    )
    .all(noteId)
    .map((row) => ({
      origin: String(row.origin) as EdgeOrigin,
      type: String(row.type),
      target: String(row.target),
      anchor: text(row.anchor),
      alias: text(row.alias),
      line: row.line === null ? null : Number(row.line),
      broken: row.dst_note === null,
      noteId: text(row.dst_note),
      path: text(row.path),
      title: text(row.title),
      noteType: text(row.note_type),
    }));
}

/** Link que chega numa nota. */
export interface Backlink {
  readonly origin: EdgeOrigin;
  readonly type: string;
  readonly line: number | null;
  readonly anchor: string | null;
  readonly noteId: string;
  readonly path: string;
  readonly title: string | null;
  readonly noteType: string | null;
  readonly archived: boolean;
}

/** Links que chegam na nota `noteId`, vindos de outras notas, por caminho de origem. */
export function backlinks(index: LocalIndex, noteId: string): Backlink[] {
  return connection(index)
    .prepare(
      `select e.origin, e.type, e.line, e.anchor, s.id, s.path, s.title, s.type as note_type, s.archived
       from edges e join notes s on s.id = e.src_note
       where e.dst_note = ? and e.src_note <> e.dst_note
       order by s.path, e.id`,
    )
    .all(noteId)
    .map((row) => ({
      origin: String(row.origin) as EdgeOrigin,
      type: String(row.type),
      line: row.line === null ? null : Number(row.line),
      anchor: text(row.anchor),
      noteId: String(row.id),
      path: String(row.path),
      title: text(row.title),
      noteType: text(row.note_type),
      archived: Number(row.archived) === 1,
    }));
}

export interface ListNotesOptions {
  readonly types?: readonly string[];
  /** Escopos aceitos, comparados exatamente (para o `recall`: `['global', 'project:atlas']`). */
  readonly scope?: string | readonly string[];
  readonly includeArchived?: boolean;
  /** `updated`: mais recentes primeiro (`updated`, senão `created`); `path`: ordem de caminho. Padrão: `updated`. */
  readonly orderBy?: 'updated' | 'path';
  readonly limit?: number;
}

/** Notas por tipo e escopo, sem a busca: o `recall` pede regras, preferências e armadilhas assim. */
export function listNotes(index: LocalIndex, options: ListNotesOptions = {}): IndexedNote[] {
  const filters: string[] = [];
  const params: SQLInputValue[] = [];
  if (options.includeArchived !== true) filters.push('n.archived = 0');
  if (options.types !== undefined) {
    if (options.types.length === 0) return [];
    filters.push(`n.type in (${options.types.map(() => '?').join(', ')})`);
    params.push(...options.types);
  }
  if (options.scope !== undefined) {
    const scopes = typeof options.scope === 'string' ? [options.scope] : [...options.scope];
    if (scopes.length === 0) return [];
    filters.push(`n.scope in (${scopes.map(() => '?').join(', ')})`);
    params.push(...scopes);
  }
  const order =
    options.orderBy === 'path'
      ? 'n.path'
      : `coalesce(n.updated, n.created, '') desc, coalesce(n.created, '') desc, n.id desc`;
  let sql = `select ${NOTE_COLUMNS} from notes n${filters.length > 0 ? ` where ${filters.join(' and ')}` : ''} order by ${order}`;
  if (options.limit !== undefined) {
    sql += ' limit ?';
    params.push(Math.max(0, Math.trunc(options.limit)));
  }
  return connection(index)
    .prepare(sql)
    .all(...params)
    .map(toNote);
}

/** O handoff mais recente (por `updated`/`created`, e pelo `id`, que é um ULID, no empate), ou `null`. */
export function latestHandoff(
  index: LocalIndex,
  options: Pick<ListNotesOptions, 'scope' | 'includeArchived'> = {},
): IndexedNote | null {
  return listNotes(index, { ...options, types: ['handoff'], orderBy: 'updated', limit: 1 })[0] ?? null;
}

/** Link sem nota de destino (para o `lint`). */
export interface BrokenLink {
  readonly noteId: string;
  readonly path: string;
  readonly origin: EdgeOrigin;
  readonly type: string;
  readonly target: string;
  readonly line: number | null;
}

export function brokenLinks(index: LocalIndex, options: { readonly includeArchived?: boolean } = {}): BrokenLink[] {
  return connection(index)
    .prepare(
      `select s.id, s.path, e.origin, e.type, e.target, e.line
       from edges e join notes s on s.id = e.src_note
       where e.dst_note is null${options.includeArchived === true ? '' : ' and s.archived = 0'}
       order by s.path, e.id`,
    )
    .all()
    .map((row) => ({
      noteId: String(row.id),
      path: String(row.path),
      origin: String(row.origin) as EdgeOrigin,
      type: String(row.type),
      target: String(row.target),
      line: row.line === null ? null : Number(row.line),
    }));
}

export interface IndexStatus {
  /** Versão do esquema gravada no banco. */
  readonly schemaVersion: number;
  /** Versão que este código espera; difere de `schemaVersion` só se outro processo mais novo refez o banco. */
  readonly expectedSchemaVersion: number;
  readonly notes: number;
  readonly archived: number;
  /** Notas sem `id` no frontmatter. */
  readonly unmanaged: number;
  /** Notas por tipo (só as não arquivadas). Notas sem tipo ficam em `untyped`. */
  readonly byType: Readonly<Record<string, number>>;
  readonly untyped: number;
  readonly chunks: number;
  readonly edges: number;
  /** Links sem destino, em notas não arquivadas. */
  readonly brokenLinks: number;
  readonly facts: number;
  /** Fim da última varredura (ISO 8601, UTC), ou `null` se nunca houve. */
  readonly lastScanAt: string | null;
  readonly lastScanMs: number | null;
}

/** Contagens para a tool `status`. */
export function indexStatus(index: LocalIndex): IndexStatus {
  const db = connection(index);
  const count = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
  const state = (key: string): string | null =>
    text(db.prepare('select value from state where key = ?').get(key)?.value);
  const byType: Record<string, number> = {};
  let untyped = 0;
  for (const row of db
    .prepare('select type, count(*) as n from notes where archived = 0 group by type order by type')
    .all()) {
    if (row.type === null) untyped = Number(row.n);
    else byType[String(row.type)] = Number(row.n);
  }
  const lastScanMs = state(STATE_KEYS.lastScanMs);
  return {
    schemaVersion: Number(state(STATE_KEYS.schemaVersion) ?? 0),
    expectedSchemaVersion: INDEX_SCHEMA_VERSION,
    notes: count('select count(*) as n from notes'),
    archived: count('select count(*) as n from notes where archived = 1'),
    unmanaged: count('select count(*) as n from notes where managed = 0'),
    byType,
    untyped,
    chunks: count('select count(*) as n from chunks'),
    edges: count('select count(*) as n from edges'),
    brokenLinks: count(
      'select count(*) as n from edges e join notes s on s.id = e.src_note where e.dst_note is null and s.archived = 0',
    ),
    facts: count('select count(*) as n from facts'),
    lastScanAt: state(STATE_KEYS.lastScanAt),
    lastScanMs: lastScanMs === null ? null : Number(lastScanMs),
  };
}
