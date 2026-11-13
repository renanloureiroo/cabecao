// O que dá para dizer do provedor de respostas desta máquina SEM carregar o código dos provedores: o `llm.json`, o
// nome, o destino e o modelo de cada um. Usado pelo `status`, pelo `doctor` e pela CLI do `ask` e do `llm`.

import type { LlmConfig, ProviderEntry } from '@cabecao/core';
import { activeProviderIds, cacheDir, configDir, HTTP_PRESETS, LlmConfigError, readLlmConfig } from '@cabecao/core';
import { dirContext } from '../dirs.ts';
import type { CliIo } from '../types.ts';

export type LlmIo = Pick<CliIo, 'env' | 'platform' | 'homedir'>;

export const CLAUDE_CODE_LABEL = 'Claude Code';
export const CLAUDE_CODE_BINARY = 'claude';
/** O modelo mais barato que o Claude Code deixa escolher por apelido. */
export const CLAUDE_CODE_DEFAULT_MODEL = 'haiku';
export const CLAUDE_CODE_DESTINATION = 'Anthropic, pelo Claude Code instalado (com o login da sua conta)';

export interface LlmMachine {
  readonly configDir: string;
  readonly cacheDir: string;
  /** `null`: nada configurado (ou arquivo inválido: veja `problem`). */
  readonly config: LlmConfig | null;
  readonly problem: string | null;
}

export async function loadLlmMachine(io: LlmIo): Promise<LlmMachine> {
  const dirs = dirContext(io);
  const cfgDir = configDir(dirs);
  const cache = cacheDir(dirs);
  try {
    return { configDir: cfgDir, cacheDir: cache, config: await readLlmConfig(cfgDir), problem: null };
  } catch (error) {
    if (error instanceof LlmConfigError)
      return { configDir: cfgDir, cacheDir: cache, config: null, problem: error.message };
    throw error;
  }
}

/** Nome, destino e modelo de um provedor configurado, para o usuário (nunca para o agente). */
export function describeEntry(entry: ProviderEntry): {
  label: string;
  destination: string;
  model: string;
  leaves: boolean;
} {
  if (entry.kind === 'agent') {
    return {
      label: CLAUDE_CODE_LABEL,
      destination: CLAUDE_CODE_DESTINATION,
      model: entry.model ?? CLAUDE_CODE_DEFAULT_MODEL,
      leaves: true,
    };
  }
  const preset = HTTP_PRESETS[entry.preset];
  const base = entry.base_url ?? preset.baseUrl ?? '';
  const local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i.test(base);
  return {
    label: preset.label,
    destination: preset.id === 'compatible' ? `o serviço em ${base}` : preset.destination,
    model: entry.model,
    leaves: !local || /(?:-|:)cloud\b/i.test(entry.model),
  };
}

export interface LlmSummary {
  /** `none`: nunca configurado; `off`: desligado; `on`: ligado com provedor; `invalid`: `llm.json` com problema. */
  readonly state: 'none' | 'off' | 'on' | 'invalid';
  readonly provider: string | null;
  readonly label: string | null;
  readonly model: string | null;
  readonly destination: string | null;
  readonly leaves_machine: boolean | null;
  readonly problem: string | null;
}

/** Resumo para o `status` e o `doctor`. */
export async function llmSummary(io: LlmIo): Promise<LlmSummary> {
  const machine = await loadLlmMachine(io);
  const none = { provider: null, label: null, model: null, destination: null, leaves_machine: null, problem: null };
  if (machine.problem !== null) return { ...none, state: 'invalid', problem: machine.problem };
  const config = machine.config;
  if (config === null || Object.keys(config.providers).length === 0) return { ...none, state: 'none' };
  const id = activeProviderIds(config)[0] ?? config.roles.answer[0] ?? Object.keys(config.providers)[0];
  const entry = id === undefined ? undefined : config.providers[id];
  if (id === undefined || entry === undefined) return { ...none, state: 'none' };
  const d = describeEntry(entry);
  return {
    state: activeProviderIds(config).length > 0 ? 'on' : 'off',
    provider: id,
    label: d.label,
    model: d.model,
    destination: d.destination,
    leaves_machine: d.leaves,
    problem: null,
  };
}
