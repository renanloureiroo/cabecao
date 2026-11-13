// API pública da busca por significado: quantização int8, armazém de vetores em memória, fusão com a palavra-chave e
// métricas do `cabecao eval`. Não conhece o banco nem o modelo: recebe vetores e candidatos prontos.
export type {
  CompareOptions,
  ConfigReport,
  EvalConfig,
  EvalHit,
  EvalMetric,
  EvalReport,
  FusionEvalOptions,
  MetricSummary,
  PairedDifference,
  QuestionResult,
} from './eval.ts';
export {
  compareConfigs,
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_EVAL_ALPHAS,
  DEFAULT_EVAL_K,
  EVAL_METRICS,
  evaluateRankings,
  fusionEvalConfigs,
  normalizeEvalRef,
  pairedDifference,
  scoreQuestion,
  summarize,
} from './eval.ts';
export type {
  FusedChunk,
  FusedNote,
  FusionInput,
  FusionMode,
  FusionOptions,
  FusionResult,
  KeywordCandidate,
  VectorCandidate,
} from './fusion.ts';
export { aggregateByNote, compareFused, DEFAULT_FUSION_ALPHA, DEFAULT_FUSION_DEPTH, fuse } from './fusion.ts';
export type { QuantizedVector, VectorRecord } from './quantize.ts';
export {
  assertFiniteVector,
  cosine,
  dequantize,
  INT8_MAX,
  isVectorKey,
  quantizeInt8,
} from './quantize.ts';
export type { EvalQuestion, EvalQuestionsIssue } from './questions.ts';
export { EvalQuestionsError, parseEvalQuestions } from './questions.ts';
export type { VectorHit, VectorSearchOptions, VectorStoreOptions } from './store.ts';
export { VECTOR_OVERHEAD_BYTES, VectorStore } from './store.ts';
