// API pública do sync de conteúdo (marco 1): branch principal por git, com integração em memória.
export type { SyncLayout } from './layout.ts';
export { conflictCopyPath, isConflictCopyPath, isSyncablePath, parseConflictCopyPath, syncLayout } from './layout.ts';
export { listConflicts, syncStatus } from './status.ts';
export { syncBrain } from './sync.ts';
export type {
  ConflictCopy,
  SecretLocation,
  SyncBlockReason,
  SyncChange,
  SyncConflict,
  SyncIndexHook,
  SyncIndexResult,
  SyncIntegration,
  SyncOptions,
  SyncRemoteError,
  SyncResult,
  SyncStatus,
  SyncStatusInfo,
  SyncStep,
} from './types.ts';
export { SYNC_STEPS } from './types.ts';
