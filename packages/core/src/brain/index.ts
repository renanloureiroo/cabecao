// API pública da camada de operações do cérebro: o que o servidor MCP e a CLI chamam.
export type { Brain, OpenBrainOptions } from './brain.ts';
export { openBrain } from './brain.ts';
export type { Actor, WriteStep } from './context.ts';
export type {
  CompactInput,
  CompactOutput,
  ComputeEmbeddingsInput,
  ComputeEmbeddingsOutput,
  EmbeddingsStatusOutput,
  EvaluateInput,
  EvaluateOutput,
  SetEmbeddingOutput,
  SwitchEmbeddingsOutput,
} from './embeddings.ts';
export type { ContentKind, DataEnvelope, DataItem } from './envelope.ts';
export { DATA_NOTICE } from './envelope.ts';
export type { BrainErrorCode, BrainErrorDetails, BrainErrorJson, IssueOutput, SecretHit } from './errors.ts';
export { BRAIN_ERROR_CODES, BrainError } from './errors.ts';
export type { ForgetInput, ForgetOptions, ForgetOutput } from './forget.ts';
export { CONFIRM_TOKEN_PREFIX, CONFIRM_TOKEN_TTL_MS, FORGET_REASON_MAX_CHARS } from './forget.ts';
export type {
  FactItem,
  FactRefOutput,
  FactsInput,
  FactsOutput,
  GraphInput,
  GraphLinkOutput,
  GraphNeighborOutput,
  GraphNodeOutput,
  GraphOutput,
  RelatedOutput,
  RelatedReason,
} from './graph.ts';
export {
  DEFAULT_FACTS_LIMIT,
  DEFAULT_GRAPH_BUDGET_TOKENS,
  DEFAULT_GRAPH_LIMIT,
  graphEdgeKinds,
  MAX_FACTS_LIMIT,
  MAX_GRAPH_LIMIT,
  RELATED_LIMIT,
} from './graph.ts';
export type { HandoffSaveInput, HandoffSaveOutput, NoteRefOutput } from './handoff.ts';
export { HANDOFF_ITEM_MAX_CHARS, HANDOFF_MAX_ITEMS, HANDOFF_TTL_DAYS } from './handoff.ts';
export type { IngestInput, IngestOptions, IngestOutput, IngestPlanNote } from './ingest.ts';
export { INGEST_DIR, INGEST_MAX_BYTES, INGEST_MAX_CHARS } from './ingest.ts';
export type { LintFinding, LintInput, LintOutput, LintRule, LintSeverity } from './lint.ts';
export { CONFIRMABLE_TYPES, DEFAULT_LINT_LIMIT, LINT_RULES, MAX_LINT_LIMIT, UNCONFIRMED_AFTER_DAYS } from './lint.ts';
export type {
  BacklinkOutput,
  ConflictOutput,
  LinkOutput,
  ReadInput,
  ReadOutput,
  RecallInput,
  RecallOutput,
  RecallSection,
  SearchHit,
  SearchInput,
  SearchOutput,
  StatusOutput,
} from './read.ts';
export { DEFAULT_RECALL_BUDGET_TOKENS, RECALL_ITEM_MAX_CHARS, RECALL_MEMORY_LIMIT, RECALL_PRIORITY } from './read.ts';
export type { RelateInput, RelateOutput } from './relate.ts';
export type { DuplicateCandidate, RememberDecision, RememberOutput } from './remember.ts';
export type { SearchMode, SearchModeUsed } from './semantic.ts';
export { SEARCH_MODES } from './semantic.ts';
export type { DedupComparison, DedupVerdict, MemoryText } from './similarity.ts';
export { compareMemories, DEDUP_THRESHOLDS } from './similarity.ts';
export type { SyncInput, SyncOutput } from './sync.ts';
export { toSyncOutput } from './sync.ts';
export type {
  ListOperationsInput,
  ListOperationsOutput,
  OperationInfo,
  UndoInput,
  UndoneOperation,
  UndoOutput,
} from './undo.ts';
export { MIN_HUMAN_ID_PREFIX } from './undo.ts';
export type { PatchPageInput, RelationsInput, RememberInput, WriteMode, WriteOutput, WritePageInput } from './write.ts';
export { WRITE_MODES } from './write.ts';
