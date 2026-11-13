// Runtime opcional de embeddings do Cabeção. Este pacote não tem dependências de runtime: o onnxruntime e o
// tokenizador são instalados sob demanda no diretório de cache do usuário e carregados por `import()` dinâmico.

export type { CatalogModel, CatalogVariant, Pooling, PromptTemplates } from './catalog.ts';
export { CATALOG_MODEL_NAMES, findCatalogModel, MODEL_CATALOG, POOLINGS } from './catalog.ts';
export type { CatalogEmbeddingConfig, CustomEmbeddingConfig, EmbeddingConfig, ModelSpec } from './config.ts';
export { catalogConfig, DEFAULT_REVISION, resolveEmbeddingConfig, specKey } from './config.ts';
export type { DownloadOptions, DownloadProgress, ModelCacheStatus, ModelFiles } from './download.ts';
export { DEFAULT_HF_ENDPOINT, ensureModelFiles, MODELS_DIR_NAME, modelCacheStatus, modelDir } from './download.ts';
export type { CreateOnnxEmbedderParams, Embedder, EmbedderBackend, LoadEmbedderOptions } from './embedder.ts';
export { createOnnxEmbedder, DEFAULT_BATCH_SIZE, DEFAULT_MAX_BATCH_TOKENS, loadEmbedder } from './embedder.ts';
export {
  DimensionMismatchError,
  EmbeddingConfigError,
  EmbeddingsError,
  EmbeddingsNetworkError,
  ModelLoadError,
  ModelNotFoundError,
  NpmNotFoundError,
  RuntimeInstallError,
  RuntimeNotInstalledError,
  RuntimeUnavailableError,
  UnknownModelError,
  UnsupportedRecipeError,
} from './errors.ts';
export { createFakeEmbedder } from './fake.ts';
export type { TokenizerLike } from './inference.ts';
export { dot } from './inference.ts';
export type { FindNpmContext, NpmCommand, NpmRunner, NpmRunRequest, NpmRunResult } from './npm.ts';
export { findNpm } from './npm.ts';
export type { ProbeResult, RuntimeProbe } from './probe.ts';
export type { EmbedInput, EmbedKind } from './prompt.ts';
export { formatInput } from './prompt.ts';
export type {
  InstallProgress,
  InstallRuntimeOptions,
  InstallRuntimeResult,
  OrtModule,
  OrtSession,
  OrtTensor,
  RuntimeBackend,
  RuntimeImporter,
  RuntimeModule,
  RuntimeStatus,
  RuntimeStatusOptions,
  UninstallRuntimeOptions,
  UninstallRuntimeResult,
} from './runtime.ts';
export {
  installRuntime,
  LOADER_FILE,
  loadRuntime,
  RUNTIME_DIR_NAME,
  RUNTIME_PACKAGES,
  runtimeDir,
  runtimeStatus,
  uninstallRuntime,
} from './runtime.ts';
