// O que dá para dizer do provedor de respostas desta máquina SEM carregar o código dos provedores: o `llm.json`, o
// nome, o destino e o modelo de cada um. Usado pelo `status`, pelo `doctor` e pela CLI do `ask` e do `llm`.
//
// ONDE fica a configuração (revisão adversária, A2): o `llm.json`, o segredo que assina as confirmações, o contador do
// teto de gasto e as chaves guardadas em arquivo ficam na pasta de configuração padrão do usuário, calculada a partir
// da pasta do usuário do SISTEMA (`os.userInfo()`, que não lê `HOME`). Um agente controla o ambiente dos comandos que
// roda; se ele desviar a pasta por variável de ambiente (`CABECAO_CONFIG_DIR`, `XDG_CONFIG_HOME`, `APPDATA`, `HOME`),
// a configuração desviada NÃO vale para ele: as respostas ficam indisponíveis e nada é lido (nem a desviada, nem a
// padrão). Só você, no terminal, usa uma pasta desviada (é assim que se testa a CLI instalada sem tocar na sua
// configuração). Os testes da CLI como biblioteca passam `llmConfigDir` no `CliIo`, o que o programa instalado não
// aceita.
import { userInfo } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import type { LlmConfig, ProviderEntry } from '@cabecao/core';
import {
  activeProviderIds,
  configDir,
  consentValid,
  HTTP_PRESETS,
  LlmConfigError,
  readConsentSecret,
  readLlmConfig,
} from '@cabecao/core';
import { dirContext } from '../dirs.ts';
import type { CliIo } from '../types.ts';

export type LlmIo = Pick<CliIo, 'env' | 'platform' | 'homedir' | 'llmConfigDir' | 'credentialRunner'> & {
  /** Quem roda (o roteador resolve; sem isso, como no servidor MCP, é um agente). */
  readonly actor?: { readonly actor: 'human' | 'agent' };
};

export const CLAUDE_CODE_LABEL = 'Claude Code';
export const CLAUDE_CODE_BINARY = 'claude';
/** O modelo mais barato que o Claude Code deixa escolher por apelido. */
export const CLAUDE_CODE_DEFAULT_MODEL = 'haiku';
export const CLAUDE_CODE_DESTINATION = 'Anthropic, pelo Claude Code instalado (com o login da sua conta)';

export interface LlmMachine {
  /** Pasta do `llm.json` (a padrão do usuário; veja o topo do arquivo). `null` se não deu para descobrir. */
  readonly configDir: string;
  /**
   * Pasta do `ask.log`: a mesma do `llm.json` (não a de cache, que segue o ambiente de quem roda; revisão adversária,
   * 2ª rodada, G). Vazia quando não há pasta confiável: nada é registrado.
   */
  readonly cacheDir: string;
  /** `null`: nada configurado (ou arquivo inválido: veja `problem`). */
  readonly config: LlmConfig | null;
  readonly problem: string | null;
  /** Segredo local que assina as confirmações (`null`: nenhuma confirmação foi feita nesta máquina). */
  readonly secret: Buffer | null;
}

/** A pasta de configuração padrão, a partir da pasta do usuário do SISTEMA (sem variável de ambiente). */
function systemConfigDir(platform: NodeJS.Platform): string | null {
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    return null;
  }
  if (home === '') return null;
  return platform === 'win32'
    ? win32.join(home, 'AppData', 'Roaming', 'cabecao')
    : posix.join(home, '.config', 'cabecao');
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => (platform === 'win32' ? win32.resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

export type TrustedDir = { readonly dir: string } | { readonly dir: null; readonly problem: string };

export const REDIRECTED_FOR_AGENT =
  'a pasta de configuração foi desviada por variável de ambiente; para um agente, as respostas só valem com a configuração padrão do usuário';

/**
 * A pasta do `llm.json` em que dá para confiar (veja o topo do arquivo): a padrão do usuário do sistema; uma desviada
 * pelo ambiente só para você, no terminal. Para um agente com a pasta desviada, nenhuma: nada é lido.
 */
export function trustedConfigDir(io: LlmIo): TrustedDir {
  if (io.llmConfigDir !== undefined) return { dir: io.llmConfigDir };
  const system = systemConfigDir(io.platform);
  let fromEnv: string | null;
  try {
    fromEnv = configDir(dirContext(io));
  } catch {
    fromEnv = null;
  }
  if (system !== null && (fromEnv === null || samePath(system, fromEnv, io.platform))) return { dir: system };
  if (io.actor?.actor === 'human' && fromEnv !== null) return { dir: fromEnv };
  if (system === null && fromEnv === null) {
    return { dir: null, problem: 'não consegui descobrir a pasta do usuário, onde fica a configuração das respostas' };
  }
  return { dir: null, problem: REDIRECTED_FOR_AGENT };
}

export async function loadLlmMachine(io: LlmIo): Promise<LlmMachine> {
  const trusted = trustedConfigDir(io);
  if (trusted.dir === null) {
    return { configDir: '', cacheDir: '', config: null, problem: trusted.problem, secret: null };
  }
  const dir = trusted.dir;
  const cache = dir;
  const secret = await readConsentSecret(dir);
  try {
    return { configDir: dir, cacheDir: cache, config: await readLlmConfig(dir), problem: null, secret };
  } catch (error) {
    if (error instanceof LlmConfigError) {
      return { configDir: dir, cacheDir: cache, config: null, problem: error.message, secret };
    }
    throw error;
  }
}

/** A confirmação deste provedor confere com a assinatura local. */
export function confirmed(machine: LlmMachine, id: string, entry: ProviderEntry): boolean {
  return consentValid(machine.secret, id, entry);
}

/** Nome, destino REAL (o endereço configurado, quando há) e modelo de um provedor, para o usuário (nunca o agente). */
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
  const local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(base);
  const destination =
    entry.base_url === undefined
      ? preset.destination
      : local
        ? `${preset.id === 'compatible' ? 'o serviço' : preset.label} nesta máquina (${base})`
        : `${preset.id === 'compatible' ? 'o serviço' : preset.label} em ${base}`;
  return {
    label: preset.label,
    destination,
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
  const active = activeProviderIds(config, machine.secret);
  const id = active[0] ?? config.roles.answer[0] ?? Object.keys(config.providers)[0];
  const entry = id === undefined ? undefined : config.providers[id];
  if (id === undefined || entry === undefined) return { ...none, state: 'none' };
  const d = describeEntry(entry);
  return {
    state: active.length > 0 ? 'on' : 'off',
    provider: id,
    label: d.label,
    model: d.model,
    destination: d.destination,
    leaves_machine: d.leaves,
    problem: null,
  };
}

/** O que um AGENTE pode saber das respostas: só se estão ligadas (nada de provedor, modelo ou destino). */
export function agentSummary(summary: LlmSummary): { readonly state: 'on' | 'off' } {
  return { state: summary.state === 'on' ? 'on' : 'off' };
}
