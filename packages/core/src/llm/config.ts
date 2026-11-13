// `<configDir>/llm.json`: os provedores de geração DESTA máquina (o que está instalado e logado muda de máquina para
// máquina). Fica fora do cérebro, não é versionado nem sincronizado, é gravado de forma atômica com permissão 0600 e
// NUNCA guarda a chave: só a referência de onde ela está (`env:NOME`, `keychain`, `file` ou `none`).
//
// Um provedor só é usado com `consented_at` preenchido (a confirmação do usuário no `cabecao llm on`) e com `enabled`
// verdadeiro; `cabecao llm off` desliga sem apagar nada.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '../util/atomic.ts';
import { isErrno } from '../util/errors.ts';
import { validateBaseUrl } from './http.ts';
import type { HttpPresetId } from './presets.ts';
import { HTTP_PRESETS, isHttpPresetId } from './presets.ts';

export const LLM_CONFIG_FILE = 'llm.json';
export const LLM_CONFIG_VERSION = 1;

/** Agentes instalados que podem gerar a resposta: só os que os termos permitem chamar de outro programa. */
export const AGENT_PROVIDER_IDS = ['claude-code'] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

/** Onde está a chave: variável de ambiente, chaveiro do sistema, arquivo protegido, ou nenhuma (servidor local). */
export type KeyRef = `env:${string}` | 'keychain' | 'file' | 'none';

export interface HttpProviderEntry {
  readonly kind: 'http';
  readonly preset: HttpPresetId;
  readonly base_url?: string;
  readonly model: string;
  readonly key: KeyRef;
  readonly consented_at: string | null;
  /** Assinatura da confirmação (HMAC com o segredo local da máquina): sem ela válida, o provedor não está ativado. */
  readonly consent?: string;
  /** Gemini: o usuário declarou que a chave é de um projeto com faturamento (camada paga). */
  readonly paid_tier?: boolean;
}

export interface AgentProviderEntry {
  readonly kind: 'agent';
  readonly agent: AgentProviderId;
  /** `null`: o mais barato que o agente deixa escolher. */
  readonly model: string | null;
  /**
   * O caminho REAL do executável, resolvido na ativação (`llm on`) e coberto pela confirmação assinada: o `ask` usa
   * este, nunca o primeiro `claude` do PATH de quem chama.
   */
  readonly binary?: string;
  readonly consented_at: string | null;
  readonly consent?: string;
}

export type ProviderEntry = HttpProviderEntry | AgentProviderEntry;

export interface LlmLimits {
  /** Orçamento de contexto por pergunta, em tokens (de 500 a 8000). */
  readonly context_tokens: number;
  readonly max_output_tokens: number;
  /** Tempo limite de cada chamada ao provedor. */
  readonly timeout_ms: number;
  /** Teto de perguntas que chegam ao provedor por hora, somando CLI e servidores MCP desta máquina. */
  readonly max_calls_per_hour: number;
  /** Teto de perguntas que chegam ao provedor por sessão do servidor MCP (um cliente de IA aberto). */
  readonly max_calls_per_session: number;
}

export interface LlmConfig {
  readonly version: number;
  readonly enabled: boolean;
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  /** Papéis: `answer` é a ordem de recuo do `ask`. */
  readonly roles: { readonly answer: readonly string[] };
  readonly limits: LlmLimits;
}

export const DEFAULT_LLM_LIMITS: LlmLimits = {
  context_tokens: 3000,
  max_output_tokens: 2048,
  timeout_ms: 60_000,
  max_calls_per_hour: 30,
  max_calls_per_session: 20,
};

export function emptyLlmConfig(): LlmConfig {
  return {
    version: LLM_CONFIG_VERSION,
    enabled: false,
    providers: {},
    roles: { answer: [] },
    limits: DEFAULT_LLM_LIMITS,
  };
}

/** O `llm.json` existe mas não dá para usar. O `ask` trata como "nenhum provedor"; status e doctor mostram o motivo. */
export class LlmConfigError extends Error {
  readonly code = 'ELLM_CONFIG';
  readonly path: string;
  constructor(path: string, problem: string, cause?: unknown) {
    super(
      `configuração de respostas inválida em ${path}: ${problem}. Rode "cabecao llm on" para refazer, ou apague o arquivo.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'LlmConfigError';
    this.path = path;
  }
}

/** Nome de provedor: minúsculas, dígitos, `-` e `_`. */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function llmConfigPath(dir: string): string {
  return join(dir, LLM_CONFIG_FILE);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isKeyRef(value: unknown): value is KeyRef {
  if (value === 'keychain' || value === 'file' || value === 'none') return true;
  return typeof value === 'string' && value.startsWith('env:') && ENV_NAME_RE.test(value.slice(4));
}

const isTimestamp = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));

function readEntry(id: string, value: unknown, problems: string[]): ProviderEntry | null {
  if (!PROVIDER_ID_RE.test(id)) {
    problems.push(`nome de provedor inválido: ${JSON.stringify(id)}`);
    return null;
  }
  if (!isRecord(value)) {
    problems.push(`o provedor "${id}" deveria ser um objeto`);
    return null;
  }
  if (!isTimestamp(value.consented_at ?? null)) problems.push(`"${id}.consented_at" deveria ser uma data ou null`);
  const consented = (value.consented_at ?? null) as string | null;
  const consent = typeof value.consent === 'string' && /^[0-9a-f]{64}$/.test(value.consent) ? value.consent : undefined;
  if (value.kind === 'agent') {
    if (!(AGENT_PROVIDER_IDS as readonly string[]).includes(String(value.agent))) {
      problems.push(`"${id}.agent" deveria ser um de ${AGENT_PROVIDER_IDS.join(', ')}`);
      return null;
    }
    const model = value.model ?? null;
    if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
      problems.push(`"${id}.model" deveria ser texto ou null`);
      return null;
    }
    const binary = value.binary;
    if (binary !== undefined && (typeof binary !== 'string' || !isAbsolute(binary) || /[\0\n]/.test(binary))) {
      problems.push(`"${id}.binary" deveria ser o caminho absoluto do executável`);
      return null;
    }
    return {
      kind: 'agent',
      agent: value.agent as AgentProviderId,
      model: model as string | null,
      ...(binary === undefined ? {} : { binary: binary as string }),
      consented_at: consented,
      ...(consent === undefined ? {} : { consent }),
    };
  }
  if (value.kind === 'http') {
    if (typeof value.preset !== 'string' || !isHttpPresetId(value.preset)) {
      problems.push(`"${id}.preset" desconhecido: ${JSON.stringify(value.preset)}`);
      return null;
    }
    if (typeof value.model !== 'string' || value.model.trim() === '') {
      problems.push(`"${id}.model" deveria ser o nome do modelo`);
      return null;
    }
    if (!isKeyRef(value.key)) {
      problems.push(`"${id}.key" deveria ser "env:NOME", "keychain", "file" ou "none" (a chave em si nunca fica aqui)`);
      return null;
    }
    if (value.base_url !== undefined && typeof value.base_url !== 'string') {
      problems.push(`"${id}.base_url" deveria ser texto`);
      return null;
    }
    // o endereço é conferido em TODA leitura (não só no "llm on") e só vale nos presets que o admitem
    if (typeof value.base_url === 'string') {
      if (!BASE_URL_PRESETS.has(value.preset)) {
        problems.push(`"${id}.base_url" não vale para o preset ${value.preset}: o endereço dele é fixo`);
        return null;
      }
      try {
        validateBaseUrl(value.base_url);
      } catch (error) {
        problems.push(`"${id}.base_url" recusado: ${(error as Error).message}`);
        return null;
      }
    } else if (value.preset === 'compatible') {
      problems.push(`"${id}.base_url" é obrigatório no preset compatible`);
      return null;
    }
    return {
      kind: 'http',
      preset: value.preset,
      ...(typeof value.base_url === 'string' ? { base_url: value.base_url } : {}),
      model: value.model,
      key: value.key,
      consented_at: consented,
      ...(consent === undefined ? {} : { consent }),
      ...(typeof value.paid_tier === 'boolean' ? { paid_tier: value.paid_tier } : {}),
    };
  }
  problems.push(`"${id}.kind" deveria ser "http" ou "agent"`);
  return null;
}

function positive(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function validateLlmConfig(path: string, value: unknown): LlmConfig {
  if (!isRecord(value)) throw new LlmConfigError(path, 'o conteúdo deveria ser um objeto JSON');
  const problems: string[] = [];
  if (value.version !== LLM_CONFIG_VERSION) problems.push(`"version" deveria ser ${LLM_CONFIG_VERSION}`);
  const providers: Record<string, ProviderEntry> = {};
  if (value.providers !== undefined && !isRecord(value.providers)) problems.push('"providers" deveria ser um objeto');
  for (const [id, entry] of Object.entries(isRecord(value.providers) ? value.providers : {})) {
    const read = readEntry(id, entry, problems);
    if (read !== null) providers[id] = read;
  }
  const roles = isRecord(value.roles) ? value.roles : {};
  const answer = Array.isArray(roles.answer) ? roles.answer.filter((id): id is string => typeof id === 'string') : [];
  for (const id of answer)
    if (providers[id] === undefined) problems.push(`"roles.answer" cita "${id}", que não existe`);
  const limits = isRecord(value.limits) ? value.limits : {};
  if (problems.length > 0) throw new LlmConfigError(path, problems.join('; '));
  return {
    version: LLM_CONFIG_VERSION,
    enabled: value.enabled === true,
    providers,
    roles: { answer: [...new Set(answer)] },
    limits: {
      context_tokens: positive(limits.context_tokens, DEFAULT_LLM_LIMITS.context_tokens, 500, 8000),
      max_output_tokens: positive(limits.max_output_tokens, DEFAULT_LLM_LIMITS.max_output_tokens, 256, 16_000),
      timeout_ms: positive(limits.timeout_ms, DEFAULT_LLM_LIMITS.timeout_ms, 5_000, 600_000),
      max_calls_per_hour: positive(limits.max_calls_per_hour, DEFAULT_LLM_LIMITS.max_calls_per_hour, 1, 10_000),
      max_calls_per_session: positive(
        limits.max_calls_per_session,
        DEFAULT_LLM_LIMITS.max_calls_per_session,
        1,
        10_000,
      ),
    },
  };
}

/** Lê o `llm.json`. Sem arquivo: `null` (nada configurado). Corrompido: `LlmConfigError`. */
export async function readLlmConfig(dir: string): Promise<LlmConfig | null> {
  const path = llmConfigPath(dir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw new LlmConfigError(path, error instanceof Error ? error.message : String(error), error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new LlmConfigError(path, 'o conteúdo não é JSON válido', error);
  }
  return validateLlmConfig(path, value);
}

/** Grava o `llm.json` (atômico, 0600). */
export async function writeLlmConfig(dir: string, config: LlmConfig): Promise<void> {
  const path = llmConfigPath(dir);
  const valid = validateLlmConfig(path, config);
  await writeFileAtomic(path, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  // um arquivo que já existia mantém o modo antigo na escrita atômica: força 0600 (no Windows o chmod só mexe no
  // bit de escrita, e a proteção é a da pasta do perfil)
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
}

/** Presets em que o usuário escolhe o endereço. Nos outros, o endereço é o do provedor e não se troca. */
export const BASE_URL_PRESETS: ReadonlySet<string> = new Set(['compatible', 'ollama', 'lmstudio']);

/** Arquivo do segredo local que assina as confirmações (`llm on`), na mesma pasta do `llm.json`, permissão 0600. */
export const CONSENT_KEY_FILE = 'llm-consent.key';

/** Para onde o provedor manda: o endereço configurado, senão o do preset, senão o agente. */
export function entryDestination(entry: ProviderEntry): string {
  if (entry.kind === 'agent') return `agent:${entry.agent}`;
  return (entry.base_url ?? HTTP_PRESETS[entry.preset].baseUrl ?? '').replace(/\/+$/, '');
}

/**
 * O que a confirmação cobre: o nome, o tipo, o destino, o modelo e de onde vem a chave. Mudar qualquer um (por
 * exemplo, apontar o endereço para outro servidor) invalida a confirmação.
 */
function consentPayload(id: string, entry: ProviderEntry): string {
  return JSON.stringify([
    'cabecao-llm-consent-v1',
    id,
    entry.kind,
    entry.kind === 'agent' ? entry.agent : entry.preset,
    entryDestination(entry),
    entry.model,
    entry.kind === 'agent' ? null : entry.key,
    entry.consented_at,
    entry.kind === 'agent' ? (entry.binary ?? null) : null,
  ]);
}

export function signConsent(secret: Buffer, id: string, entry: ProviderEntry): string {
  return createHmac('sha256', secret).update(consentPayload(id, entry)).digest('hex');
}

export function consentValid(secret: Buffer | null, id: string, entry: ProviderEntry): boolean {
  if (secret === null || entry.consented_at === null || entry.consent === undefined) return false;
  const expected = Buffer.from(signConsent(secret, id, entry), 'hex');
  const given = Buffer.from(entry.consent, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Lê o segredo local (32 bytes). `create`: cria se não houver (só o `llm on`, com o usuário no terminal). */
export async function readConsentSecret(dir: string, create = false): Promise<Buffer | null> {
  const path = join(dir, CONSENT_KEY_FILE);
  try {
    const hex = (await readFile(path, 'utf8')).trim();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch (error) {
    if (!isErrno(error, 'ENOENT') || !create) return null;
  }
  const secret = randomBytes(32);
  await writeFileAtomic(path, `${secret.toString('hex')}\n`, { mode: 0o600, ifUnchangedSince: null });
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
  return secret;
}

/**
 * Os provedores que o `ask` pode usar agora, na ordem: ligado, no papel `answer`, com consentimento e com a
 * assinatura da confirmação válida (um `llm.json` escrito à mão, ou trazido de outra máquina, não ativa nada).
 */
export function activeProviderIds(config: LlmConfig | null, secret: Buffer | null): string[] {
  if (config === null || !config.enabled) return [];
  return config.roles.answer.filter((id) => {
    const entry = config.providers[id];
    return entry !== undefined && consentValid(secret, id, entry);
  });
}
