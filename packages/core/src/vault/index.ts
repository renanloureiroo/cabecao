// API pública do vault: leitura, validação e escrita das notas do cérebro.
export type { IndexEntry, LogEntry, RenderIndexOptions } from './catalog.ts';
export {
  appendLogLine,
  collectIndexEntries,
  formatLogLine,
  renderIndexMd,
  writeIndexMd,
} from './catalog.ts';
export type { BrainConfig, CommitConfig, EmbeddingConfig } from './config.ts';
export {
  BRAIN_CONFIG_FILE,
  brainConfigPath,
  brainConfigToJson,
  DEFAULT_INDEX_MD,
  DEFAULT_NOTE_DIRS,
  defaultBrainConfig,
  INVALID_CONFIG_HINT,
  isInvalidConfigError,
  LOG_MD,
  parseBrainConfig,
  readBrainConfig,
  SUPPORTED_SCHEMA_VERSION,
  validateBrainConfig,
  writeBrainConfig,
} from './config.ts';
export type { VaultErrorCode, VaultErrorDetails } from './errors.ts';
export { VaultError } from './errors.ts';
export type { FileNameStyle, NoteFileNameInput } from './filename.ts';
export {
  dirNameProblem,
  FILE_NAME_STYLES,
  fileNameKey,
  fileNameProblem,
  MAX_NOTE_BASENAME_BYTES,
  noteBaseName,
  sanitizeTitleFileName,
  slugify,
  uniqueFileName,
} from './filename.ts';
export type { NoteFile } from './list.ts';
export { listNoteFiles } from './list.ts';
export type { DiskCasePath, ResolveVaultPathOptions } from './paths.ts';
export {
  assertNotePath,
  CLIENT_INSTRUCTION_FILES,
  diskCasePath,
  isBrainControlFile,
  isClientInstructionFile,
  isInNoteDirs,
  isPrivateTarget,
  normalizeRelPath,
  ROOT_CONTROL_FILE_RE,
  resolveVaultPath,
} from './paths.ts';
export type { NoteRead } from './read.ts';
export { hashContent, readNote } from './read.ts';
export type { AmbiguousName, LinkIndex, LinkResolution } from './resolve.ts';
export { buildLinkIndex, findAmbiguousNames, resolveWikiLink } from './resolve.ts';
export type {
  NoteIssue,
  NoteIssueCode,
  NoteIssueSeverity,
  NoteType,
  NoteTypeFields,
  RelationsConfig,
  TrustLevel,
  ValidateNoteInput,
} from './schema.ts';
export {
  ARCHIVE_DIR,
  aliasesOf,
  CANONICAL_FIELDS,
  DATE_FIELDS,
  defaultTrustForOrigin,
  displayTitle,
  FIXED_RELATIONS,
  fieldOrder,
  fieldsForType,
  hasErrors,
  isApprovedByUser,
  isArchivedPath,
  isIsoDate,
  isNoteType,
  isRawPath,
  isValidOrigin,
  isValidScope,
  isWikilinkText,
  linkListFields,
  NOTE_TYPE_DIRS,
  NOTE_TYPES,
  noteDirForType,
  plainLinkText,
  RAW_DIR,
  relationTypes,
  SUPERSEDE_FIELDS,
  TRUST_LEVELS,
  validateNote,
} from './schema.ts';
export type { FrontmatterEdit, SerializeOptions } from './serialize.ts';
export { editFrontmatterText, serializeFrontmatter, serializeNote } from './serialize.ts';
export type {
  ArchiveNoteOptions,
  CreateNoteInput,
  CreateNoteOptions,
  NoteChanges,
  PatchNoteOptions,
  UpdateNoteOptions,
  WriteAction,
  WriteResult,
} from './write.ts';
export {
  addRelation,
  archiveNote,
  createNote,
  localDate,
  patchNote,
  toCommitChange,
  updateNote,
} from './write.ts';
