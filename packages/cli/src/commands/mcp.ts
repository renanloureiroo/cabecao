import { stat } from 'node:fs/promises';
import type { AskInput, AskOutput, Brain, BrainConfig, EmbeddingProvider, SyncOutput } from '@cabecao/core';
import { isUlid, readBrainConfig } from '@cabecao/core';
import { readMachine, resolveBrain, toCliError } from '../brain.ts';
import { embeddingProvider } from '../embeddings.ts';
import { CliError, UsageError } from '../errors.ts';
import type { CliIo, CommandContext, CommandResult } from '../types.ts';

// O servidor vem do pacote `@cabecao/server`, carregado só aqui e só quando o comando roda (`import()` dinâmico): o
// SDK do MCP e o Zod não pesam nos outros comandos. Os tipos abaixo são o contrato combinado com o servidor; a
// atribuição em `DEFAULT_DEPS` faz o compilador conferir que a função exportada por ele continua de acordo.

/** Roda um sync e devolve a saída de `brain.sync()`. */
export type SyncRunner = (input: { session_handle?: string }) => Promise<SyncOutput>;

export interface StdioServerOptions {
  brainRoot: string;
  version: string;
  machine?: string;
  /** Sync em processo separado; a CLI passa um que roda `cabecao sync --json`. */
  syncRunner?: SyncRunner;
  /** Runtime de embeddings; criar não carrega nada (o modelo carrega na primeira busca que precisa dele). */
  embeddings?: EmbeddingProvider;
  /** Respostas geradas (tool `ask`); só quando há provedor ativo nesta máquina e o cérebro permite. */
  ask?: (brain: Brain, input: AskInput, signal?: AbortSignal) => Promise<AskOutput>;
  /** Modo sem ninguém olhando, preso a uma consolidação (`--consolidation <id>`). */
  unattended?: { consolidationId: string; allowForget: boolean; allowElevated?: boolean };
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

/** Sobe o servidor e resolve quando o transporte fecha. */
export type RunStdioServer = (options: StdioServerOptions) => Promise<void>;

/** Quanto o processo de sync pode levar: várias idas ao remoto, cada uma com tempo limite próprio no núcleo. */
export const SYNC_PROCESS_TIMEOUT_MS = 5 * 60_000;

/**
 * Sync em processo separado, como o servidor pede (doc 05): roda `<node> <bin do cabecao> sync --json --brain <pasta>`
 * sem shell e devolve a saída do `sync`. Um sync `blocked` ou `offline` sai com código 1, mas ainda é uma resposta;
 * só lança quando o processo não produziu uma saída de sync (cérebro inválido, processo morto, JSON quebrado).
 */
export function createSyncRunner(
  io: Pick<CliIo, 'exec' | 'execPath' | 'binPath' | 'env'>,
  brainRoot: string,
): SyncRunner {
  return async (input) => {
    const bin = io.binPath;
    if (bin === undefined || bin === '') {
      throw new Error('não sei onde está o programa cabecao para rodar o sync em outro processo');
    }
    const args = [bin, 'sync', '--json', '--brain', brainRoot];
    if (input.session_handle !== undefined) args.push('--session', input.session_handle);
    const result = await io.exec(io.execPath, args, { env: io.env, timeoutMs: SYNC_PROCESS_TIMEOUT_MS });
    return parseSyncProcessOutput(result);
  };
}

/** Lê a saída de `cabecao sync --json` (`{ ok, command, data }` ou `{ ok: false, error }`). */
export function parseSyncProcessOutput(result: { code: number | null; stdout: string; stderr: string }): SyncOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    const detail = (result.stderr.trim() || result.stdout.trim() || 'sem saída').split('\n').slice(-3).join(' ');
    throw new Error(`o processo do sync falhou (código ${result.code ?? 'nenhum'}): ${detail}`);
  }
  const envelope = parsed as { data?: unknown; error?: unknown } | null;
  const data = envelope?.data as Partial<SyncOutput> | null | undefined;
  if (data !== null && typeof data === 'object' && typeof data.status === 'string') return data as SyncOutput;
  // Erro do processo filho (`{ ok: false, error: { message, code, hint } }`): o `code` é o mesmo dos erros do núcleo
  // (`not_a_brain`, `locked`...), e o servidor devolve ao agente como devolveria um `BrainError`.
  const error = envelope?.error as { message?: unknown; code?: unknown; hint?: unknown } | undefined;
  const message = typeof error?.message === 'string' ? error.message : 'saída inesperada do processo do sync';
  throw Object.assign(new Error(message), {
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(typeof error?.hint === 'string' ? { next_step: error.hint } : {}),
  });
}

/**
 * A tool `ask` só existe com um provedor de respostas ativo nesta máquina (`cabecao llm on`) e permitido pela
 * `llm_policy` do cérebro. Sem `llm.json`, nada do código dos provedores é carregado. A decisão é tomada na subida do
 * servidor: ativar depois pede reiniciar o cliente de IA.
 */
export async function askRunnerFor(
  io: Pick<CliIo, 'env' | 'platform' | 'homedir' | 'stderr' | 'llmConfigDir'>,
  config: BrainConfig,
): Promise<StdioServerOptions['ask']> {
  // a pasta padrão do usuário; desviada por variável de ambiente, nada (o servidor roda para um agente; llm/describe.ts)
  const { trustedConfigDir } = await import('../llm/describe.ts');
  // o servidor atende um agente, sempre: nunca vale uma pasta desviada, mesmo com um terminal herdado
  const agentIo = { ...io, actor: { actor: 'agent' as const } };
  const { dir } = trustedConfigDir(agentIo);
  if (dir === null) return undefined;
  const exists = await stat(`${dir}/llm.json`).then(
    () => true,
    () => false,
  );
  if (!exists) return undefined;
  try {
    const { askAnnounced, runAsk } = await import('../llm/run.ts');
    if (!(await askAnnounced(agentIo, config))) return undefined;
    // um contador por processo: o teto por sessão do servidor (um cliente de IA aberto)
    const session = { calls: 0 };
    return async (brain, input, signal) =>
      (await runAsk(agentIo, brain, input, { session, ...(signal === undefined ? {} : { signal }) })).output;
  } catch {
    // o stderr do servidor chega ao cliente de IA: nada do provedor nem do motivo (o "cabecao doctor" no terminal diz)
    io.stderr.write('[cabecao] respostas (ask) indisponíveis nesta sessão; rode "cabecao doctor" no seu terminal\n');
    return undefined;
  }
}

export interface McpDeps {
  /** Carrega o servidor. Nos testes, um falso. */
  loadServer: () => Promise<RunStdioServer>;
}

const DEFAULT_DEPS: McpDeps = {
  loadServer: async () => {
    const { runStdioServer } = await import('@cabecao/server');
    return runStdioServer;
  },
};

/**
 * Sobe o servidor MCP por stdio e só volta quando o cliente fecha a conexão. stdout pertence ao protocolo: este
 * comando nunca escreve nele (o registro em `commands.ts` tem `ownsStdout`), e qualquer aviso vai para stderr.
 */
export async function runMcp(ctx: CommandContext, deps: McpDeps = DEFAULT_DEPS): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const consolidation =
    typeof ctx.values.consolidation === 'string' ? ctx.values.consolidation.trim().toUpperCase() : undefined;
  const allowForget = ctx.values['allow-forget'] === true;
  const allowElevated = ctx.values['allow-elevated'] === true;
  if (consolidation !== undefined && !isUlid(consolidation)) {
    throw new UsageError('--consolidation espera o consolidation_id inteiro (26 caracteres)');
  }
  if (allowForget && consolidation === undefined) throw new UsageError('--allow-forget vale só com --consolidation');
  if (allowElevated && consolidation === undefined) {
    throw new UsageError('--allow-elevated vale só com --consolidation');
  }
  const brainRoot = await resolveBrain(ctx);
  // Confere antes de subir: um cliente MCP mostra o stderr de um servidor que não sobe, e a mensagem diz o que fazer.
  let brainConfig: BrainConfig;
  try {
    brainConfig = await readBrainConfig(brainRoot);
  } catch (error) {
    throw toCliError(error);
  }
  // a tool `ask` só no servidor dos clientes de IA; o da consolidação sem ninguém olhando não chama provedor
  const ask = consolidation === undefined ? await askRunnerFor(ctx, brainConfig) : undefined;
  const machine = (await readMachine(ctx))?.machine;
  let runStdioServer: RunStdioServer;
  try {
    runStdioServer = await deps.loadServer();
  } catch (error) {
    throw new CliError(
      `não consegui carregar o servidor MCP: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  // Sem `stdin`/`stdout` nas opções o servidor usa os do processo e cuida dele: desvia `console.log` para o stderr,
  // trata SIGINT/SIGTERM e fecha o cérebro antes de sair. Por isso a CLI não os passa.
  await runStdioServer({
    brainRoot,
    version: ctx.version,
    ...(machine === undefined ? {} : { machine }),
    syncRunner: createSyncRunner(ctx, brainRoot),
    embeddings: embeddingProvider(ctx),
    ...(ask === undefined ? {} : { ask }),
    ...(consolidation === undefined
      ? {}
      : { unattended: { consolidationId: consolidation, allowForget, allowElevated } }),
  });
  return {};
}

export function run(ctx: CommandContext): Promise<CommandResult> {
  return runMcp(ctx);
}
