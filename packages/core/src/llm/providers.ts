// Os dois adaptadores HTTP, escritos à mão com `fetch`:
//
// - Anthropic Messages: `POST {base}/v1/messages`, `x-api-key`, `anthropic-version: 2026-10-21`, saída estruturada em
//   `output_config.format: {type: "json_schema", schema}`, streaming por SSE (`content_block_delta` com `text_delta`,
//   `message_delta` com `stop_reason` e o uso). Fonte: documentação da API da Claude (skill oficial, conferida em
//   13/11/2026).
// - Chat Completions compatível com OpenAI: `POST {base}/chat/completions`, `Authorization: Bearer`, saída estruturada
//   em `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`, streaming por SSE até
//   `data: [DONE]`. Serve para OpenAI, Gemini (endpoint compatível, ainda em beta), OpenRouter, Groq e servidores
//   locais (Ollama, LM Studio). Fonte: referência da API da OpenAI (Context7) e páginas de cada provedor, 13/11/2026.
//
// A chave é lida só na hora (`resolveKey`) e nunca entra em mensagem: todo texto vindo do provedor passa por `redact`.

import { parseJsonText } from '../ask/schema.ts';
import type { Availability, GenerateRequest, GenerateResult, GenerationProvider } from '../ask/types.ts';
import { ProviderError } from '../ask/types.ts';
import type { FetchLike, HttpCall } from './http.ts';
import { bodyError, isLocalUrl, MAX_RESPONSE_BYTES, postWithRetry, readLimited, readSse, redact } from './http.ts';
import type { HttpPreset } from './presets.ts';
import { isOllamaCloudModel } from './presets.ts';

export const ANTHROPIC_VERSION = '2026-10-21';

export interface HttpProviderOptions {
  readonly id: string;
  readonly preset: HttpPreset;
  readonly model: string;
  /** Endereço base; padrão o do preset. */
  readonly baseUrl?: string;
  /** Lê a chave (variável, chaveiro, arquivo). `null`: não há. A mensagem de `missing` diz onde deveria estar. */
  readonly resolveKey: () => Promise<{ readonly key: string | null; readonly missing: string }>;
  /** A chave é obrigatória (padrão: a do preset; um serviço compatível sem chave passa `false`). */
  readonly requireKey?: boolean;
  readonly fetch?: FetchLike;
  readonly sleep?: HttpCall['sleep'];
  readonly retries?: number;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseOutput(text: string, label: string, secrets: readonly string[]): unknown {
  try {
    return parseJsonText(text);
  } catch {
    throw new ProviderError(
      'invalid_output',
      `${label} devolveu algo que não é o JSON pedido: ${redact(text.replace(/\s+/g, ' ').slice(0, 160), secrets)}`,
    );
  }
}

interface Accumulated {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stop: string | null;
  refusal: string;
}

async function anthropicGenerate(
  options: HttpProviderOptions,
  key: string,
  request: GenerateRequest,
): Promise<GenerateResult> {
  const started = performance.now();
  const base = (options.baseUrl ?? options.preset.baseUrl ?? '').replace(/\/+$/, '');
  const label = 'a API da Anthropic';
  const call: HttpCall = {
    url: `${base}/v1/messages`,
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, accept: 'text/event-stream' },
    body: {
      model: options.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      output_config: { format: { type: 'json_schema', schema: request.schema } },
      stream: true,
    },
    timeoutMs: request.timeoutMs,
    secrets: [key],
    label,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
  };
  const response = await postWithRetry(call);
  const acc: Accumulated = { text: '', inputTokens: null, outputTokens: null, stop: null, refusal: '' };
  try {
    for await (const event of readSse(response)) {
      if (event.data === '') continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = data.type ?? event.event;
      if (type === 'message_start') {
        const usage = (data.message as { usage?: Record<string, unknown> } | undefined)?.usage;
        acc.inputTokens = num(usage?.input_tokens);
      } else if (type === 'content_block_delta') {
        const delta = data.delta as { type?: unknown; text?: unknown } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          acc.text += delta.text;
          request.onText?.(delta.text);
        }
      } else if (type === 'message_delta') {
        const delta = data.delta as { stop_reason?: unknown } | undefined;
        if (typeof delta?.stop_reason === 'string') acc.stop = delta.stop_reason;
        acc.outputTokens = num((data.usage as Record<string, unknown> | undefined)?.output_tokens) ?? acc.outputTokens;
      } else if (type === 'error') {
        const error = data.error as { type?: unknown; message?: unknown } | undefined;
        const overloaded = error?.type === 'overloaded_error' || error?.type === 'rate_limit_error';
        throw new ProviderError(
          overloaded ? 'rate_limited' : 'unknown',
          `${label} interrompeu a resposta: ${redact(String(error?.message ?? error?.type ?? 'erro'), [key])}`,
          { retryable: overloaded },
        );
      }
    }
  } catch (error) {
    throw bodyError(error, call);
  }
  if (acc.stop === 'refusal') throw new ProviderError('refused', `${label} recusou responder (filtro de segurança)`);
  if (acc.stop === 'max_tokens') {
    throw new ProviderError(
      'invalid_output',
      `a resposta passou do limite de ${request.maxOutputTokens} tokens de saída e veio cortada`,
    );
  }
  return {
    object: parseOutput(acc.text, label, [key]),
    usage: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
    costUsd: null,
    durationMs: Math.round(performance.now() - started),
  };
}

async function compatibleGenerate(
  options: HttpProviderOptions,
  key: string | null,
  request: GenerateRequest,
): Promise<GenerateResult> {
  const started = performance.now();
  const preset = options.preset;
  const base = (options.baseUrl ?? preset.baseUrl ?? '').replace(/\/+$/, '');
  const label = preset.id === 'compatible' ? `o serviço em ${base}` : preset.label;
  const secrets = key === null ? [] : [key];
  const stream = preset.stream;
  const call: HttpCall = {
    url: `${base}/chat/completions`,
    headers: {
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      ...(stream ? { accept: 'text/event-stream' } : {}),
    },
    body: {
      model: options.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'cabecao_answer', strict: true, schema: request.schema },
      },
      [preset.maxTokensField]: request.maxOutputTokens,
      ...(stream ? { stream: true } : {}),
      ...(stream && preset.streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...preset.extraBody,
    },
    timeoutMs: request.timeoutMs,
    secrets,
    label,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
  };
  const response = await postWithRetry(call);
  const acc: Accumulated = { text: '', inputTokens: null, outputTokens: null, stop: null, refusal: '' };
  const usageOf = (usage: unknown): void => {
    if (typeof usage !== 'object' || usage === null) return;
    const u = usage as Record<string, unknown>;
    acc.inputTokens = num(u.prompt_tokens) ?? acc.inputTokens;
    acc.outputTokens = num(u.completion_tokens) ?? acc.outputTokens;
  };
  try {
    if (stream) {
      for await (const event of readSse(response)) {
        if (event.data === '[DONE]') break;
        if (event.data === '') continue;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof data.error === 'object' && data.error !== null) {
          const message = String((data.error as { message?: unknown }).message ?? 'erro');
          throw new ProviderError('unknown', `${label} interrompeu a resposta: ${redact(message, secrets)}`);
        }
        usageOf(data.usage);
        const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
        if (choice === undefined) continue;
        const delta = choice.delta as { content?: unknown; refusal?: unknown } | undefined;
        if (typeof delta?.content === 'string' && delta.content !== '') {
          acc.text += delta.content;
          request.onText?.(delta.content);
        }
        if (typeof delta?.refusal === 'string') acc.refusal += delta.refusal;
        if (typeof choice.finish_reason === 'string') acc.stop = choice.finish_reason;
      }
    } else {
      const text = await readLimited(response, MAX_RESPONSE_BYTES);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new ProviderError('invalid_output', `${label} devolveu uma resposta que não é JSON`);
      }
      usageOf(data.usage);
      const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const message = choice?.message as { content?: unknown; refusal?: unknown } | undefined;
      if (typeof message?.content === 'string') {
        acc.text = message.content;
        request.onText?.(message.content);
      }
      if (typeof message?.refusal === 'string') acc.refusal = message.refusal;
      if (typeof choice?.finish_reason === 'string') acc.stop = choice.finish_reason;
    }
  } catch (error) {
    throw bodyError(error, call);
  }
  if (acc.refusal.trim() !== '' || acc.stop === 'content_filter') {
    throw new ProviderError('refused', `${label} recusou responder (filtro de conteúdo)`);
  }
  if (acc.stop === 'length') {
    throw new ProviderError(
      'invalid_output',
      `a resposta passou do limite de ${request.maxOutputTokens} tokens de saída e veio cortada`,
    );
  }
  return {
    object: parseOutput(acc.text, label, secrets),
    usage: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
    costUsd: null,
    durationMs: Math.round(performance.now() - started),
  };
}

/** Um provedor HTTP pronto para o `ask`. */
export function createHttpProvider(options: HttpProviderOptions): GenerationProvider {
  const preset = options.preset;
  const baseUrl = options.baseUrl ?? preset.baseUrl ?? '';
  const local = isLocalUrl(baseUrl);
  const leavesMachine = !local || isOllamaCloudModel(options.model);
  const requireKey = options.requireKey ?? preset.needsKey;
  let cached: string | null | undefined;
  const key = async (): Promise<{ key: string | null; missing: string }> => {
    if (cached !== undefined) return { key: cached, missing: '' };
    const found = await options.resolveKey();
    if (found.key !== null) cached = found.key;
    return found;
  };
  return {
    id: options.id,
    kind: 'http',
    destination: preset.id === 'compatible' ? `o serviço em ${baseUrl}` : preset.destination,
    leavesMachine,
    model: options.model,
    async check(): Promise<Availability> {
      if (baseUrl === '') return { ok: false, kind: 'not_installed', reason: 'sem endereço base configurado' };
      if (!requireKey) return { ok: true };
      const found = await key();
      return found.key === null ? { ok: false, kind: 'not_authenticated', reason: found.missing } : { ok: true };
    },
    async generate(request) {
      const found = requireKey ? await key() : { key: null, missing: '' };
      if (requireKey && found.key === null) {
        throw new ProviderError('not_authenticated', found.missing || 'a chave não foi encontrada');
      }
      if (preset.api === 'anthropic') return anthropicGenerate(options, found.key as string, request);
      return compatibleGenerate(options, found.key, request);
    },
  };
}
