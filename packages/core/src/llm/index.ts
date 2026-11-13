// Provedores de geração por HTTP (decisão 38) e a configuração `llm.json` desta máquina. O agente instalado (Claude
// Code) roda como processo e mora na CLI.
export type {
  AgentProviderEntry,
  AgentProviderId,
  HttpProviderEntry,
  KeyRef,
  LlmConfig,
  LlmLimits,
  ProviderEntry,
} from './config.ts';
export {
  AGENT_PROVIDER_IDS,
  activeProviderIds,
  BASE_URL_PRESETS,
  CONSENT_KEY_FILE,
  consentValid,
  DEFAULT_LLM_LIMITS,
  emptyLlmConfig,
  entryDestination,
  isKeyRef,
  LLM_CONFIG_FILE,
  LlmConfigError,
  llmConfigPath,
  PROVIDER_ID_RE,
  readConsentSecret,
  readLlmConfig,
  signConsent,
  validateLlmConfig,
  writeLlmConfig,
} from './config.ts';
export type { FetchLike, HttpCall, SseEvent } from './http.ts';
export { isLocalUrl, MAX_RESPONSE_BYTES, postWithRetry, readSse, redact, validateBaseUrl } from './http.ts';
export type { DataPolicy, HttpApi, HttpPreset, HttpPresetId } from './presets.ts';
export {
  GEMINI_FREE_TIER_WARNING,
  HTTP_PRESET_IDS,
  HTTP_PRESETS,
  isHttpPresetId,
  isOllamaCloudModel,
} from './presets.ts';
export type { HttpProviderOptions } from './providers.ts';
export { ANTHROPIC_VERSION, createHttpProvider } from './providers.ts';
