// Contrato do provedor de geração do `ask` (decisão 38: RAG opcional com provedor de geração). O núcleo não sabe falar
// com nenhum provedor: recebe uma lista já montada (pela CLI, a partir de `<configDir>/llm.json`), na ordem de recuo, e
// só chama `check()` e `generate()`. O agente que usa o Cabeção nunca vê nada daqui: a saída do `ask` não diz qual
// provedor nem qual modelo gerou a resposta.

/** JSON Schema (subconjunto aceito pelos modos estritos dos provedores), sem `$ref` externo. */
export interface JsonSchema {
  readonly [key: string]: unknown;
}

export interface GenerateRequest {
  readonly system: string;
  /** Pergunta e trechos já montados e delimitados. */
  readonly user: string;
  /** Esquema da resposta: o `ask` sempre pede JSON estruturado. */
  readonly schema: JsonSchema;
  readonly maxOutputTokens: number;
  /** Tempo limite desta chamada (o provedor decide se há novas tentativas dentro dele). */
  readonly timeoutMs: number;
  /** Cancelamento (Ctrl+C, fim do tempo total, cliente MCP que desistiu). */
  readonly signal?: AbortSignal;
  /** Texto bruto conforme chega, quando o provedor transmite aos poucos (streaming). */
  readonly onText?: (delta: string) => void;
}

export interface GenerateResult {
  /** O objeto devolvido pelo provedor, ainda não validado: o núcleo valida contra o esquema. */
  readonly object: unknown;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
  /** Custo em dólares, só quando o provedor informa. */
  readonly costUsd: number | null;
  readonly durationMs: number;
}

export const PROVIDER_ERROR_KINDS = [
  'not_installed',
  'not_authenticated',
  'rate_limited',
  'timeout',
  'refused',
  'invalid_output',
  'network',
  'cancelled',
  'unknown',
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export interface ProviderErrorOptions {
  /** Vale tentar de novo (no mesmo provedor, depois de um tempo) ou passar ao próximo. */
  readonly retryable?: boolean;
  /** Código HTTP, quando veio de uma API. */
  readonly status?: number;
  readonly cause?: unknown;
}

/**
 * Falha de um provedor. A mensagem já vem em português e SEM credencial (os adaptadores redigem a chave antes de
 * montar a mensagem); ela vai só para o log, o `--verbose`, o `llm status` e o `doctor`, nunca para o agente.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

/** Resultado de `check()`: barato, sem chamar o modelo. `reason` só aparece para o usuário (status, doctor). */
export interface Availability {
  readonly ok: boolean;
  readonly kind?: ProviderErrorKind;
  readonly reason?: string;
}

export type ProviderKind = 'agent' | 'http' | 'fake';

export interface GenerationProvider {
  /** Nome do provedor no `llm.json` (o usuário escolhe). */
  readonly id: string;
  readonly kind: ProviderKind;
  /** Para onde o conteúdo vai: "Anthropic (API)", "Google (API do Gemini)", "servidor local em localhost:11434"... */
  readonly destination: string;
  /** `false` só para servidor local (localhost) que não repassa a outro serviço. */
  readonly leavesMachine: boolean;
  /** Modelo pedido, quando há um; só para o usuário (status, log, `--verbose`). */
  readonly model: string | null;
  check(): Promise<Availability>;
  /** Lança `ProviderError` em qualquer falha. */
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
