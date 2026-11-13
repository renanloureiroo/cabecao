// `<configDir>/llm.json`: os provedores de geração DESTA máquina (o que está instalado e logado muda de máquina para
// máquina). Fica fora do cérebro, não é versionado nem sincronizado, é gravado de forma atômica com permissão 0600 e
// NUNCA guarda a chave: só a referência de onde ela está (`env:NOME`, `keychain`, `file` ou `none`).
//
// Um provedor só é usado com `consented_at` preenchido (a confirmação do usuário no `cabecao llm on`) e com `enabled`
// verdadeiro; `cabecao llm off` desliga sem apagar nada.
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomic.ts';
import { isErrno } from '../util/errors.ts';
import type { HttpPresetId } from './presets.ts';
import { isHttpPresetId } from './presets.ts';

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
  /** Gemini: o usuário declarou que a chave é de um projeto com faturamento (camada paga). */
  readonly paid_tier?: boolean;
}

export interface AgentProviderEntry {
  readonly kind: 'agent';
  readonly agent: AgentProviderId;
  /** `null`: o mais barato que o agente deixa escolher. */
  readonly model: string | null;
  readonly consented_at: string | null;
}

export type ProviderEntry = HttpProviderEntry | AgentProviderEntry;

export interface LlmLimits {
  /** Orçamento de contexto por pergunta, em tokens (de 500 a 8000). */
  readonly context_tokens: number;
  readonly max_output_tokens: number;
  /** Tempo limite de cada chamada ao provedor. */
  readonly timeout_ms: number;
}

export interface LlmConfig {
  readonly version: number;
  readonly enabled: boolean;
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  /** Papéis: `answer` é a ordem de recuo do `ask`. */
  readonly roles: { readonly answer: readonly string[] };
  readonly limits: LlmLimits;
}

export const DEFAULT_LLM_LIMITS: LlmLimits = { context_tokens: 3000, max_output_tokens: 2048, timeout_ms: 60_000 };

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
    return {
      kind: 'agent',
      agent: value.agent as AgentProviderId,
      model: model as string | null,
      consented_at: consented,
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
    return {
      kind: 'http',
      preset: value.preset,
      ...(typeof value.base_url === 'string' ? { base_url: value.base_url } : {}),
      model: value.model,
      key: value.key,
      consented_at: consented,
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

/** Os provedores que o `ask` pode usar agora, na ordem: ligado, no papel `answer` e com consentimento. */
export function activeProviderIds(config: LlmConfig | null): string[] {
  if (config === null || !config.enabled) return [];
  return config.roles.answer.filter((id) => (config.providers[id]?.consented_at ?? null) !== null);
}
