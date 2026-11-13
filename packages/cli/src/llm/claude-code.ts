// Provedor "agente instalado": o Claude Code (`claude -p`), com o login que o usuário já tem. Quem pode ser chamado, com
// que credencial, como achar o executável e qual ambiente ele recebe é a regra comum de `../agents/` (a mesma do
// `consolidate --run`); o processo também é o de lá, com o cancelamento por `AbortSignal` acrescentado para o `ask`. A
// Anthropic documenta que "the Claude Agent SDK and `claude -p` still draw from your subscription limits"
// (https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan, 13/11/2026). É o
// único agente oferecido como provedor de respostas: o Antigravity não deixa ser embrulhado em outro aplicativo nos
// planos pessoais, e o Codex só pode ser chamado com chave de API (`../agents/policy.ts`); com uma chave da OpenAI, a
// API direta (`--provider openai`) faz o mesmo sem subir um agente que não deixa tirar todas as tools.
//
// Para GERAR a resposta o agente não precisa de nada: nenhuma tool embutida (`--tools ""`), nenhum servidor MCP
// (`--strict-mcp-config` com uma configuração vazia), sem as configurações do usuário, do projeto e locais
// (`--restricted`), sem comandos de barra e skills, sem gravar a sessão, qualquer pedido de permissão negado, numa pasta
// temporária vazia, com ambiente mínimo e tempo limite. O prompt vai pela entrada padrão (no Windows a linha de comando
// tem teto de 32.767 caracteres); a resposta volta em JSON validado pelo próprio Claude Code (`--json-schema`).
// Flags conferidas com `claude --help` (2.1.323) e na referência da CLI (code.claude.com/docs/en/cli-reference).
// NÃO usa `--bare`: ele não usa o login da assinatura.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Availability, GenerateRequest, GenerateResult, GenerationProvider } from '@cabecao/core';
import { ProviderError, redact } from '@cabecao/core';
import type { AgentProcessOptions, AgentProcessResult } from '../agents/index.ts';
import { agentEnv, CALLABLE_AGENTS, locateAgent, runAgentProcess } from '../agents/index.ts';
import type { Env } from '../types.ts';
import { CLAUDE_CODE_DEFAULT_MODEL, CLAUDE_CODE_DESTINATION } from './describe.ts';

export {
  CLAUDE_CODE_BINARY,
  CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_DESTINATION,
  CLAUDE_CODE_LABEL,
} from './describe.ts';

const CLAUDE = CALLABLE_AGENTS['claude-code'];

/** Ambiente mínimo do agente (a regra comum de `../agents/`), sem atualização automática e sem histórico de prompts. */
export function claudeEnv(env: Env): Env {
  return agentEnv(env, CLAUDE, CLAUDE.credentials(env), {
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  });
}

/** Argumentos exatos (sem shell). O prompt de sistema vai num arquivo da pasta temporária. */
export function claudeArgs(input: {
  readonly schema: unknown;
  readonly model: string;
  readonly systemFile: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(input.schema),
    '--model',
    input.model,
    '--system-prompt-file',
    input.systemFile,
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--restricted',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--disable-slash-commands',
    '--no-session-persistence',
    // a saída estruturada do Claude Code pode gastar um turno a mais para entregar o JSON; sem tools, não há laço
    '--max-turns',
    '3',
  ];
}

const AUTH_RE = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token|log in/i;

function lastJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // várias linhas: procura a última que seja um objeto
  }
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // segue
    }
  }
  return null;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Lê a saída do `claude -p --output-format json`. Lança `ProviderError` com mensagem sem segredo. */
export function parseClaudeOutput(
  run: AgentProcessResult,
  timeoutMs: number,
  secrets: readonly string[],
): Omit<GenerateResult, 'durationMs'> {
  const tail = (text: string): string => redact(text.trim().split('\n').slice(-3).join(' ').slice(0, 300), secrets);
  if (run.interrupted) throw new ProviderError('cancelled', 'cancelado');
  if (run.spawnError !== null) {
    throw new ProviderError('not_installed', `não consegui iniciar o Claude Code: ${tail(run.spawnError)}`);
  }
  if (run.timedOut) {
    throw new ProviderError('timeout', `o Claude Code não respondeu em ${Math.round(timeoutMs / 1000)} s`, {
      retryable: true,
    });
  }
  const data = lastJson(run.stdout);
  if (data === null) {
    const detail = tail(run.stderr || run.stdout) || `código de saída ${run.code ?? 'nenhum'}`;
    if (AUTH_RE.test(run.stderr) || AUTH_RE.test(run.stdout)) {
      throw new ProviderError('not_authenticated', `o Claude Code não está logado nesta máquina: ${detail}`);
    }
    throw new ProviderError('unknown', `o Claude Code falhou: ${detail}`);
  }
  const resultText = typeof data.result === 'string' ? data.result : '';
  if (data.is_error === true) {
    const subtype = typeof data.subtype === 'string' ? data.subtype : 'erro';
    if (AUTH_RE.test(resultText)) {
      throw new ProviderError('not_authenticated', `o Claude Code não está logado nesta máquina: ${tail(resultText)}`);
    }
    if (/rate|limit|overload|usage/i.test(resultText)) {
      throw new ProviderError('rate_limited', `o Claude Code atingiu um limite de uso: ${tail(resultText)}`, {
        retryable: true,
      });
    }
    throw new ProviderError('unknown', `o Claude Code terminou com erro (${subtype}): ${tail(resultText)}`);
  }
  const usage = data.usage as Record<string, unknown> | undefined;
  const base = {
    // o Claude Code separa a entrada lida do cache e a gravada nele; o total é a soma
    usage: {
      inputTokens:
        num(usage?.input_tokens) === null
          ? null
          : (num(usage?.input_tokens) ?? 0) +
            (num(usage?.cache_creation_input_tokens) ?? 0) +
            (num(usage?.cache_read_input_tokens) ?? 0),
      outputTokens: num(usage?.output_tokens),
    },
    costUsd: num(data.total_cost_usd),
  };
  if (data.structured_output !== undefined && data.structured_output !== null) {
    return { object: data.structured_output, ...base };
  }
  // sem `structured_output`: o modelo recusou ou não entregou o formato
  if (resultText.trim() === '') throw new ProviderError('refused', 'o Claude Code não devolveu resposta estruturada');
  throw new ProviderError(
    'invalid_output',
    `o Claude Code não devolveu a resposta no formato pedido: ${tail(resultText)}`,
  );
}

export interface ClaudeCodeProviderOptions {
  readonly id: string;
  readonly model: string | null;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /** Pasta onde criar a pasta temporária de trabalho (padrão: a do sistema). */
  readonly tmpRoot?: string;
  /** Troca o executor (testes com um agente falso). */
  readonly run?: (file: string, args: readonly string[], options: AgentProcessOptions) => Promise<AgentProcessResult>;
  /** Troca a busca no PATH (testes). */
  readonly locate?: () => Promise<string | undefined>;
}

/** Acha o `claude` no PATH (a regra comum: no Windows, um `.cmd`/`.bat` é recusado), sem lançar. */
export async function locateClaude(
  env: Env,
  platform: NodeJS.Platform,
): Promise<{ path: string | null; problem: string | null }> {
  try {
    const path = await locateAgent({ env, platform }, CLAUDE);
    return path === null
      ? { path: null, problem: 'o comando "claude" não está no PATH desta máquina' }
      : { path, problem: null };
  } catch (error) {
    return { path: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

export function createClaudeCodeProvider(options: ClaudeCodeProviderOptions): GenerationProvider {
  const model = options.model ?? CLAUDE_CODE_DEFAULT_MODEL;
  const run = options.run ?? runAgentProcess;
  const locate = async (): Promise<{ path: string | null; problem: string | null }> => {
    if (options.locate !== undefined) {
      const path = (await options.locate()) ?? null;
      return { path, problem: path === null ? 'o comando "claude" não foi encontrado' : null };
    }
    return locateClaude(options.env, options.platform);
  };
  // o que pode aparecer numa mensagem e não deve: as credenciais que o agente recebe do ambiente
  const secrets = CLAUDE.loginEnv
    .filter((name) => /KEY|TOKEN/.test(name))
    .map((name) => options.env[name])
    .filter((value): value is string => value !== undefined && value.length >= 8);
  return {
    id: options.id,
    kind: 'agent',
    destination: CLAUDE_CODE_DESTINATION,
    leavesMachine: true,
    model,
    async check(): Promise<Availability> {
      const found = await locate();
      return found.path === null
        ? { ok: false, kind: 'not_installed', reason: found.problem ?? 'não encontrado' }
        : { ok: true };
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const found = await locate();
      if (found.path === null)
        throw new ProviderError('not_installed', found.problem ?? 'o Claude Code não foi encontrado');
      const workDir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'cabecao-ask-'));
      try {
        const systemFile = join(workDir, 'system.txt');
        await writeFile(systemFile, request.system, { mode: 0o600 });
        const started = Date.now();
        const result = await run(found.path, claudeArgs({ schema: request.schema, model, systemFile }), {
          cwd: workDir,
          env: claudeEnv(options.env),
          stdin: request.user,
          timeoutMs: request.timeoutMs,
          platform: options.platform,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const parsed = parseClaudeOutput(result, request.timeoutMs, secrets);
        return { ...parsed, durationMs: Date.now() - started };
      } finally {
        await rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    },
  };
}
