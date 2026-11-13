/** `init` e `remote`: instalar ou conectar uma máquina só com a URL do repositório, e o modelo do cérebro. */
export type { ConnectCase, ConnectRemoteOptions, ConnectRemoteResult, RemoteRelation } from './connect.ts';
export { connectRemote } from './connect.ts';
export type { DetectOptions, RepoDetection, RepoKind, TreeStats, VaultLayout } from './detect.ts';
export {
  CODE_MARKER_FILES,
  classifyTree,
  DETECTION_RULES,
  detectRepoKind,
  VAULT_MIN_NOTE_SHARE,
  vaultLayout,
} from './detect.ts';
export type { InitCase, InitDetection, InitHooks, InitOptions, InitResult, InitStep } from './init.ts';
export { ADOPTED_INDEX_MD, connectLaterStep, initBrain } from './init.ts';
export type { LineMergeResult } from './merge-lines.ts';
export { mergeGitattributes, mergeGitignore } from './merge-lines.ts';
export type {
  AnonymousReader,
  RemoteErrorCategory,
  RemoteFailure,
  RemoteProbe,
  RemoteVisibility,
  VisibilityCheck,
} from './remote.ts';
export {
  anonymousLsRemote,
  checkRemoteVisibility,
  KNOWN_GIT_PROVIDERS,
  knownHttpsProvider,
  normalizeRemoteUrl,
  parseLsRemote,
  probeRemote,
  publicRemoteWarning,
  remoteFailureMessage,
  remoteUrlProblem,
  resolveRemoteArg,
} from './remote.ts';
export type { InitWarning, InitWarningCode } from './shared.ts';
export { GitIdentityError } from './shared.ts';
export type { BrainTemplateOptions, TemplateFile } from './template.ts';
export {
  AGENTS_MD_CONTENT,
  brainTemplateDirs,
  brainTemplateFiles,
  CLAUDE_MD_CONTENT,
  REQUIRED_GITATTRIBUTES_LINES,
  REQUIRED_GITIGNORE_LINES,
} from './template.ts';
