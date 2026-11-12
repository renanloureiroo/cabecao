// API pública do banco local: abertura, varredura incremental, busca por palavra-chave e consultas de apoio.
export type { EdgeOrigin, ScanIssue, ScanIssueCode } from './extract.ts';
export { linkTargetKey, PATH_ID_PREFIX, pathNoteId } from './extract.ts';
export type { LocalIndex, OpenIndexOptions, RebuildReason } from './open.ts';
export {
  DEFAULT_BUSY_TIMEOUT_MS,
  getIndexState,
  INDEX_DB_FILE,
  indexDbPath,
  indexLockPath,
  LOCAL_DIR,
  openIndex,
  setIndexState,
} from './open.ts';
export type {
  Backlink,
  BrokenLink,
  IndexedNote,
  IndexStatus,
  ListNotesOptions,
  NoteRef,
  OutgoingLink,
} from './queries.ts';
export { backlinks, brokenLinks, getNote, indexStatus, latestHandoff, listNotes, outgoingLinks } from './queries.ts';
export type { ScanConfig, ScanOptions, ScanSummary } from './scan.ts';
export { DEFAULT_SCAN_LOCK_TIMEOUT_MS, reindexFull, scan } from './scan.ts';
export { INDEX_SCHEMA_VERSION, STATE_KEYS } from './schema.ts';
export type { KeywordHit, KeywordSearchOptions, KeywordSearchResult, QueryTerm, Validity } from './search.ts';
export { buildFtsQuery, queryTerms, searchKeyword, validityOf } from './search.ts';
export type { SqliteModule } from './sqlite.ts';
export {
  filterSqliteWarning,
  installSqliteWarningFilter,
  isSqliteExperimentalWarning,
  loadSqlite,
  sqliteFilePath,
  WINDOWS_LONG_PATH_THRESHOLD,
} from './sqlite.ts';
