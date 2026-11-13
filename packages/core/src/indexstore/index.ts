// Armazém de embeddings em segmentos imutáveis na branch de índice (`cabecao/index`), marco 2. Lido e escrito direto
// no banco de objetos do git, sem `git worktree` (decisões 12, 13, 15 e 16).
export type { CompactOptions, CompactResult, CompactStats } from './compact.ts';
export { compactIndex } from './compact.ts';
export type { IndexOptions, IndexStep, SegmentIssue } from './context.ts';
export { DEFAULT_MAX_SEGMENT_BYTES, INDEX_STEPS } from './context.ts';
export type { IndexRef } from './git.ts';
export { IndexRefRaceError } from './git.ts';
export type { DrainSource, WriteResult as IndexWriteResult } from './integrate.ts';
export type { EmbeddingModelSpec } from './layout.ts';
export {
  EMBEDDINGS_DIR,
  GRAPH_EDGES_PATH,
  GRAPH_NODES_PATH,
  generationBranch,
  generationRef,
  INDEX_BRANCH,
  INDEX_REF_PATTERN,
  isModelDir,
  MANIFEST_PATH,
  modelDirName,
  parseGenerationRef,
  trackingRef,
} from './layout.ts';
export type { IndexManifest, ManifestModel, ManifestPrevious } from './manifest.ts';
export { MANIFEST_FORMAT_VERSION, parseManifest } from './manifest.ts';
export type { FetchIndexOptions, FetchIndexResult, IndexPushRef, MergeIndexResult, PruneResult } from './remote.ts';
export {
  fetchRemoteIndex,
  indexPushRef,
  mergeRemoteIndex,
  pruneRemoteGenerations,
  recordIndexPushed,
} from './remote.ts';
export type {
  DecodedSegment,
  DecodeSegmentExpect,
  DecodeSegmentResult,
  EmbeddingRecord,
  EncodedSegment,
  SegmentProblem,
} from './segment.ts';
export {
  decodeSegment,
  encodeSegment,
  isEmbeddingKey,
  SEGMENT_FORMAT_VERSION,
  SEGMENT_NAME_RE,
  segmentCountFromSize,
  segmentRecordBytes,
  segmentSize,
} from './segment.ts';
export type {
  AppendOptions,
  AppendResult,
  IndexHead,
  IndexSnapshot,
  IndexStore,
  IndexStoreOptions,
  ReadAllOptions,
  WriteIndexFileOptions,
} from './store.ts';
export {
  indexManifestAt,
  indexTreeBytes,
  listIndexBranches,
  openIndexStore,
  readIndexFile,
  readIndexManifest,
  writeIndexFile,
  writeIndexFiles,
} from './store.ts';
