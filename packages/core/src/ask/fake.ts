// Provedor FALSO, determinístico, para os testes e para o `eval --answers` sem rede. Não chama nada: responde com uma
// função (ou um objeto fixo), grava o que recebeu, simula atraso, tempo limite, erros em sequência e streaming.
import type { GenerateRequest, GenerateResult, GenerationProvider, ProviderErrorKind, ProviderKind } from './types.ts';
import { ProviderError } from './types.ts';

export type FakeResponder = (request: GenerateRequest, call: number) => unknown;

export interface FakeProviderOptions {
  readonly id?: string;
  readonly kind?: ProviderKind;
  readonly destination?: string;
  readonly model?: string | null;
  readonly leavesMachine?: boolean;
  /** Função que devolve o objeto da resposta, ou um objeto fixo. Padrão: `extractiveResponder`. */
  readonly responder?: FakeResponder | object;
  /** Erros lançados nas primeiras chamadas, um por chamada, antes de responder. */
  readonly failures?: readonly ProviderErrorKind[];
  /** `check()` falha com este motivo. */
  readonly unavailable?: string;
  readonly delayMs?: number;
  /** Divide a resposta em pedaços e chama `onText` (streaming). */
  readonly streamChunks?: number;
}

export interface FakeProvider extends GenerationProvider {
  /** Tudo o que o provedor recebeu, em ordem. */
  readonly calls: GenerateRequest[];
  readonly checks: number;
}

/** Os trechos da mensagem do usuário, como o `ask` monta: rótulo e texto (sem os `^`). */
export function parseSentPassages(user: string): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  const marker = /Marca dos delimitadores desta mensagem: ([0-9a-f]+)/.exec(user)?.[1];
  if (marker === undefined) return out;
  // o bloco começa pelo cabeçalho (caminho e título) até "---"; o texto do trecho vem depois
  const re = new RegExp(`<<<TRECHO ${marker} (S\\d+)>>>\\n[\\s\\S]*?\\n---\\n([\\s\\S]*?)\\n<<<FIM ${marker}>>>`, 'g');
  for (const match of user.matchAll(re))
    out.push({ label: match[1] as string, text: (match[2] as string).replace(/\^/g, ' ') });
  return out;
}

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate_limited', 'timeout', 'network']);

/**
 * Responde citando o primeiro trecho que tem algum termo da pergunta (a primeira frase dele, literal). Sem trecho que
 * case: `not_found`. Serve para medir o encanamento (rótulos, citações, recusa), não a qualidade de um modelo.
 */
export const extractiveResponder: FakeResponder = (request) => {
  const question = /^Pergunta: (.*)$/m.exec(request.user)?.[1] ?? '';
  const terms = question
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 3);
  const passages = parseSentPassages(request.user);
  for (const passage of passages) {
    const norm = passage.text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (!terms.some((term) => norm.includes(term))) continue;
    const sentence = (passage.text.split(/(?<=[.!?])\s+/).find((s) => s.trim().length >= 12) ?? passage.text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    return { status: 'answered', claims: [{ text: sentence, sources: [passage.label], quote: sentence }], missing: '' };
  }
  return { status: 'not_found', claims: [], missing: 'nenhum trecho trata do assunto da pergunta' };
};

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const calls: GenerateRequest[] = [];
  let checks = 0;
  const failures = [...(options.failures ?? [])];
  const responder: FakeResponder =
    typeof options.responder === 'function'
      ? (options.responder as FakeResponder)
      : options.responder === undefined
        ? extractiveResponder
        : () => options.responder;
  return {
    id: options.id ?? 'falso',
    kind: options.kind ?? 'fake',
    destination: options.destination ?? 'provedor falso (testes)',
    leavesMachine: options.leavesMachine ?? false,
    model: options.model === undefined ? 'falso-1' : options.model,
    calls,
    get checks() {
      return checks;
    },
    async check() {
      checks++;
      return options.unavailable === undefined
        ? { ok: true }
        : { ok: false, kind: 'not_installed', reason: options.unavailable };
    },
    async generate(request) {
      calls.push(request);
      const started = performance.now();
      const delay = options.delayMs ?? 0;
      if (delay > 0) {
        try {
          await sleep(Math.min(delay, request.timeoutMs), request.signal);
        } catch {
          throw new ProviderError('cancelled', 'cancelado', { retryable: false });
        }
        if (delay > request.timeoutMs) {
          throw new ProviderError('timeout', `sem resposta em ${request.timeoutMs} ms`, { retryable: true });
        }
      }
      const failure = failures.shift();
      if (failure !== undefined) {
        throw new ProviderError(failure, `falha simulada: ${failure}`, { retryable: RETRYABLE.has(failure) });
      }
      const object = await responder(request, calls.length);
      if (request.onText !== undefined) {
        const text = JSON.stringify(object);
        const pieces = Math.max(1, options.streamChunks ?? 1);
        const size = Math.ceil(text.length / pieces);
        for (let i = 0; i < text.length; i += size) request.onText(text.slice(i, i + size));
      }
      const result: GenerateResult = {
        object,
        usage: { inputTokens: Math.ceil((request.system.length + request.user.length) / 4), outputTokens: 50 },
        costUsd: null,
        durationMs: Math.round(performance.now() - started),
      };
      return result;
    },
  };
}
