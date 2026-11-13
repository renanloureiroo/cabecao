/** Camada de git do núcleo: execução sem terminal, padrão de commits e operações sobre o repositório do cérebro. */
export type {
  CommitAction,
  CommitChange,
  CommitMessageInput,
  CommitTrailers,
  CommitTrailersInput,
} from './commit-message.ts';
export {
  COMMIT_ACTIONS,
  DEFAULT_DATE_FORMAT,
  DEFAULT_SUBJECT_TEMPLATE,
  formatChangeLine,
  formatCommitMessage,
  formatDate,
  parseCommitTrailers,
  SESSION_PREFIX_LENGTH,
} from './commit-message.ts';
export type { GitErrorCategory, GitErrorDetails } from './errors.ts';
export { classifyGitError, GitError, GitStateError, redactCredentials } from './errors.ts';
export type {
  CommitOptions,
  DefaultRemoteBranchOptions,
  RestorePoint,
  StatusEntry,
  TrailerCommit,
  TrailerQuery,
} from './ops.ts';
export {
  commitPaths,
  createRestorePoint,
  currentBranch,
  defaultRemoteBranch,
  findCommitsByTrailer,
  headSha,
  isRepo,
  RESTORE_TAG_PREFIX,
  restorePointName,
  revertCommits,
  statusPorcelain,
} from './ops.ts';
export type { GitOpOptions, GitResult, GitVersion, RunGitOptions } from './run.ts';
export {
  assertGitVersion,
  buildGitEnv,
  DEFAULT_GIT_TIMEOUT_MS,
  ensureGitVersionSupported,
  GitVersionError,
  gitSubcommand,
  gitVersion,
  isGitVersionSupported,
  MIN_GIT_VERSION,
  NON_INTERACTIVE_ENV,
  parseGitVersion,
  resolveSshCommand,
  runGit,
} from './run.ts';
