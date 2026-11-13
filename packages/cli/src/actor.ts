// Quem está rodando a CLI: o usuário (humano) ou um agente. É o ÚNICO lugar em que isso se decide; todos os comandos
// que abrem o cérebro usam o resultado (`brain.ts`), e o roteador recusa os comandos só do humano para um agente.
//
// A regra (decisão do dono; doc "Quem é humano e quem é agente na CLI"):
//
//   HUMANO só quando o processo tem um TERMINAL CONTROLADOR de verdade (no POSIX, consegue abrir `/dev/tty`; no
//   Windows, o console `CONIN$`/`CONOUT$`) E não há nenhum sinal de ambiente de agente nem `CI`. O stdin e o stdout
//   podem estar redirecionados (`cabecao search x | less`, `cat nota.md | cabecao remember`): o que conta é o terminal
//   que controla o processo. AGENTE em qualquer outro caso.
//
// Nada ELEVA para humano: nenhuma opção, variável de ambiente ou arquivo de configuração. `--as <cliente>` só NOMEIA o
// agente para a proveniência (`origin: agent:<cliente>`, rodapé `Cabecao-Client`) e, se vier, força o modo agente; um
// humano no terminal pode usá-la para testar como um agente veria. Errar para o lado "agente" é o seguro.
//
// Este módulo é avaliado pelo roteador em todo comando: não importe nada do núcleo aqui.
import type { Env } from './types.ts';

/** Um sinal de ambiente que um agente de terminal deixa nos processos que dispara. */
export interface AgentSignal {
  /** A variável. Vale quando existe e não está vazia. */
  readonly variable: string;
  /** Nome do cliente para a proveniência; `null`: tirado do valor da variável. */
  readonly client: string | null;
  /** De onde vem a informação: medido aqui, lido no código do agente, ou documentação/convenção (não conferido). */
  readonly source: string;
}

/**
 * Sinais conhecidos, em ordem de precedência para o nome do cliente. A lista só ACRESCENTA casos de agente: um sinal
 * que falta faz o processo depender do terminal controlador, nunca vira humano por si.
 */
export const AGENT_SIGNALS: readonly AgentSignal[] = [
  {
    variable: 'CLAUDECODE',
    client: 'claude-code',
    source: 'medido: o Bash do Claude Code define CLAUDECODE=1 (e roda sem terminal controlador)',
  },
  {
    variable: 'CLAUDE_CODE_ENTRYPOINT',
    client: 'claude-code',
    source: 'medido: definido pelo Claude Code nos processos que dispara',
  },
  {
    variable: 'CODEX_SANDBOX',
    client: 'codex',
    source: 'código do Codex CLI 0.159.3: define CODEX_SANDBOX (seatbelt no macOS) nos comandos em sandbox',
  },
  {
    variable: 'CODEX_SANDBOX_NETWORK_DISABLED',
    client: 'codex',
    source: 'código do Codex CLI 0.159.3: definido nos comandos com a rede bloqueada',
  },
  {
    variable: 'CODEX_THREAD_ID',
    client: 'codex',
    source: 'código do Codex CLI 0.159.3: o id da conversa vai para o ambiente dos comandos (que rodam num PTY)',
  },
  { variable: 'CODEX_CI', client: 'codex', source: 'código do Codex CLI 0.159.3' },
  {
    variable: 'GEMINI_CLI',
    client: 'gemini-cli',
    source: 'código do Gemini CLI 0.66.0: GEMINI_CLI=1 no ambiente da tool de shell (que roda num PTY)',
  },
  {
    variable: 'CURSOR_AGENT',
    client: 'cursor',
    source: 'código do cursor-agent 2026.01.23: CURSOR_AGENT=1 nos comandos do agente (que rodam num PTY)',
  },
  {
    variable: 'OPENCODE',
    client: 'opencode',
    source: 'suposição: o OpenCode define OPENCODE=1 nos comandos que roda (não instalado aqui; não conferido)',
  },
  {
    variable: 'AI_AGENT',
    client: null,
    source:
      'medido: o Claude Code define AI_AGENT=claude-code_<versão>_agent; é uma convenção entre ferramentas (o nome do agente vem do valor)',
  },
];

/** Nome do cliente quando nenhum sinal nomeia o agente. */
export const FALLBACK_AGENT_CLIENT = 'cli-agent';

/** Nome da CLI quando quem roda é o usuário (`Cabecao-Client: cli`, `origin: human`). */
export const HUMAN_CLIENT = 'cli';

/** Nomes que o núcleo trata de forma especial (o usuário, edições de fora) e que um agente nunca assume. */
const RESERVED = new Set(['cli', 'manual', 'human', 'user', 'humano', 'usuario']);
const CLIENT_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** Nomes conhecidos para a forma curta usada nos commits (os mesmos do servidor MCP). */
const KNOWN: readonly (readonly [RegExp, string])[] = [
  [/^claude[-_ ]?code\b/, 'claude-code'],
  [/^claude[-_ ]?(?:ai|desktop)\b/, 'claude-desktop'],
  [/codex/, 'codex'],
  [/cursor/, 'cursor'],
  [/^(?:visual[-_ ]?studio[-_ ]?code|vs[-_ ]?code)\b/, 'vscode'],
  [/^gemini/, 'gemini-cli'],
  [/^antigravity\b/, 'antigravity'],
  [/windsurf/, 'windsurf'],
  [/^zed\b/, 'zed'],
  [/^goose\b/, 'goose'],
  [/^opencode\b/, 'opencode'],
  [/^continue\b/, 'continue'],
  [/^cline\b/, 'cline'],
];

/**
 * Saneia um nome de agente como o servidor MCP faz com o `clientInfo`: nomes conhecidos viram a forma curta; o resto
 * fica em minúsculas, com o que não é letra, dígito, `.`, `_` ou `-` trocado por `-`, até 64 caracteres. Nome vazio
 * ou reservado (`cli`, `manual`, `human`...) vira `cli-agent`: nunca dá para se passar pelo usuário.
 */
export function sanitizeAgentName(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_AGENT_CLIENT;
  const lower = raw.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
  for (const [pattern, name] of KNOWN) if (pattern.test(lower)) return name;
  const cleaned = lower
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[.-]+$/, '');
  if (cleaned === '' || RESERVED.has(cleaned) || !CLIENT_RE.test(cleaned)) return FALLBACK_AGENT_CLIENT;
  return cleaned;
}

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

/** `CI` ligado: qualquer valor que não seja vazio, `0` ou `false`. */
export function ciEnabled(env: Env): boolean {
  const value = env.CI;
  return present(value) && !['0', 'false', 'no'].includes(value.trim().toLowerCase());
}

/** Os sinais de agente presentes no ambiente, na ordem de `AGENT_SIGNALS`. */
export function agentSignals(env: Env): AgentSignal[] {
  return AGENT_SIGNALS.filter((signal) => present(env[signal.variable]));
}

export type ActorReason = 'terminal' | 'as' | 'env' | 'ci' | 'no-terminal' | 'server';

export interface ResolvedActor {
  readonly actor: 'human' | 'agent';
  /** Nome do cliente para `openBrain` (`cli` para o usuário). */
  readonly client: string;
  readonly reason: ActorReason;
  /** As variáveis de agente achadas (vazio quando não há). */
  readonly signals: readonly string[];
  /** Por que, em português, para mensagens. */
  readonly explanation: string;
}

export interface ActorInput {
  readonly env: Env;
  /** O processo tem um terminal controlador (`/dev/tty` ou o console do Windows). */
  readonly terminal: boolean;
  /** `--as <cliente>`, se veio. */
  readonly as?: string | undefined;
}

/** Decide quem roda a CLI. Função pura: tudo vem de `input`. */
export function resolveActor(input: ActorInput): ResolvedActor {
  const signals = agentSignals(input.env);
  const variables = signals.map((signal) => signal.variable);
  const fromEnv = (): string => {
    for (const signal of signals) {
      const name = signal.client ?? sanitizeAgentName((input.env[signal.variable] ?? '').split('_')[0]);
      if (name !== FALLBACK_AGENT_CLIENT) return name;
    }
    return FALLBACK_AGENT_CLIENT;
  };
  if (input.as !== undefined) {
    return {
      actor: 'agent',
      client: sanitizeAgentName(input.as),
      reason: 'as',
      signals: variables,
      explanation: `--as ${JSON.stringify(input.as)}: roda como agente (a opção só dá nome ao agente; nunca concede nada)`,
    };
  }
  if (signals.length > 0) {
    return {
      actor: 'agent',
      client: fromEnv(),
      reason: 'env',
      signals: variables,
      explanation: `o ambiente tem sinal de agente (${variables.join(', ')})`,
    };
  }
  if (ciEnabled(input.env)) {
    return {
      actor: 'agent',
      client: 'ci',
      reason: 'ci',
      signals: variables,
      explanation: 'o ambiente tem CI ligado',
    };
  }
  if (!input.terminal) {
    return {
      actor: 'agent',
      client: FALLBACK_AGENT_CLIENT,
      reason: 'no-terminal',
      signals: variables,
      explanation:
        'o processo não tem terminal controlador (roda por um agente, um script, o agendador ou um pipe sem terminal)',
    };
  }
  return {
    actor: 'human',
    client: HUMAN_CLIENT,
    reason: 'terminal',
    signals: variables,
    explanation: 'há um terminal controlador e nenhum sinal de agente',
  };
}
