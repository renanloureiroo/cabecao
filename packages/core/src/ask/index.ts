// API pública do `ask` (decisão 38): recuperação, filtro do que pode sair, prompt, verificação das citações, o provedor
// falso e a avaliação das respostas. Os adaptadores de provedor de verdade moram em `../llm/` (HTTP) e na CLI (agente).
export type {
  AskAttempt,
  AskCitation,
  AskClaim,
  AskDiagnostics,
  AskLimits,
  AskOptions,
  AskOutput,
  AskPassage,
  AskProgress,
  AskResult,
  AskStatus,
  PreparedAsk,
  StreamedClaim,
  UnavailableReason,
} from './engine.ts';
export {
  ASK_STATUSES,
  AskCancelledError,
  ask,
  assembleAnswer,
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_REQUESTS_PER_QUESTION,
  MIN_FUSION_SCORE,
  normalizeAskInput,
  prepareAsk,
  UNAVAILABLE_REASONS,
} from './engine.ts';
export type { AnswerEvalReport, AnswerQuestion, AnswerQuestionResult, Ratio } from './eval.ts';
export { AnswerQuestionsError, evaluateAnswers, parseAnswerQuestions } from './eval.ts';
export type { FakeProvider, FakeProviderOptions, FakeResponder } from './fake.ts';
export { createFakeProvider, extractiveResponder, parseSentPassages } from './fake.ts';
export type { AskBrain, AskInput, Passage, Retrieval } from './passages.ts';
export { DEFAULT_ASK_LIMIT, MAX_ASK_LIMIT, MAX_QUESTION_CHARS, normalizeForMatch, textWindows } from './passages.ts';
export type { ExclusionReason, LlmPolicy, LlmPolicyAllow } from './policy.ts';
export {
  globToRegExp,
  hasPrivateBodyTag,
  isPrivateNote,
  LLM_POLICY_ALLOW,
  LLM_POLICY_FIELDS,
  LLM_POLICY_KEY,
  llmPolicyLookalikes,
  PRIVATE_FIELD,
  readLlmPolicy,
} from './policy.ts';
export type { BuiltPrompt, Omitted, Outbound, SentPassage } from './prompt.ts';
export {
  buildPrompt,
  DEFAULT_CONTEXT_TOKENS,
  datamark,
  MAX_CONTEXT_TOKENS,
  neutralizeDelimiters,
  SYSTEM_PROMPT,
  selectOutbound,
  validityText,
} from './prompt.ts';
export type { RawAnswer, RawClaim } from './schema.ts';
export { ANSWER_SCHEMA, completedClaims, parseJsonText, sanitizeText, validateAnswer } from './schema.ts';
export type {
  Availability,
  GenerateRequest,
  GenerateResult,
  GenerationProvider,
  JsonSchema,
  ProviderErrorKind,
  ProviderKind,
  RequestBudget,
} from './types.ts';
export { PROVIDER_ERROR_KINDS, ProviderError, spendRequest } from './types.ts';
export { MIN_QUOTE_CHARS, normalizeLabel, quoteMatches } from './verify.ts';
