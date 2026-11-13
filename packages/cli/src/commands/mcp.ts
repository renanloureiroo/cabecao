import type { SyncOutput } from '@cabecao/core';
import { readBrainConfig } from '@cabecao/core';
import { readMachine, resolveBrain, toCliError } from '../brain.ts';
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
  const brainRoot = await resolveBrain(ctx);
  // Confere antes de subir: um cliente MCP mostra o stderr de um servidor que não sobe, e a mensagem diz o que fazer.
  try {
    await readBrainConfig(brainRoot);
  } catch (error) {
    throw toCliError(error);
  }
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
  });
  return {};
}

export function run(ctx: CommandContext): Promise<CommandResult> {
  return runMcp(ctx);
}
