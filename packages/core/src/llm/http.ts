// Cliente HTTP fino dos provedores de nuvem: `fetch` nativo, sem SDK e sem dependência. Cuida de:
// - tempo limite por tentativa (dentro do tempo da chamada) e cancelamento pelo sinal do chamador;
// - novas tentativas com recuo exponencial SÓ para erro transitório (429, 5xx, 529, falha de rede), respeitando
//   `retry-after` e o tempo que sobra;
// - teto do tamanho da resposta (uma resposta gigante vira `invalid_output`, não estoura a memória);
// - leitura de Server-Sent Events (streaming);
// - redação da credencial em QUALQUER mensagem montada a partir da resposta do provedor.

import type { ProviderErrorKind } from '../ask/types.ts';
import { ProviderError } from '../ask/types.ts';

/** Maior resposta aceita de um provedor. O `ask` pede ~2 mil tokens; 2 MiB é folga de sobra. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
export const DEFAULT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 20_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Segredos que nunca podem aparecer numa mensagem (a chave). */
  readonly secrets: readonly string[];
  readonly retries?: number;
  readonly fetch?: FetchLike;
  /** Espera entre tentativas (testes trocam por uma que não espera). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Nome do provedor nas mensagens ("a API da Anthropic"). */
  readonly label: string;
}

/** Tira a credencial (e o que parece credencial) de um texto vindo de fora. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[chave omitida]');
  }
  // padrões comuns de chave que o provedor possa ecoar (inclusive outra chave, ou um pedaço da nossa)
  return out
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[chave omitida]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[chave omitida]')
    .replace(/\bgsk_[A-Za-z0-9]{12,}/g, '[chave omitida]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [chave omitida]');
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Lê o corpo com teto de tamanho. */
export async function readLimited(response: Response, max: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new ProviderError('invalid_output', `a resposta passou de ${Math.round(max / 1024)} KiB e foi descartada`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Mensagem de erro do corpo JSON (`{error: {message}}` ou `{message}`), curta e redigida. */
function errorDetail(body: string, secrets: readonly string[]): string {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const inner = typeof parsed.error === 'object' && parsed.error !== null ? parsed.error.message : parsed.error;
    if (typeof inner === 'string') message = inner;
    else if (typeof parsed.message === 'string') message = parsed.message;
  } catch {
    // corpo que não é JSON: usa o texto
  }
  return redact(message.replace(/\s+/g, ' '), secrets).slice(0, 300);
}

function kindForStatus(status: number): { kind: ProviderErrorKind; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: 'not_authenticated', retryable: false };
  if (status === 429) return { kind: 'rate_limited', retryable: true };
  if (status === 408) return { kind: 'timeout', retryable: true };
  if (status >= 500) return { kind: 'unknown', retryable: true };
  return { kind: 'unknown', retryable: false };
}

function statusMessage(status: number, label: string, detail: string): string {
  const what =
    status === 401 || status === 403
      ? `${label} recusou a chave (HTTP ${status})`
      : status === 404
        ? `${label} não achou o modelo ou o endereço (HTTP 404)`
        : status === 429
          ? `${label} limitou o uso (HTTP 429: limite de requisições ou de gasto)`
          : status >= 500
            ? `${label} está com problema agora (HTTP ${status})`
            : `${label} recusou o pedido (HTTP ${status})`;
  return detail === '' ? what : `${what}: ${detail}`;
}

/** `retry-after` em segundos ou data HTTP; `null` se ausente ou inválido. */
function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

type Outcome = { readonly response: Response } | { readonly error: ProviderError; readonly waitMs: number | null };

/**
 * Faz o POST com novas tentativas e devolve a resposta com status 2xx (o corpo ainda não lido). Lança `ProviderError`
 * já com a mensagem redigida.
 */
export async function postWithRetry(call: HttpCall): Promise<Response> {
  const doFetch = call.fetch ?? ((url, init) => fetch(url, init));
  const sleep = call.sleep ?? defaultSleep;
  const retries = call.retries ?? DEFAULT_RETRIES;
  const deadline = Date.now() + call.timeoutMs;
  const timer = AbortSignal.timeout(call.timeoutMs);
  const overall = call.signal === undefined ? timer : AbortSignal.any([call.signal, timer]);
  const cancelled = (): ProviderError => new ProviderError('cancelled', 'cancelado');
  const userAborted = (): boolean => call.signal?.aborted === true;

  const once = async (): Promise<Outcome> => {
    let response: Response;
    try {
      response = await doFetch(call.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...call.headers },
        body: JSON.stringify(call.body),
        signal: overall,
      });
    } catch (error) {
      if (call.signal?.aborted === true) throw cancelled();
      if (timer.aborted || isAbort(error)) {
        throw new ProviderError('timeout', `${call.label} não respondeu em ${Math.round(call.timeoutMs / 1000)} s`, {
          retryable: true,
        });
      }
      const cause =
        error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
      return {
        error: new ProviderError('network', `não consegui falar com ${call.label}: ${redact(cause, call.secrets)}`, {
          retryable: true,
        }),
        waitMs: null,
      };
    }
    if (response.ok) return { response };
    const body = await readLimited(response, MAX_ERROR_BYTES).catch(() => '');
    const { kind, retryable } = kindForStatus(response.status);
    const error = new ProviderError(kind, statusMessage(response.status, call.label, errorDetail(body, call.secrets)), {
      retryable,
      status: response.status,
    });
    if (!retryable) throw error;
    return { error, waitMs: retryAfterMs(response) };
  };

  for (let attempt = 0; ; attempt++) {
    if (userAborted()) throw cancelled();
    const outcome = await once();
    if ('response' in outcome) return outcome.response;
    if (attempt >= retries) throw outcome.error;
    const delay = Math.min(MAX_RETRY_DELAY_MS, outcome.waitMs ?? 500 * 2 ** attempt + Math.floor(Math.random() * 250));
    // não adianta esperar além do tempo da chamada
    if (Date.now() + delay >= deadline) throw outcome.error;
    try {
      await sleep(delay, overall);
    } catch {
      throw userAborted() ? cancelled() : outcome.error;
    }
  }
}

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

/** Lê um corpo `text/event-stream` evento a evento, com teto de tamanho. */
export async function* readSse(response: Response, max: number = MAX_RESPONSE_BYTES): AsyncGenerator<SseEvent> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  const parse = (block: string): SseEvent | null => {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length === 0 && event === null ? null : { event, data: data.join('\n') };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        throw new ProviderError(
          'invalid_output',
          `a resposta passou de ${Math.round(max / 1024)} KiB e foi descartada`,
        );
      }
      buffer += decoder.decode(value, { stream: true });
      let split = /\r?\n\r?\n/.exec(buffer);
      while (split !== null) {
        const block = buffer.slice(0, split.index);
        buffer = buffer.slice(split.index + split[0].length);
        const event = parse(block);
        if (event !== null) yield event;
        split = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    const event = parse(buffer);
    if (event !== null && buffer.trim() !== '') yield event;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Converte um erro durante a leitura do corpo (tempo, cancelamento, rede) em `ProviderError`. */
export function bodyError(
  error: unknown,
  call: Pick<HttpCall, 'signal' | 'timeoutMs' | 'label' | 'secrets'>,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (call.signal?.aborted === true) return new ProviderError('cancelled', 'cancelado');
  if (isAbort(error)) {
    return new ProviderError(
      'timeout',
      `${call.label} não terminou a resposta em ${Math.round(call.timeoutMs / 1000)} s`,
      {
        retryable: true,
      },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(
    'network',
    `a conexão com ${call.label} caiu no meio da resposta: ${redact(message, call.secrets)}`,
    {
      retryable: true,
    },
  );
}

/**
 * Endereço base aceito para um provedor compatível com OpenAI: só `https`, ou `http` em `localhost`/`127.0.0.1`/`[::1]`
 * (servidor local). Sem usuário e senha na URL. Devolve a URL normalizada (sem barra no fim) ou lança com o motivo.
 */
export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`"${value}" não é um endereço válido (exemplo: https://api.exemplo.com/v1)`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('o endereço não pode ter usuário ou senha; a chave vai separada');
  }
  if (url.search !== '' || url.hash !== '') throw new Error('o endereço base não pode ter "?" nem "#"');
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('use https (http só vale para um servidor nesta máquina: localhost ou 127.0.0.1)');
  }
  return url.toString().replace(/\/+$/, '');
}

/** O endereço aponta para esta máquina. */
export function isLocalUrl(value: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}
