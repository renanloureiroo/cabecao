// Varredura incremental (decisão 20): compara a listagem do vault com a tabela `notes` por data e tamanho, só lê o
// que mudou, pula conteúdo de hash igual, detecta renomeações e grava tudo numa transação.
import { parseConflictCopyPath } from '../sync/conflict-name.ts';
import { withLock } from '../util/index.ts';
import type { BrainConfig, LinkIndex, NoteFile, NoteRead, RelationsConfig } from '../vault/index.ts';
import { buildLinkIndex, displayTitle, listNoteFiles, readNote, resolveWikiLink, VaultError } from '../vault/index.ts';
import { refreshDerived } from './derived.ts';
import type { NoteRecord, ScanIssue } from './extract.ts';
import { extractNote, PATH_ID_PREFIX, pathNameKey, pathNoteId } from './extract.ts';
import type { IndexHandle, LocalIndex } from './open.ts';
import { connection, indexLockPath, inWriteTransaction, recreateDatabaseFile } from './open.ts';
import { createSchema, dropEverything, STATE_KEYS } from './schema.ts';
import type { DatabaseSync, StatementSync } from './sqlite.ts';
import { isCorruptionError } from './sqlite.ts';

/** O que a varredura precisa da configuração do cérebro. Um `BrainConfig` serve. */
export type ScanConfig = Pick<BrainConfig, 'noteDirs' | 'indexMd'> & RelationsConfig;

export interface ScanOptions {
  /** Apaga o banco e indexa tudo de novo (`cabecao reindex --full`). */
  readonly full?: boolean;
  /** Quanto esperar por outro processo que esteja varrendo o mesmo cérebro. Padrão: 10 min. */
  readonly lockTimeoutMs?: number;
}

export interface ScanSummary {
  /** Notas novas. */
  readonly added: number;
  /** Notas com conteúdo alterado no mesmo caminho. */
  readonly updated: number;
  /** Notas que sumiram do disco. */
  readonly removed: number;
  /** Notas que mudaram de caminho (mesmo conteúdo ou mesmo `id`). */
  readonly renamed: number;
  /** Notas sem mudança (inclusive as de data alterada e conteúdo igual, como depois de um `git checkout`). */
  readonly unchanged: number;
  /** Problemas por nota. Nenhum deles interrompe a varredura. */
  readonly errors: readonly ScanIssue[];
  /** Duração, em ms, incluindo a espera pela trava. */
  readonly ms: number;
  /** Quantos arquivos foram lidos do disco. Zero numa varredura em que nada mudou. */
  readonly filesRead: number;
  /** Notas no banco depois da varredura. */
  readonly total: number;
}

export const DEFAULT_SCAN_LOCK_TIMEOUT_MS = 10 * 60_000;
/** Arquivos lidos em paralelo; também limita quantas notas parseadas ficam na memória ao mesmo tempo. */
const READ_BATCH = 32;
/** Marca, na coluna `mtime`, uma nota que precisa ser reprocessada na próxima varredura (conflito de `id`). */
const RECHECK_MTIME = -1;

interface KnownRow {
  readonly id: string;
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
  readonly hash: string;
  readonly managed: boolean;
}

type ReadOutcome =
  | { readonly kind: 'ok'; readonly read: NoteRead }
  | { readonly kind: 'vanished' }
  | { readonly kind: 'failed'; readonly message: string };

async function readSafely(root: string, file: NoteFile): Promise<ReadOutcome> {
  try {
    return { kind: 'ok', read: await readNote(root, file.diskPath) };
  } catch (error) {
    if (error instanceof VaultError && error.code === 'note_not_found') return { kind: 'vanished' };
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Apaga e recria as tabelas. Se o arquivo estiver corrompido a ponto do `drop` falhar, recria o arquivo. */
async function resetIndex(handle: IndexHandle): Promise<void> {
  try {
    const db = connection(handle);
    db.exec('pragma foreign_keys = OFF');
    try {
      inWriteTransaction(db, () => {
        dropEverything(db);
        createSchema(db);
      });
    } finally {
      db.exec('pragma foreign_keys = ON');
    }
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    await recreateDatabaseFile(handle, true);
  }
}

/** Instruções preparadas da varredura. */
function statements(db: DatabaseSync) {
  const noteColumns = `type = ?, title = ?, scope = ?, trust = ?, origin = ?, created = ?, updated = ?, confirmed = ?,
    valid_from = ?, valid_until = ?, expires_at = ?, content_hash = ?, mtime = ?, size = ?, frontmatter = ?,
    frontmatter_error = ?, managed = ?, title_derived = ?, archived = ?, conflict_of = ?, indexed_at = ?`;
  return {
    known: db.prepare('select id, path, mtime, size, content_hash, managed from notes'),
    pathById: db.prepare('select path from notes where id = ?'),
    insertNote: db.prepare(`insert into notes(id, path, type, title, scope, trust, origin, created, updated, confirmed,
      valid_from, valid_until, expires_at, content_hash, mtime, size, frontmatter, frontmatter_error, managed,
      title_derived, archived, conflict_of, indexed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateNote: db.prepare(`update notes set id = ?, path = ?, ${noteColumns} where path = ?`),
    touch: db.prepare('update notes set mtime = ?, size = ? where path = ?'),
    moveNote: db.prepare(
      `update notes set id = ?, path = ?, archived = ?, mtime = ?, size = ?, title = ?, conflict_of = ?, indexed_at = ?
       where path = ?`,
    ),
    titleInfo: db.prepare('select frontmatter, title, title_derived from notes where path = ?'),
    deleteNote: db.prepare('delete from notes where path = ?'),
    deleteChunks: db.prepare('delete from chunks where note_id = ?'),
    deleteEdges: db.prepare('delete from edges where src_note = ?'),
    deleteFact: db.prepare('delete from facts where note_id = ?'),
    insertChunk: db.prepare(`insert into chunks(note_id, ord, heading_path, title_path, text, token_count, chunk_key,
      start_line, end_line) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertEdge: db.prepare(`insert into edges(src_note, dst_note, type, origin, target, target_key, anchor, alias, line,
      valid_from, valid_until) values (?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFact: db.prepare(`insert into facts(note_id, subject, predicate, object, valid_from, valid_until)
      values (?, ?, ?, ?, ?, ?)`),
    setState: db.prepare(
      'insert into state(key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
    ),
    count: db.prepare('select count(*) as n from notes'),
  };
}
type Statements = ReturnType<typeof statements>;

/** Caminho da nota original, se `path` é uma cópia de conflito do sync; `null` caso contrário. */
function conflictOf(path: string): string | null {
  return parseConflictCopyPath(path)?.original ?? null;
}

/** Grava os campos da nota (linha de `notes`) e substitui trechos, arestas e fato. */
function writeNote(
  st: Statements,
  record: NoteRecord,
  id: string,
  recheck: boolean,
  wherePath: string | null,
  now: string,
): void {
  const values = [
    record.type,
    record.title,
    record.scope,
    record.trust,
    record.origin,
    record.created,
    record.updated,
    record.confirmed,
    record.validFrom,
    record.validUntil,
    record.expiresAt,
    record.contentHash,
    recheck ? RECHECK_MTIME : record.mtimeMs,
    record.size,
    record.frontmatterJson,
    record.frontmatterError,
    record.frontmatterId === null ? 0 : 1,
    record.titleDerived ? 1 : 0,
    record.archived ? 1 : 0,
    conflictOf(record.path),
    now,
  ] as const;
  if (wherePath === null) {
    st.insertNote.run(id, record.path, ...values);
  } else {
    // a troca de `id` desce para trechos, arestas e fatos por `on update cascade`
    st.updateNote.run(id, record.path, ...values, wherePath);
    st.deleteChunks.run(id);
    st.deleteEdges.run(id);
    st.deleteFact.run(id);
  }
  for (const chunk of record.chunks) {
    st.insertChunk.run(
      id,
      chunk.ord,
      JSON.stringify(chunk.headingPath),
      chunk.contextPrefix,
      chunk.text,
      chunk.tokenCount,
      chunk.chunkKey,
      chunk.startLine,
      chunk.endLine,
    );
  }
  for (const edge of record.edges) {
    st.insertEdge.run(
      id,
      edge.type,
      edge.origin,
      edge.target,
      edge.targetKey,
      edge.anchor,
      edge.alias,
      edge.line,
      record.validFrom,
      record.validUntil,
    );
  }
  // uma cópia de conflito não é memória vigente: o fato dela repetiria o da nota original
  if (record.fact !== null && conflictOf(record.path) === null) {
    const { subject, predicate, object } = record.fact;
    st.insertFact.run(id, subject, predicate, object, record.validFrom, record.validUntil);
  }
}

/** Executa `fn` num savepoint: se lançar, desfaz só o que `fn` fez e devolve o erro. */
function inSavepoint(db: DatabaseSync, fn: () => void): unknown {
  db.exec('savepoint note');
  try {
    fn();
    db.exec('release note');
    return null;
  } catch (error) {
    db.exec('rollback to note');
    db.exec('release note');
    return error;
  }
}

/**
 * Resolve o destino das arestas novas e das que podem ter mudado de destino: as de notas gravadas nesta varredura
 * e as que apontam para um nome que apareceu ou sumiu. Usa o mesmo resolvedor do vault (`resolveWikiLink`). As
 * menções (`origin: mention`) já nascem com o destino e são refeitas à parte (`db/derived.ts`). Devolve as notas
 * de origem das arestas que mudaram de destino.
 */
function resolveEdges(
  db: DatabaseSync,
  linkIndex: LinkIndex,
  touchedNotes: ReadonlySet<string>,
  affectedKeys: ReadonlySet<string>,
): Set<string> {
  const relinked = new Set<string>();
  if (touchedNotes.size === 0 && affectedKeys.size === 0) return relinked;
  const pathToId = new Map<string, string>();
  for (const row of db.prepare('select id, path from notes').all()) pathToId.set(String(row.path), String(row.id));

  const select = `select e.id, e.src_note, e.target, e.dst_note, n.path from edges e join notes n on n.id = e.src_note`;
  const bySource = db.prepare(`${select} where e.src_note = ? and e.origin <> 'mention'`);
  const byKey = db.prepare(`${select} where e.target_key = ? and e.origin <> 'mention'`);
  const update = db.prepare('update edges set dst_note = ? where id = ?');
  const seen = new Set<number>();
  const visit = (statement: StatementSync, key: string): void => {
    for (const row of statement.all(key)) {
      const edgeId = Number(row.id);
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);
      const resolution = resolveWikiLink(linkIndex, String(row.target), String(row.path));
      const dst = resolution.path === null ? null : (pathToId.get(resolution.path) ?? null);
      const current = row.dst_note === null ? null : String(row.dst_note);
      if (dst !== current) {
        update.run(dst, edgeId);
        relinked.add(String(row.src_note));
      }
    }
  };
  for (const id of touchedNotes) visit(bySource, id);
  for (const key of affectedKeys) visit(byKey, key);

  // sujeito e objeto dos fatos seguem as arestas `fact`
  db.exec(`update facts set
    subject_note = (select e.dst_note from edges e
      where e.src_note = facts.note_id and e.origin = 'fact' and e.type = 'subject' order by e.id limit 1),
    object_note = (select e.dst_note from edges e
      where e.src_note = facts.note_id and e.origin = 'fact' and e.type = 'object' order by e.id limit 1)`);
  return relinked;
}

async function runScan(handle: IndexHandle, root: string, config: ScanConfig, started: number): Promise<ScanSummary> {
  const db = connection(handle);
  const files = await listNoteFiles(root, config);
  const linkIndex = buildLinkIndex(files);
  const st = statements(db);
  const now = new Date().toISOString();

  const known = new Map<string, KnownRow>();
  for (const row of st.known.all()) {
    const path = String(row.path);
    known.set(path, {
      id: String(row.id),
      path,
      mtime: Number(row.mtime),
      size: Number(row.size),
      hash: String(row.content_hash),
      managed: Number(row.managed) === 1,
    });
  }

  // Sumiram do caminho onde estavam: podem ter sido apagadas ou movidas. Indexadas por hash e por `id` para achar
  // o destino de uma renomeação.
  const listed = new Set(files.map((file) => file.path));
  const missing = new Map<string, KnownRow>();
  const missingByHash = new Map<string, KnownRow[]>();
  const missingById = new Map<string, KnownRow>();
  for (const row of known.values()) {
    if (listed.has(row.path)) continue;
    missing.set(row.path, row);
    const sameHash = missingByHash.get(row.hash);
    if (sameHash === undefined) missingByHash.set(row.hash, [row]);
    else sameHash.push(row);
    if (row.managed && !row.id.startsWith(PATH_ID_PREFIX)) missingById.set(row.id, row);
  }
  const consumed = new Set<string>();

  let unchanged = 0;
  const toRead: NoteFile[] = [];
  for (const file of files) {
    const row = known.get(file.path);
    if (row !== undefined && row.mtime === file.mtimeMs && row.size === file.size) unchanged++;
    else toRead.push(file);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  let renamed = 0;
  let filesRead = 0;
  const errors: ScanIssue[] = [];
  const touchedNotes = new Set<string>();
  const affectedKeys = new Set<string>();

  const removeRow = (path: string): void => {
    st.deleteNote.run(path);
    consumed.add(path);
    affectedKeys.add(pathNameKey(path));
    removed++;
  };

  /**
   * Escolhe o id de uma nota a gravar em `path`. Um `id` do frontmatter que já é de OUTRA nota viva vira conflito:
   * esta nota recebe um id derivado do caminho e é conferida de novo na próxima varredura. Uma cópia de conflito do
   * sync NUNCA fica com o `id` do frontmatter (que é o da nota original): recebe sempre o id derivado do caminho.
   */
  const chooseId = (
    record: NoteRecord,
    path: string,
    fromPath: string | null,
  ): { id: string; conflictWith: string | null } => {
    const wanted = record.frontmatterId;
    if (wanted === null || wanted.startsWith(PATH_ID_PREFIX) || conflictOf(path) !== null) {
      return { id: pathNoteId(path), conflictWith: null };
    }
    const holder = st.pathById.get(wanted);
    const holderPath = holder === undefined ? null : String(holder.path);
    if (holderPath === null || holderPath === path || holderPath === fromPath)
      return { id: wanted, conflictWith: null };
    if (missing.has(holderPath) && !consumed.has(holderPath)) {
      // a dona do id foi apagada nesta mesma varredura
      removeRow(holderPath);
      return { id: wanted, conflictWith: null };
    }
    return { id: pathNoteId(path), conflictWith: holderPath };
  };

  /** Grava o registro completo; `fromPath` é o caminho atual da linha no banco (`null` para nota nova). */
  const store = (record: NoteRecord, fromPath: string | null): string | null => {
    const { id, conflictWith } = chooseId(record, record.path, fromPath);
    const issues = [...record.issues];
    if (conflictWith !== null) {
      issues.push({
        path: record.path,
        code: 'duplicate_id',
        message: `o id ${record.frontmatterId} já é da nota ${conflictWith}; esta foi indexada com um id derivado do caminho`,
      });
    }
    const failure = inSavepoint(db, () => writeNote(st, record, id, conflictWith !== null, fromPath, now));
    if (failure !== null) {
      errors.push({
        path: record.path,
        code: 'index_failed',
        message: `não consegui gravar a nota no banco: ${failure instanceof Error ? failure.message : String(failure)}`,
      });
      return null;
    }
    errors.push(...issues);
    touchedNotes.add(id);
    return id;
  };

  /** Só o caminho mudou (conteúdo idêntico): atualiza a linha sem reprocessar trechos nem arestas. */
  const move = (row: KnownRow, file: NoteFile): void => {
    const info = st.titleInfo.get(row.path);
    let title = info === undefined ? null : (info.title as string | null);
    if (info !== undefined && Number(info.title_derived) === 1) {
      try {
        const fm = JSON.parse(String(info.frontmatter)) as Record<string, unknown>;
        title = displayTitle(fm, file.path);
      } catch {
        title = displayTitle({}, file.path);
      }
    }
    const id = row.managed ? row.id : pathNoteId(file.path);
    st.moveNote.run(
      id,
      file.path,
      file.archived ? 1 : 0,
      file.mtimeMs,
      file.size,
      title,
      conflictOf(file.path),
      now,
      row.path,
    );
    consumed.add(row.path);
    affectedKeys.add(pathNameKey(row.path));
    affectedKeys.add(pathNameKey(file.path));
    // o desempate do resolvedor depende da pasta de quem aponta: as arestas de saída são revistas
    touchedNotes.add(id);
  };

  const apply = (file: NoteFile, outcome: ReadOutcome): void => {
    const row = known.get(file.path);
    if (outcome.kind === 'vanished') {
      // apagado entre a listagem e a leitura
      if (row !== undefined) removeRow(file.path);
      return;
    }
    if (outcome.kind === 'failed') {
      errors.push({ path: file.path, code: 'read_failed', message: outcome.message });
      return;
    }
    filesRead++;
    const read = outcome.read;

    if (row !== undefined) {
      const recheck = row.mtime === RECHECK_MTIME;
      if (row.hash === read.contentHash && !recheck) {
        // data mudou, conteúdo não (git checkout, `touch`): só atualiza o carimbo
        st.touch.run(file.mtimeMs, file.size, file.path);
        unchanged++;
        return;
      }
      const id = store(extractNote(read, config), file.path);
      if (recheck && id === row.id && row.hash === read.contentHash) unchanged++;
      else if (id !== null) updated++;
      return;
    }

    // caminho novo: renomeação com o mesmo conteúdo? Não entre uma cópia de conflito e uma nota comum: a cópia tem
    // id derivado do caminho e a nota, o do frontmatter; esse caso é reprocessado inteiro logo abaixo
    const isCopy = conflictOf(file.path) !== null;
    const sameContent = (missingByHash.get(read.contentHash) ?? []).find(
      (candidate) =>
        !consumed.has(candidate.path) &&
        candidate.mtime !== RECHECK_MTIME &&
        (conflictOf(candidate.path) !== null) === isCopy,
    );
    if (sameContent !== undefined) {
      move(sameContent, file);
      renamed++;
      return;
    }
    const record = extractNote(read, config);
    const sameId = record.frontmatterId === null || isCopy ? undefined : missingById.get(record.frontmatterId);
    if (sameId !== undefined && !consumed.has(sameId.path)) {
      // movida E editada: mesma nota (mesmo `id`) em outro caminho
      consumed.add(sameId.path);
      affectedKeys.add(pathNameKey(sameId.path));
      affectedKeys.add(pathNameKey(file.path));
      if (store(record, sameId.path) !== null) renamed++;
      return;
    }
    affectedKeys.add(pathNameKey(file.path));
    if (store(record, null) !== null) added++;
  };

  db.exec('begin immediate');
  try {
    for (let start = 0; start < toRead.length; start += READ_BATCH) {
      const batch = toRead.slice(start, start + READ_BATCH);
      const outcomes = await Promise.all(batch.map((file) => readSafely(root, file)));
      batch.forEach((file, i) => {
        apply(file, outcomes[i] as ReadOutcome);
      });
    }
    for (const path of missing.keys()) if (!consumed.has(path)) removeRow(path);
    const relinked = resolveEdges(db, linkIndex, touchedNotes, affectedKeys);
    // validade derivada do encadeamento, nomes e menções sem link: só quando algo mudou
    if (touchedNotes.size > 0 || affectedKeys.size > 0 || removed > 0) {
      refreshDerived(db, { touched: touchedNotes, relinked });
    }
    const ms = Math.round(performance.now() - started);
    st.setState.run(STATE_KEYS.lastScanAt, new Date().toISOString());
    st.setState.run(STATE_KEYS.lastScanMs, String(ms));
    db.exec('commit');
  } catch (error) {
    if (db.isTransaction) db.exec('rollback');
    throw error;
  }

  return {
    added,
    updated,
    removed,
    renamed,
    unchanged,
    errors,
    ms: Math.round(performance.now() - started),
    filesRead,
    total: Number(st.count.get()?.n ?? 0),
  };
}

/**
 * Varredura incremental do cérebro em `root` para o banco `index`.
 *
 * - Lista as notas (`listNoteFiles`) e compara com a tabela `notes` por data e tamanho; só lê o que mudou.
 * - Conteúdo de hash igual não é reprocessado (o caso de depois de um `git checkout`).
 * - Nota nova, alterada, removida e renomeada ou movida (mesmo hash ou mesmo `id` em caminho novo).
 * - Frontmatter ilegível ou nota sem `id` (fontes em `raw/`): indexada pelo texto e reportada em `errors`.
 * - Tudo numa transação. Dois processos varrendo o mesmo cérebro se revezam por uma trava em
 *   `.cabecao/locks/index.lock`: o segundo encontra o trabalho feito.
 *
 * A transação fica aberta enquanto os arquivos são lidos em lotes (para não manter milhares de notas parseadas na
 * memória). Outros processos continuam lendo o último estado gravado (WAL); no MESMO processo, uma consulta feita
 * pela mesma conexão durante a varredura enxerga o estado parcial.
 */
export async function scan(
  index: LocalIndex,
  root: string,
  config: ScanConfig,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const handle = index as IndexHandle;
  const started = performance.now();
  return withLock(
    indexLockPath(handle.dbPath),
    async () => {
      if (options.full === true) await resetIndex(handle);
      return runScan(handle, root, config, started);
    },
    { timeoutMs: options.lockTimeoutMs ?? DEFAULT_SCAN_LOCK_TIMEOUT_MS },
  );
}

/** `cabecao reindex --full`: apaga o banco e indexa o cérebro do zero. */
export function reindexFull(
  index: LocalIndex,
  root: string,
  config: ScanConfig,
  options: Omit<ScanOptions, 'full'> = {},
): Promise<ScanSummary> {
  return scan(index, root, config, { ...options, full: true });
}
