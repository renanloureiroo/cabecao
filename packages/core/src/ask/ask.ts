// O `ask`: recupera, filtra o que pode sair, monta o prompt, chama o provedor configurado (com recuo para o próximo),
// valida a forma, verifica cada citação e devolve SEMPRE o mesmo formato, qualquer que seja o provedor. Função pura em
// relação ao provedor: ele chega por injeção (a CLI monta a lista a partir de `<configDir>/llm.json`), e os testes usam
// o provedor falso.
//
// Transparência (decisão 38): a saída para o agente não diz qual provedor nem qual modelo gerou a resposta. Isso fica
// só em `AskResult.diagnostics`, que a CLI mostra com `--verbose` e grava no log local.

import type { DataEnvelope } from '../brain/envelope.ts';
import { DATA_NOTICE } from '../brain/envelope.ts';
import { BrainError } from '../brain/errors.ts';
import type { Validity } from '../db/search.ts';
import { estimateTokens, HEADING_PATH_SEPARATOR } from '../markdown/chunks.ts';
import type { AskBrain, AskInput, Passage, Retrieval } from './passages.ts';
import { DEFAULT_ASK_LIMIT, MAX_ASK_LIMIT, MAX_QUESTION_CHARS, retrievePassages } from './passages.ts';
import type { LlmPolicy } from './policy.ts';
import { readLlmPolicy } from './policy.ts';
import type { BuiltPrompt, Omitted, Outbound, SentPassage } from './prompt.ts';
import { buildPrompt, DEFAULT_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS, selectOutbound } from './prompt.ts';
import type { RawAnswer } from './schema.ts';
import { ANSWER_SCHEMA, completedClaims, validateAnswer } from './schema.ts';
import type { GenerationProvider, ProviderErrorKind } from './types.ts';
import { ProviderError } from './types.ts';
import type { VerifiedClaim } from './verify.ts';
import { verifyClaim } from './verify.ts';

export const ASK_STATUSES = ['answered', 'not_found', 'low_confidence', 'unavailable'] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];

export const UNAVAILABLE_REASONS = ['not_configured', 'disabled_for_brain', 'provider_failed'] as const;
/**
 * Por que não houve resposta gerada, sem nada do provedor: nenhum ativado nesta máquina; o cérebro não deixa
 * (`llm_policy`); ou o provedor falhou (fora do ar, sem login, tempo limite, saída fora do formato, recusa).
 */
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * Pontuação mínima da fusão (busca híbrida ou por significado) para valer a pena chamar o provedor. Constante inicial
 * da especificação, AINDA NÃO CALIBRADA com `cabecao eval --answers`; na busca só por palavra-chave a pontuação é o
 * BM25, sem escala fixa, e a pré-checagem só olha se houve resultado.
 */
export const MIN_FUSION_SCORE = 0.35;

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;
/** Teto de tempo da pergunta inteira, somadas as tentativas e o recuo entre provedores. */
export const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
/** Quanto dos trechos recuperados volta ao agente quando não há resposta gerada. */
export const PASSAGES_OUT_TOKENS = 6000;

export interface AskClaim {
  readonly text: string;
  /** A afirmação tem ao menos uma citação conferida. */
  readonly supported: boolean;
  /** Números das citações (`[1]`, `[2]`), na lista `citations`. */
  readonly citations: readonly number[];
}

export interface AskCitation {
  readonly n: number;
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly heading_path: readonly string[];
  /** O que passar a `read` como `section` para abrir o original (`null`: a nota desde o começo). */
  readonly section: string | null;
  /** A citação literal conferida no trecho. */
  readonly quote: string;
  readonly validity: Validity;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly edited_by: string | null;
  /** Entrou como vizinha no grafo, não pela busca. */
  readonly related: boolean;
}

/** Um trecho recuperado, devolvido ao agente quando não há resposta gerada (para ele responder sem nova chamada). */
export interface AskPassage {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly heading_path: readonly string[];
  readonly validity: Validity;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly edited_by: string | null;
  readonly related: boolean;
  readonly content: string;
}

export interface AskOutput extends DataEnvelope {
  readonly status: AskStatus;
  readonly question: string;
  /** A resposta com os marcadores `[1]`; afirmação sem apoio sai com `[sem apoio]`. Vazia quando `unavailable`. */
  readonly answer: string;
  readonly claims: readonly AskClaim[];
  readonly citations: readonly AskCitation[];
  readonly unsupported_claims: number;
  /** Citações descartadas: rótulo inventado ou citação literal que não aparece no trecho. */
  readonly removed_citations: number;
  /** O que faltou no cérebro, segundo a resposta (`null` quando nada). */
  readonly missing: string | null;
  /** O que não foi enviado ao provedor, por motivo. */
  readonly omitted: Omitted;
  readonly as_of: string;
  readonly unavailable_reason?: UnavailableReason;
  /** Só com `unavailable` e `not_found`: os trechos recuperados. */
  readonly passages?: readonly AskPassage[];
  readonly next_step: string;
}

export interface AskAttempt {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly message: string;
}

/** O que só o usuário vê (`--verbose`, log, status): nunca vai para o agente. */
export interface AskDiagnostics {
  readonly provider: string | null;
  readonly model: string | null;
  readonly destination: string | null;
  readonly attempts: readonly AskAttempt[];
  readonly usage: { readonly input_tokens: number | null; readonly output_tokens: number | null };
  readonly cost_usd: number | null;
  readonly duration_ms: number;
  readonly mode_used: string;
  readonly passages_retrieved: number;
  readonly passages_sent: number;
  readonly dropped_claims: number;
  /** Problema na `llm_policy` do cérebro (que fechou o envio), quando há. */
  readonly policy_problem: string | null;
}

export interface AskResult {
  readonly output: AskOutput;
  readonly diagnostics: AskDiagnostics;
}

export interface AskLimits {
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

/** Progresso para o terminal (só a CLI usa). */
export type AskProgress =
  | { readonly stage: 'retrieving' }
  | { readonly stage: 'generating'; readonly attempt: number }
  | { readonly stage: 'verifying' };

/** Uma afirmação já verificada que chegou inteira durante o streaming. */
export interface StreamedClaim {
  readonly index: number;
  readonly text: string;
  readonly supported: boolean;
  readonly labels: readonly string[];
}

export interface AskOptions {
  /** Provedores com consentimento, já filtrados pela máquina, na ordem de recuo. Vazio: `unavailable`. */
  readonly providers: readonly GenerationProvider[];
  readonly limits?: AskLimits;
  readonly signal?: AbortSignal;
  /** Gerador da marca dos delimitadores (testes). */
  readonly random?: () => string;
  readonly onProgress?: (event: AskProgress) => void;
  /** Cada afirmação que chega inteira e já verificada, quando o provedor transmite aos poucos. */
  readonly onClaim?: (claim: StreamedClaim) => void;
  /** Relógio (testes): duração medida. */
  readonly now?: () => number;
}

/** O que seria enviado, sem enviar (`--show-context`) — e a base da chamada de verdade. */
export interface PreparedAsk {
  readonly question: string;
  readonly retrieval: Retrieval;
  readonly policy: LlmPolicy;
  readonly outbound: Outbound;
  readonly prompt: BuiltPrompt;
  readonly asOf: string;
}

function invalid(message: string): BrainError {
  return new BrainError('invalid_argument', message);
}

/** Confere a entrada (a tool já confere a forma; a CLI e o `eval` passam por aqui também). */
export function normalizeAskInput(input: AskInput): AskInput & { readonly limit: number } {
  const question = typeof input?.question === 'string' ? input.question.trim() : '';
  if (question === '') throw invalid('"question" não pode ser vazia');
  if (question.length > MAX_QUESTION_CHARS) throw invalid(`"question" passa de ${MAX_QUESTION_CHARS} caracteres`);
  const limit = input.limit ?? DEFAULT_ASK_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ASK_LIMIT) {
    throw invalid(`"limit" deveria ser um inteiro de 1 a ${MAX_ASK_LIMIT}`);
  }
  return { ...input, question, limit };
}

function clampContext(tokens: number | undefined): number {
  if (tokens === undefined || !Number.isFinite(tokens)) return DEFAULT_CONTEXT_TOKENS;
  return Math.max(500, Math.min(MAX_CONTEXT_TOKENS, Math.trunc(tokens)));
}

/** Recupera, filtra e monta o prompt. Não chama provedor nenhum. */
export async function prepareAsk(
  brain: AskBrain,
  rawInput: AskInput,
  options: Pick<AskOptions, 'limits' | 'random'> = {},
): Promise<PreparedAsk> {
  const input = normalizeAskInput(rawInput);
  const retrieval = await retrievePassages(brain, input, input.limit);
  // a busca relê o .cabecao.json: a política que vale é a de agora
  const policy = readLlmPolicy(brain.config);
  const outbound = selectOutbound(
    retrieval.passages,
    policy,
    brain.config,
    clampContext(options.limits?.contextTokens),
  );
  const prompt = buildPrompt(input.question, retrieval.search.as_of, outbound.passages, options.random);
  return { question: input.question, retrieval, policy, outbound, prompt, asOf: retrieval.search.as_of };
}

function toAskPassage(passage: Passage): AskPassage {
  return {
    id: passage.id,
    path: passage.path,
    title: passage.title,
    type: passage.type,
    heading_path: passage.heading_path,
    validity: passage.validity,
    trust: passage.trust,
    origin: passage.origin,
    edited_by: passage.edited_by,
    related: passage.related,
    content: passage.content,
  };
}

/** Os trechos para o agente, até o orçamento. */
function passagesOut(passages: readonly Passage[]): AskPassage[] {
  const out: AskPassage[] = [];
  let spent = 0;
  for (const passage of passages) {
    const item = toAskPassage(passage);
    const cost = estimateTokens(JSON.stringify(item));
    if (spent + cost > PASSAGES_OUT_TOKENS) break;
    spent += cost;
    out.push(item);
  }
  return out;
}

const NEXT_STEP = {
  answered:
    'Resposta gerada a partir do cérebro, com cada citação conferida no trecho de origem. Para ver o original, use read com o id (e a section) da citação.',
  low_confidence:
    'Mais da metade das afirmações ficou sem citação conferida (marcadas com [sem apoio]). Confira-as com search e read antes de usá-las.',
  not_found:
    'O cérebro não tem isso (ou os trechos não sustentam uma resposta). Não invente: diga ao usuário o que faltou. Os trechos recuperados estão em passages.',
  not_configured:
    'Nenhum provedor de respostas está ativado nesta máquina. Responda você mesmo a partir de passages, ou use search e read. Quem ativa é o usuário, no terminal, com "cabecao llm on".',
  disabled_for_brain:
    'Este cérebro não permite enviar trechos a um provedor de respostas (llm_policy no .cabecao.json). Responda você mesmo a partir de passages, ou use search e read.',
  provider_failed:
    'O provedor de respostas não respondeu agora. Responda você mesmo a partir de passages, ou use search e read.',
} as const;

function sectionOf(passage: Passage): string | null {
  return passage.heading_path.length === 0 ? null : passage.heading_path.join(HEADING_PATH_SEPARATOR);
}

interface Assembled {
  readonly status: AskStatus;
  readonly answer: string;
  readonly claims: AskClaim[];
  readonly citations: AskCitation[];
  readonly unsupported: number;
  readonly removed: number;
}

/** Verifica, numera as citações na ordem de aparição e monta o texto. */
export function assembleAnswer(raw: RawAnswer, sent: readonly SentPassage[]): Assembled {
  const byLabel = new Map(sent.map((item) => [item.label, item]));
  const verified: VerifiedClaim[] = raw.claims.map((claim) => verifyClaim(claim, byLabel));
  const removed = verified.reduce((sum, claim) => sum + claim.rejected.length, 0);
  const unsupported = verified.filter((claim) => !claim.supported).length;
  const supported = verified.length - unsupported;
  if (raw.status === 'not_found' || verified.length === 0 || supported === 0) {
    return { status: 'not_found', answer: '', claims: [], citations: [], unsupported, removed };
  }
  const numbers = new Map<string, number>();
  const citations: AskCitation[] = [];
  const claims: AskClaim[] = verified.map((claim) => {
    const nums = claim.labels.map((label) => {
      const known = numbers.get(label);
      if (known !== undefined) return known;
      const passage = (byLabel.get(label) as SentPassage).passage;
      const n = citations.length + 1;
      numbers.set(label, n);
      citations.push({
        n,
        id: passage.id,
        path: passage.path,
        title: passage.title,
        heading_path: passage.heading_path,
        section: sectionOf(passage),
        quote: claim.quote,
        validity: passage.validity,
        trust: passage.trust,
        origin: passage.origin,
        edited_by: passage.edited_by,
        related: passage.related,
      });
      return n;
    });
    return { text: claim.text, supported: claim.supported, citations: nums };
  });
  const answer = claims
    .map((claim) =>
      claim.supported ? `${claim.text} ${claim.citations.map((n) => `[${n}]`).join('')}` : `${claim.text} [sem apoio]`,
    )
    .join(' ');
  const status: AskStatus = unsupported > verified.length / 2 ? 'low_confidence' : 'answered';
  return { status, answer, claims, citations, unsupported, removed };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 400) ?? '';
}

/** Junta os sinais (cancelamento do chamador e tempo total). */
function combine(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return list.length === 1 ? (list[0] as AbortSignal) : AbortSignal.any(list);
}

/** O usuário cancelou (Ctrl+C) ou o cliente desistiu: não é falha de provedor, é para parar. */
export class AskCancelledError extends Error {
  constructor() {
    super('pergunta cancelada');
    this.name = 'AskCancelledError';
  }
}

/** Faz a pergunta. Erros de argumento (tipo, escopo, data) saem como `BrainError`; falha de provedor nunca lança. */
export async function ask(brain: AskBrain, input: AskInput, options: AskOptions): Promise<AskResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  options.onProgress?.({ stage: 'retrieving' });
  const prepared = await prepareAsk(brain, input, options);
  const { retrieval, policy, outbound, prompt, asOf } = prepared;
  const base = {
    data_notice: DATA_NOTICE,
    question: prepared.question,
    omitted: outbound.omitted,
    as_of: asOf,
  };
  const attempts: AskAttempt[] = [];
  const diagnostics = (extra: Partial<AskDiagnostics> = {}): AskDiagnostics => ({
    provider: null,
    model: null,
    destination: null,
    attempts,
    usage: { input_tokens: null, output_tokens: null },
    cost_usd: null,
    duration_ms: Math.round(now() - started),
    mode_used: retrieval.search.mode_used,
    passages_retrieved: retrieval.passages.length,
    passages_sent: outbound.passages.length,
    dropped_claims: 0,
    policy_problem: policy.problem,
    ...extra,
  });
  const unavailable = (reason: UnavailableReason): AskResult => ({
    output: {
      ...base,
      status: 'unavailable',
      answer: '',
      claims: [],
      citations: [],
      unsupported_claims: 0,
      removed_citations: 0,
      missing: null,
      unavailable_reason: reason,
      passages: passagesOut(retrieval.passages),
      next_step: NEXT_STEP[reason],
    },
    diagnostics: diagnostics(),
  });
  const notFound = (extra: { missing?: string | null; unsupported?: number; removed?: number } = {}): AskOutput => ({
    ...base,
    status: 'not_found',
    answer: '',
    claims: [],
    citations: [],
    unsupported_claims: extra.unsupported ?? 0,
    removed_citations: extra.removed ?? 0,
    missing: extra.missing ?? null,
    passages: passagesOut(retrieval.passages),
    next_step: NEXT_STEP.not_found,
  });

  if (policy.allow === 'none') return unavailable('disabled_for_brain');
  const providers = options.providers.filter((provider) => policy.allow === 'any' || provider.kind !== 'http');
  if (options.providers.length === 0) return unavailable('not_configured');
  if (providers.length === 0) return unavailable('disabled_for_brain');

  // pré-checagem sem modelo: nada para mandar, ou a melhor fusão fraca demais
  const top = retrieval.search.hits[0];
  const weak = retrieval.search.mode_used !== 'keyword' && top !== undefined && top.score < MIN_FUSION_SCORE;
  if (outbound.passages.length === 0 || weak) return { output: notFound(), diagnostics: diagnostics() };

  const limits = options.limits ?? {};
  const total = AbortSignal.timeout(limits.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const signal = combine([options.signal, total]);
  const cancelled = (): boolean => options.signal?.aborted === true;

  for (const provider of providers) {
    if (cancelled()) throw new AskCancelledError();
    if (total.aborted) break;
    let availability: Awaited<ReturnType<GenerationProvider['check']>>;
    try {
      availability = await provider.check();
    } catch (error) {
      availability = { ok: false, kind: 'unknown', reason: messageOf(error) };
    }
    if (!availability.ok) {
      attempts.push({
        provider: provider.id,
        kind: availability.kind ?? 'not_installed',
        message: availability.reason ?? 'indisponível',
      });
      continue;
    }
    let user = prompt.user;
    for (let attempt = 1; attempt <= 2; attempt++) {
      options.onProgress?.({ stage: 'generating', attempt });
      let streamed = '';
      let emitted = 0;
      const onClaim = options.onClaim;
      const byLabel = new Map(outbound.passages.map((item) => [item.label, item]));
      let result: Awaited<ReturnType<GenerationProvider['generate']>>;
      try {
        result = await provider.generate({
          system: prompt.system,
          user,
          schema: ANSWER_SCHEMA,
          maxOutputTokens: limits.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          timeoutMs: limits.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS,
          signal,
          ...(onClaim === undefined
            ? {}
            : {
                onText: (delta: string) => {
                  streamed += delta;
                  const done = completedClaims(streamed);
                  for (; emitted < done.length; emitted++) {
                    const check = validateAnswer({ status: 'answered', claims: [done[emitted]], missing: '' });
                    const claim = check.ok ? check.value.claims[0] : undefined;
                    if (claim === undefined) continue;
                    const verified = verifyClaim(claim, byLabel);
                    onClaim({
                      index: emitted,
                      text: verified.text,
                      supported: verified.supported,
                      labels: verified.labels,
                    });
                  }
                },
              }),
        });
      } catch (error) {
        if (cancelled()) throw new AskCancelledError();
        const kind: ProviderErrorKind =
          error instanceof ProviderError ? error.kind : total.aborted ? 'timeout' : 'unknown';
        attempts.push({
          provider: provider.id,
          kind,
          message: total.aborted && kind !== 'timeout' ? 'tempo total da pergunta esgotado' : messageOf(error),
        });
        break; // a próxima tentativa é no próximo provedor (as novas tentativas por erro transitório são do adaptador)
      }
      options.onProgress?.({ stage: 'verifying' });
      const validation = validateAnswer(result.object);
      if (!validation.ok) {
        attempts.push({ provider: provider.id, kind: 'invalid_output', message: validation.errors.join('; ') });
        if (attempt === 1) {
          user = `${prompt.user}\n\nSua resposta anterior não seguiu o formato pedido (${validation.errors.join('; ')}). Responda de novo, só com o JSON no formato pedido.`;
          continue;
        }
        break;
      }
      const raw = validation.value;
      const assembled = assembleAnswer(raw, outbound.passages);
      const diag = diagnostics({
        provider: provider.id,
        model: provider.model,
        destination: provider.destination,
        usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
        cost_usd: result.costUsd,
        dropped_claims: raw.droppedClaims,
      });
      const missing = raw.missing === '' ? null : raw.missing;
      if (assembled.status === 'not_found') {
        return {
          output: notFound({ missing, unsupported: assembled.unsupported, removed: assembled.removed }),
          diagnostics: diag,
        };
      }
      return {
        output: {
          ...base,
          status: assembled.status,
          answer: assembled.answer,
          claims: assembled.claims,
          citations: assembled.citations,
          unsupported_claims: assembled.unsupported,
          removed_citations: assembled.removed,
          missing,
          next_step: NEXT_STEP[assembled.status as 'answered' | 'low_confidence'],
        },
        diagnostics: diag,
      };
    }
  }
  if (cancelled()) throw new AskCancelledError();
  return unavailable('provider_failed');
}
