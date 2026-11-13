// API pública do banco local: abertura, varredura incremental, busca por palavra-chave e consultas de apoio.

export { refreshSupersededOn } from './derived.ts';
export type { GraphExport } from './export.ts';
export { exportGraph } from './export.ts';
export type { EdgeOrigin, ScanIssue, ScanIssueCode } from './extract.ts';
export { linkTargetKey, PATH_ID_PREFIX, pathNoteId } from './extract.ts';
export type { FactQuery, FactRow, NoteRefRow } from './facts.ts';
export { indexedBodies, queryFacts, supersedeChains } from './facts.ts';
export type {
  EdgeFilter,
  GraphEdgeRow,
  GraphNoteRow,
  Neighborhood,
  NeighborhoodOptions,
  RelatedCandidate,
  RelatedOptions,
} from './graph.ts';
export {
  graphNotes,
  MAX_GRAPH_EDGE_ROWS,
  MAX_WALK_ROWS,
  neighborhood,
  originWeight,
  relatedCandidates,
} from './graph.ts';
export type { MentionDictionary, MentionEntry, MentionHit, MentionRefreshSummary, NameCandidate } from './mentions.ts';
export {
  blankNonProse,
  buildMentionDictionary,
  findMentions,
  loadMentionDictionary,
  MAX_MENTIONS_PER_NOTE,
  MENTION_MAX_WORDS,
  MENTION_MIN_CHARS,
  nameKey,
  nameProblem,
} from './mentions.ts';
export type { NodeMatch, NodeResolution } from './nodes.ts';
export { MAX_NODE_REF_LENGTH, resolveNodeRef, stripWikilink } from './nodes.ts';
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
  ConflictCopyOption,
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
export type {
  KeywordHit,
  KeywordSearchOptions,
  KeywordSearchResult,
  NoteFilterOptions,
  QueryTerm,
  StaleFields,
  Validity,
  ValidityFields,
} from './search.ts';
export {
  BM25_TEXT_WEIGHT,
  BM25_TITLE_WEIGHT,
  buildFtsQuery,
  EXPIRED_SCORE_FACTOR,
  isStaleMemory,
  isStopword,
  noteFilters,
  queryTerms,
  STALE_AFTER_DAYS,
  STALE_SCORE_FACTOR,
  STALE_TYPES,
  searchKeyword,
  VALIDITIES,
  validityOf,
} from './search.ts';
export type {
  ChunkDetail,
  ChunkRef,
  EmbeddingInput,
  KeywordCandidates,
  KeywordCandidatesOptions,
  KeywordChunkCandidate,
} from './semantic.ts';
export {
  allChunkKeys,
  chunkDetails,
  chunkKeysMatching,
  chunksForKeys,
  DEFAULT_CANDIDATE_DEPTH,
  embeddingInputs,
  keywordCandidates,
  MIN_IDF,
  termIdfs,
} from './semantic.ts';
export type { SqliteModule } from './sqlite.ts';
export {
  filterSqliteWarning,
  installSqliteWarningFilter,
  isSqliteExperimentalWarning,
  loadSqlite,
  sqliteFilePath,
  WINDOWS_LONG_PATH_THRESHOLD,
} from './sqlite.ts';
export type { SubgraphEdge, SubgraphNote, SubgraphOptions, SubgraphResult } from './subgraph.ts';
export { subgraph } from './subgraph.ts';
