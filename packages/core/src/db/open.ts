// Abertura do banco local `<cérebro>/.cabecao/cabecao.db`: modo WAL, espera em trava, chaves estrangeiras, esquema
// e reconstrução automática (versão diferente ou arquivo corrompido).
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withLock } from '../util/index.ts';
import { createSchema, dropEverything, INDEX_SCHEMA_VERSION, isEmptyDatabase, readSchemaVersion } from './schema.ts';
import type { DatabaseSync } from './sqlite.ts';
import { isCorruptionError, openDatabase } from './sqlite.ts';

/** Pasta local do Cabeção dentro do cérebro (fora do git). */
export const LOCAL_DIR = '.cabecao';
export const INDEX_DB_FILE = 'cabecao.db';
/** Quanto uma escrita espera por outro processo que segura o banco, em ms. */
export const DEFAULT_BUSY_TIMEOUT_MS = 15_000;

/** Por que o banco foi (re)criado na abertura. */
export type RebuildReason = 'created' | 'schema_changed' | 'corrupt';

export interface OpenIndexOptions {
  /** Caminho do arquivo do banco. Padrão: `<root>/.cabecao/cabecao.db`. */
  readonly dbPath?: string;
  readonly busyTimeoutMs?: number;
}

/** Banco local aberto. Feche com `close()` (no Windows, antes de apagar ou mover a pasta). */
export interface LocalIndex {
  /** Raiz do cérebro. */
  readonly root: string;
  readonly dbPath: string;
  /** Conexão aberta. Troca de objeto quando o arquivo precisa ser recriado (`reindex` de banco corrompido). */
  readonly db: DatabaseSync;
  /** O banco foi criado ou refeito nesta abertura (e portanto está vazio até a primeira varredura). */
  readonly rebuilt: RebuildReason | null;
  readonly closed: boolean;
  /** Fecha a conexão; o SQLite remove `-wal` e `-shm`. Pode ser chamada mais de uma vez. */
  close(): void;
}

/** Estado interno: a conexão pode ser trocada por `recreateDatabaseFile`. */
export interface IndexHandle extends LocalIndex {
  db: DatabaseSync;
  rebuilt: RebuildReason | null;
  closed: boolean;
  readonly busyTimeoutMs: number;
}

export function indexDbPath(root: string): string {
  return join(root, LOCAL_DIR, INDEX_DB_FILE);
}

/** Trava entre processos que serializa varreduras e reconstruções do banco: `.cabecao/locks/index.lock`. */
export function indexLockPath(dbPath: string): string {
  return join(dirname(dbPath), 'locks', 'index.lock');
}

/** Espera síncrona curta: a API do `node:sqlite` é síncrona, e a troca para WAL precisa tentar de novo. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isLockedError(error: unknown): boolean {
  return error instanceof Error && /database is locked|database table is locked|SQLITE_BUSY/i.test(error.message);
}

/**
 * Troca o banco para WAL. Quando dois processos abrem ao mesmo tempo um banco que ainda não existe, a troca falha na
 * hora com "database is locked", sem passar pelo `busy_timeout` (o SQLite não espera para mudar o modo do diário).
 * Na tentativa seguinte o outro processo já terminou a troca. O prazo é o mesmo do `busy_timeout`.
 */
function switchToWal(db: DatabaseSync, busyTimeoutMs: number): void {
  const deadline = Date.now() + Math.max(0, busyTimeoutMs);
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      db.exec('pragma journal_mode = WAL');
      return;
    } catch (error) {
      if (!isLockedError(error) || Date.now() >= deadline) throw error;
      sleepSync(delay);
    }
  }
}

function configure(db: DatabaseSync, busyTimeoutMs: number): void {
  // `busy_timeout` antes de tudo: até a troca para WAL pode esbarrar em outro processo
  db.exec(`pragma busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  switchToWal(db, busyTimeoutMs);
  db.exec('pragma synchronous = NORMAL');
  db.exec('pragma foreign_keys = ON');
}

/** Executa `fn` numa transação de escrita (`begin immediate`), desfazendo tudo se lançar. */
export function inWriteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('begin immediate');
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('rollback');
    throw error;
  }
}

/**
 * Garante o esquema atual. Devolve o motivo se o banco foi criado ou refeito. A conferência é repetida dentro de
 * uma transação de escrita, então dois processos abrindo o mesmo banco novo não criam as tabelas duas vezes.
 */
function ensureSchema(db: DatabaseSync): RebuildReason | null {
  if (readSchemaVersion(db) === INDEX_SCHEMA_VERSION) return null;
  // `foreign_keys` só muda fora de transação; desligado, o `drop` não apaga linha a linha
  db.exec('pragma foreign_keys = OFF');
  try {
    return inWriteTransaction(db, () => {
      const version = readSchemaVersion(db);
      if (version === INDEX_SCHEMA_VERSION) return null;
      const reason: RebuildReason = version === null && isEmptyDatabase(db) ? 'created' : 'schema_changed';
      dropEverything(db);
      createSchema(db);
      return reason;
    });
  } finally {
    db.exec('pragma foreign_keys = ON');
  }
}

async function removeDatabaseFiles(dbPath: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await rm(`${dbPath}${suffix}`, { force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function openAndPrepare(dbPath: string, busyTimeoutMs: number): { db: DatabaseSync; rebuilt: RebuildReason | null } {
  const db = openDatabase(dbPath);
  try {
    configure(db, busyTimeoutMs);
    return { db, rebuilt: ensureSchema(db) };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Apaga o arquivo do banco e cria outro, vazio, com o esquema atual. Feito sob a trava do índice, para dois
 * processos não apagarem o banco um do outro. Usado quando o arquivo está corrompido.
 */
export async function recreateDatabaseFile(handle: IndexHandle, alreadyLocked = false): Promise<void> {
  const run = async (): Promise<void> => {
    if (!handle.closed) handle.db.close();
    await removeDatabaseFiles(handle.dbPath);
    const { db } = openAndPrepare(handle.dbPath, handle.busyTimeoutMs);
    handle.db = db;
    handle.closed = false;
    handle.rebuilt = 'corrupt';
  };
  if (alreadyLocked) await run();
  else await withLock(indexLockPath(handle.dbPath), run, { timeoutMs: 120_000 });
}

/**
 * Abre (criando a pasta e o arquivo, se preciso) o banco local do cérebro em `root`.
 *
 * - Modo WAL, `busy_timeout` e `foreign_keys`.
 * - Esquema ausente ou de outra versão: o banco é refeito vazio (`rebuilt`), e a próxima varredura indexa tudo.
 * - Arquivo que não é banco ou está corrompido: é apagado e recriado (`rebuilt: 'corrupt'`).
 *
 * Abrir não varre o cérebro; chame `scan` em seguida.
 */
export async function openIndex(root: string, options: OpenIndexOptions = {}): Promise<LocalIndex> {
  const dbPath = options.dbPath ?? indexDbPath(root);
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  mkdirSync(dirname(dbPath), { recursive: true });

  let opened: { db: DatabaseSync; rebuilt: RebuildReason | null } | null = null;
  try {
    opened = openAndPrepare(dbPath, busyTimeoutMs);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
  }

  const handle: IndexHandle = {
    root,
    dbPath,
    busyTimeoutMs,
    db: opened?.db as DatabaseSync,
    rebuilt: opened?.rebuilt ?? null,
    closed: opened === null,
    close() {
      if (handle.closed) return;
      handle.closed = true;
      handle.db.close();
    },
  };
  if (opened === null) await recreateDatabaseFile(handle);
  return handle;
}

/** Acesso à conexão, recusando um índice já fechado com uma mensagem clara. */
export function connection(index: LocalIndex): DatabaseSync {
  if (index.closed) throw new Error('o banco local já foi fechado');
  return index.db;
}

/** Lê um valor da tabela `state`. */
export function getIndexState(index: LocalIndex, key: string): string | null {
  const row = connection(index).prepare('select value from state where key = ?').get(key);
  return row === undefined || row.value === null ? null : String(row.value);
}

/** Grava (ou apaga, com `null`) um valor da tabela `state`. */
export function setIndexState(index: LocalIndex, key: string, value: string | null): void {
  const db = connection(index);
  if (value === null) db.prepare('delete from state where key = ?').run(key);
  else
    db.prepare('insert into state(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(
      key,
      value,
    );
}
