// Ativar ou trocar o provedor de respostas, e apagar uma chave, é ação de um HUMANO no terminal (decisão 38): um agente
// não ativa, não troca e não lê a chave, nem por tool MCP nem pela CLI.
//
// A regra: precisa haver terminal interativo (entrada e saída de erro ligadas a um TTY: `ctx.prompt` só existe assim)
// e o processo não pode estar rodando dentro de um agente conhecido. A lista de variáveis é defesa extra, não a regra
// principal; quando o PR `feat/cli-modo-agente` (a CLI trata quem chama como agente por padrão) entrar na `main`, esta
// função deve passar a usar a decisão dele, num lugar só.
import { CliError } from '../errors.ts';
import type { CliIo } from '../types.ts';

/** Variáveis que os agentes de terminal definem nos comandos que rodam (Claude Code, Codex, Gemini CLI). */
export const AGENT_ENV_MARKERS = [
  'CLAUDECODE',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'GEMINI_CLI',
] as const;

export function agentMarker(env: CliIo['env']): string | null {
  for (const name of AGENT_ENV_MARKERS) {
    const value = env[name];
    if (value !== undefined && value !== '' && value !== '0') return name;
  }
  return null;
}

export type HumanIo = Pick<CliIo, 'env'> & { prompt: NonNullable<CliIo['prompt']> };

/** Lança se não houver um humano no terminal. `action` começa a frase: "Ativar um provedor de respostas". */
export function requireHuman(io: Pick<CliIo, 'env' | 'prompt'>, action: string): HumanIo {
  const marker = agentMarker(io.env);
  if (marker !== null) {
    throw new CliError(
      `${action} é com você, no seu terminal: este comando está rodando dentro de um agente (${marker})`,
      {
        code: 'EHUMAN_REQUIRED',
        hint: 'Abra um terminal seu e rode o mesmo comando lá. Um agente não ativa, não troca nem lê a chave do provedor de respostas.',
      },
    );
  }
  if (io.prompt === undefined) {
    throw new CliError(`${action} precisa de você no terminal: não há um terminal interativo para confirmar`, {
      code: 'EHUMAN_REQUIRED',
      hint: 'Rode o comando num terminal (não num script nem por um agente): ele mostra o que passa a sair da máquina e pede a sua confirmação.',
    });
  }
  return { env: io.env, prompt: io.prompt };
}
