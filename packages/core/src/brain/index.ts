// API pública da camada de operações do cérebro: o que o servidor MCP e a CLI chamam.
export type { Brain, OpenBrainOptions } from './brain.ts';
export { openBrain } from './brain.ts';
export type { Actor, WriteStep } from './context.ts';
export type { ContentKind, DataEnvelope, DataItem } from './envelope.ts';
export { DATA_NOTICE } from './envelope.ts';
export type { BrainErrorCode, BrainErrorDetails, BrainErrorJson, IssueOutput, SecretHit } from './errors.ts';
export { BRAIN_ERROR_CODES, BrainError } from './errors.ts';
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
