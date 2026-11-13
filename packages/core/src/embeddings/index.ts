// API pública do serviço de embeddings do cérebro (marco 2): contrato com o runtime injetado, cálculo do que falta,
// vetores em memória, estado local desta máquina e gravação do modelo no `.cabecao.json`.
export type { WriteEmbeddingConfigOptions, WriteEmbeddingConfigResult } from './config.ts';
export { describeEmbedding, writeEmbeddingConfig } from './config.ts';
export type { ComputeOptions, ComputeResult, EngineOptions } from './engine.ts';
export {
  DEFAULT_EMBED_ROUND,
  EmbedderMismatchError,
  EmbeddingConfigProblem,
  EmbeddingEngine,
  resolveFromConfig,
} from './engine.ts';
export type { LocalEmbeddingState } from './local.ts';
export {
  LOCAL_EMBEDDINGS_FILE,
  localEmbeddingsPath,
  readLocalEmbeddingState,
  setLocalEmbeddingsDisabled,
} from './local.ts';
export type {
  EmbedderLike,
  EmbeddingAvailability,
  EmbeddingLoadProgress,
  EmbeddingProvider,
  EmbedKind,
  EmbedProgress,
  EmbedStep,
  EmbedText,
  ResolvedEmbedding,
} from './types.ts';
export { EMBED_STEPS } from './types.ts';
