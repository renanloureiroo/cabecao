// Achar o agente que vai rodar: o pedido, o configurado na máquina ou o primeiro instalado, sempre dentro da lista de
// agentes que o Cabeção pode chamar (`policy.ts`) e com a credencial que os termos permitem. Não executa nada: só
// procura o executável no `PATH` e lê o ambiente.
import { readMachine } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { findExecutable } from '../install-client/files.ts';
import type { CliIo, Env } from '../types.ts';
import type { CallableAgent } from './policy.ts';
import { CALLABLE_AGENT_IDS, CALLABLE_AGENTS, isCallableAgentId, NOT_CALLABLE_AGENTS } from './policy.ts';

export interface ChosenAgent {
  readonly agent: CallableAgent;
  /** Caminho do executável, ou `null` se não foi achado (só quando `allowMissing`). */
  readonly path: string | null;
  /** Variáveis da credencial permitida (vazio quando o agente usa o próprio login), ou `null` se falta. */
  readonly credentials: Readonly<Record<string, string>> | null;
  readonly source: 'flag' | 'config' | 'auto';
}

export const SOURCE_TEXT: Readonly<Record<ChosenAgent['source'], string>> = {
  flag: 'escolhido com --agent',
  config: 'configurado em "agent" no config.json da máquina',
  auto: `o primeiro disponível na ordem ${CALLABLE_AGENT_IDS.join(', ')}`,
};

/** O executável do agente no `PATH`. No Windows, um `.cmd`/`.bat` é recusado: só rodaria por shell. */
export async function locateAgent(
  io: Pick<CliIo, 'env' | 'platform'>,
  agent: Pick<CallableAgent, 'binary' | 'label'>,
): Promise<string | null> {
  const found = await findExecutable(agent.binary, io);
  if (found === undefined) return null;
  if (io.platform === 'win32' && /\.(?:cmd|bat)$/i.test(found)) {
    throw new CliError(`${found} é um script .cmd: o Cabeção não roda o agente por shell`, {
      code: 'EAGENT_SHELL',
      hint: `Instale a versão nativa (.exe) do ${agent.label}.`,
    });
  }
  return found;
}

function notCallable(name: string): CliError {
  return new CliError(`o Cabeção não chama o agente "${name}" sozinho: ${NOT_CALLABLE_AGENTS[name] ?? ''}`, {
    code: 'EAGENT_UNSUPPORTED',
    hint: `Agentes que o Cabeção pode chamar: ${CALLABLE_AGENT_IDS.join(', ')}.`,
  });
}

/**
 * O agente: o de `requested` (`--agent`); senão o `"agent"` do config.json da máquina; senão o primeiro instalado e
 * com credencial, na ordem de `CALLABLE_AGENT_IDS`. Com `allowMissing` (simulação), aceita o pedido mesmo sem o
 * executável ou a credencial.
 */
export async function chooseAgent(
  io: Pick<CliIo, 'env' | 'platform' | 'homedir'>,
  requested: string | undefined,
  allowMissing: boolean,
): Promise<ChosenAgent> {
  const named = async (name: string, source: 'flag' | 'config'): Promise<ChosenAgent> => {
    if (!isCallableAgentId(name)) {
      if (name in NOT_CALLABLE_AGENTS) throw notCallable(name);
      const message = `agente desconhecido: ${name}. Os agentes que o Cabeção pode chamar são: ${CALLABLE_AGENT_IDS.join(', ')}`;
      if (source === 'flag') throw new UsageError(message);
      throw new CliError(`${message} (veio de "agent" na configuração da máquina)`, { code: 'EAGENT_UNKNOWN' });
    }
    const agent = CALLABLE_AGENTS[name];
    const path = await locateAgent(io, agent);
    const credentials = agent.credentials(io.env);
    if (!allowMissing && path === null) {
      throw new CliError(`o ${agent.label} (comando "${agent.binary}") não está instalado nesta máquina`, {
        code: 'EAGENT_MISSING',
        hint: `Instale e faça login no ${agent.label}, ou escolha outro com --agent (${CALLABLE_AGENT_IDS.join(', ')}).`,
      });
    }
    if (!allowMissing && credentials === null) {
      throw new CliError(agent.missingCredentials, { code: 'EAGENT_CREDENTIALS' });
    }
    return { agent, path, credentials, source };
  };
  if (requested !== undefined) return named(requested, 'flag');
  const configured = (await readMachine(io))?.agent;
  if (configured !== undefined) return named(configured, 'config');
  for (const id of CALLABLE_AGENT_IDS) {
    const agent = CALLABLE_AGENTS[id];
    const path = await locateAgent(io, agent);
    const credentials = agent.credentials(io.env);
    if (path !== null && credentials !== null) return { agent, path, credentials, source: 'auto' };
  }
  throw new CliError('nenhum agente que o Cabeção pode chamar está disponível nesta máquina', {
    code: 'EAGENT_MISSING',
    hint: 'Instale e faça login no Claude Code (claude), ou instale o Codex (codex) e defina CODEX_API_KEY ou OPENAI_API_KEY.',
  });
}

/** Variáveis que todo agente recebe: sistema, pastas, rede (proxy e certificados). Segredos, só os do login. */
const BASE_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

export function pickEnv(env: Env, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/** Ambiente mínimo do agente: o de base, o do login dele, a credencial permitida e o que o chamador acrescenta. */
export function agentEnv(
  env: Env,
  agent: Pick<CallableAgent, 'loginEnv'>,
  credentials: Readonly<Record<string, string>> | null,
  extra: Readonly<Record<string, string>> = {},
): Env {
  return { ...pickEnv(env, [...BASE_ENV, ...agent.loginEnv]), ...(credentials ?? {}), ...extra };
}
