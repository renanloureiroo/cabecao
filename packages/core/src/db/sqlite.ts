// Carregamento do `node:sqlite` e detalhes de plataforma do arquivo do banco.
//
// O módulo NÃO é importado de forma estática: um `import { DatabaseSync } from 'node:sqlite'` é avaliado antes de
// qualquer código deste pacote, e o Node 22.16–24.14 (e 25.0–25.6) emite nesse instante um `ExperimentalWarning`
// no stderr do usuário. Carregando por `process.getBuiltinModule` dá para instalar o filtro antes.

import { win32 } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type SqliteModule = typeof import('node:sqlite');
export type { DatabaseSync, StatementSync } from 'node:sqlite';

const FILTER_INSTALLED = Symbol.for('cabecao.sqliteWarningFilter');

/** Verdadeiro para o aviso "SQLite is an experimental feature..." e só para ele. */
export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : typeof typeOrOptions === 'object' && typeOrOptions !== null
        ? (typeOrOptions as { type?: unknown }).type
        : undefined;
  const name = warning instanceof Error ? warning.name : undefined;
  if (type !== 'ExperimentalWarning' && name !== 'ExperimentalWarning') return false;
  const message = warning instanceof Error ? warning.message : String(warning);
  return /\bSQLite\b/i.test(message);
}

/** Envolve um `emitWarning` para descartar só o aviso do SQLite. Exportada para teste. */
export function filterSqliteWarning(emit: typeof process.emitWarning): typeof process.emitWarning {
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  return filtered as typeof process.emitWarning;
}

/**
 * Instala (uma vez por processo) um filtro em `process.emitWarning` que descarta só o `ExperimentalWarning` do
 * SQLite. Qualquer outro aviso passa intacto. Chamar de novo não empilha filtros.
 */
export function installSqliteWarningFilter(): void {
  const proc = process as NodeJS.Process & { [FILTER_INSTALLED]?: boolean };
  if (proc[FILTER_INSTALLED] === true) return;
  process.emitWarning = filterSqliteWarning(process.emitWarning);
  proc[FILTER_INSTALLED] = true;
}

let cached: SqliteModule | undefined;

/** Carrega `node:sqlite` com o filtro de aviso já instalado. Lança com mensagem clara se o Node não tiver o módulo. */
export function loadSqlite(): SqliteModule {
  if (cached !== undefined) return cached;
  installSqliteWarningFilter();
  const mod = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined;
  if (mod === undefined || typeof mod.DatabaseSync !== 'function') {
    throw new Error(
      `o Cabeção precisa do SQLite embutido do Node.js (22.16 ou mais novo); este é o ${process.version}. Atualize o Node.`,
    );
  }
  cached = mod;
  return mod;
}

/**
 * Acima disto o caminho do banco ganha o prefixo `\\?\` no Windows. O limite clássico é 260 caracteres e o SQLite
 * ainda acrescenta `-wal`, `-shm` e `-journal` ao nome; no spike, `new DatabaseSync` falhou a partir de ~265.
 */
export const WINDOWS_LONG_PATH_THRESHOLD = 240;

/**
 * Caminho que deve ser passado ao `DatabaseSync`. No Windows, um caminho longo recebe o prefixo `\\?\` (ou
 * `\\?\UNC\` para pasta de rede): sem ele o SQLite não abre o arquivo, mesmo com `LongPathsEnabled`. Nos outros
 * sistemas, devolve o caminho como veio.
 */
export function sqliteFilePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path;
  if (path.startsWith('\\\\?\\') || path.startsWith('//?/')) return path;
  const absolute = win32.resolve(path);
  if (absolute.length < WINDOWS_LONG_PATH_THRESHOLD) return absolute;
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`;
  return `\\\\?\\${absolute}`;
}

/** Erro do SQLite com o código primário (`errcode & 0xff`), se houver. */
export function sqliteErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' ? errcode & 0xff : null;
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** O arquivo não é um banco SQLite ou está corrompido: apagar e refazer é o conserto. */
export function isCorruptionError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return true;
  const message = error instanceof Error ? error.message : '';
  return /file is not a database|database disk image is malformed/i.test(message);
}

/** Abre o banco com o caminho já ajustado para a plataforma. */
export function openDatabase(path: string): DatabaseSync {
  const { DatabaseSync: Database } = loadSqlite();
  return new Database(sqliteFilePath(path));
}
