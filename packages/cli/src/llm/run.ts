// O `ask` com os provedores desta máquina: usado pelo comando `cabecao ask` e pela tool `ask` do servidor MCP (que roda
// no mesmo processo do `cabecao mcp`). Lê o `llm.json`, monta os provedores, chama o núcleo e grava uma linha no log
// local. O que volta para o agente é só `AskResult.output`: nada do provedor.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AskBrain, AskInput, AskOptions, AskResult, BrainConfig } from '@cabecao/core';
import { AskCancelledError, ask, readLlmPolicy, withLock, writeFileAtomic } from '@cabecao/core';
import type { BuildOptions, LlmIo, LlmMachine } from './machine.ts';
import { activeProviders, appendAskLog, loadLlmMachine } from './machine.ts';

export interface RunAskOptions extends Pick<AskOptions, 'signal' | 'onProgress' | 'onClaim'> {
  readonly machine?: LlmMachine;
  readonly build?: BuildOptions;
  /** Contador da sessão do servidor MCP (um por processo): o teto por sessão. */
  readonly session?: { calls: number };
  /** Relógio (testes). */
  readonly now?: () => number;
}

/** Arquivo das perguntas que chegaram ao provedor na última hora, na pasta da configuração (que um agente não troca). */
export const USAGE_FILE = 'ask-usage.json';
export const USAGE_LOCK_FILE = 'ask-usage.lock';
const HOUR_MS = 60 * 60 * 1000;

function recentOf(value: unknown, now: number): number[] {
  const calls = (value as { calls?: unknown } | null)?.calls;
  return Array.isArray(calls)
    ? calls.filter((at): at is number => typeof at === 'number' && at > now - HOUR_MS && at <= now + HOUR_MS)
    : [];
}

async function readUsage(dir: string, now: number): Promise<number[]> {
  try {
    return recentOf(JSON.parse(await readFile(join(dir, USAGE_FILE), 'utf8')), now);
  } catch {
    return [];
  }
}

async function writeUsage(dir: string, calls: readonly number[]): Promise<void> {
  await writeFileAtomic(join(dir, USAGE_FILE), `${JSON.stringify({ calls })}\n`, { mode: 0o600 });
}

/** Trava do contador: entre processos (CLI e servidores MCP abertos ao mesmo tempo) e entre perguntas concorrentes. */
function usageLock(dir: string): string {
  return join(dir, USAGE_LOCK_FILE);
}

/** Reserva uma vaga na hora, atomicamente. `false`: o teto já foi atingido (ou não deu para travar: fecha). */
export async function reserveCall(dir: string, now: number, maxPerHour: number): Promise<boolean> {
  try {
    return await withLock(
      usageLock(dir),
      async () => {
        const calls = await readUsage(dir, now);
        if (calls.length >= maxPerHour) return false;
        await writeUsage(dir, [...calls, now]);
        return true;
      },
      { timeoutMs: 15_000 },
    );
  } catch {
    return false;
  }
}

/** Devolve a vaga reservada (nenhum pedido saiu). */
export async function releaseCall(dir: string, at: number): Promise<void> {
  await withLock(
    usageLock(dir),
    async () => {
      const calls = await readUsage(dir, at);
      const index = calls.lastIndexOf(at);
      if (index !== -1) calls.splice(index, 1);
      await writeUsage(dir, calls);
    },
    { timeoutMs: 15_000 },
  ).catch(() => {});
}

export async function runAsk(
  io: LlmIo,
  brain: AskBrain,
  input: AskInput,
  options: RunAskOptions = {},
): Promise<AskResult> {
  const machine = options.machine ?? (await loadLlmMachine(io));
  const providers = await activeProviders(io, machine, options.build);
  const limits = machine.config?.limits;
  // teto de gasto: por hora (na máquina toda) e por sessão do servidor. A vaga é RESERVADA antes de chamar o provedor
  // (na sessão, sem nenhum await no meio; na hora, sob a trava do arquivo, entre processos) e só volta se nenhum
  // pedido saiu. Estourado, o ask devolve só os trechos.
  const now = (options.now ?? Date.now)();
  let sessionReserved = false;
  let hourReserved = false;
  let limitReached = false;
  if (limits !== undefined && providers.length > 0) {
    const session = options.session;
    if (session !== undefined) {
      if (session.calls >= limits.max_calls_per_session) limitReached = true;
      else {
        session.calls += 1;
        sessionReserved = true;
      }
    }
    if (!limitReached && machine.configDir !== '') {
      hourReserved = await reserveCall(machine.configDir, now, limits.max_calls_per_hour);
      if (!hourReserved) limitReached = true;
    }
    if (limitReached && sessionReserved && session !== undefined) {
      session.calls -= 1;
      sessionReserved = false;
    }
  }
  const release = async (): Promise<void> => {
    if (sessionReserved && options.session !== undefined) options.session.calls -= 1;
    if (hourReserved) await releaseCall(machine.configDir, now);
  };
  let result: AskResult;
  try {
    result = await ask(brain, input, {
      providers,
      limitReached,
      ...(limits === undefined
        ? {}
        : {
            limits: {
              contextTokens: limits.context_tokens,
              maxOutputTokens: limits.max_output_tokens,
              timeoutMs: limits.timeout_ms,
            },
          }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.onClaim === undefined ? {} : { onClaim: options.onClaim }),
    });
  } catch (error) {
    // erro de argumento sai antes de qualquer pedido; um cancelamento pode ter gastado: a vaga fica
    if (!(error instanceof AskCancelledError)) await release();
    throw error;
  }
  const { output, diagnostics } = result;
  // a vaga só volta quando nenhum pedido saiu (sem trecho para mandar, provedor não instalado, política)
  if (diagnostics.requests === 0) await release();
  await appendAskLog(machine.cacheDir, {
    at: new Date().toISOString(),
    // a pergunta, cortada; nenhum trecho do cérebro e nenhuma chave
    question: output.question.slice(0, 200),
    status: output.status,
    ...(output.unavailable_reason === undefined ? {} : { unavailable_reason: output.unavailable_reason }),
    provider: diagnostics.provider,
    model: diagnostics.model,
    attempts: diagnostics.attempts,
    duration_ms: diagnostics.duration_ms,
    requests: diagnostics.requests,
    usage: diagnostics.usage,
    cost_usd: diagnostics.cost_usd,
    claims: output.claims.length,
    unsupported_claims: output.unsupported_claims,
    removed_citations: output.removed_citations,
    passages_sent: diagnostics.passages_sent,
    omitted: output.omitted,
  });
  return result;
}

/**
 * A tool `ask` deve ser anunciada? Só quando há provedor ativo nesta máquina E o cérebro permite ao menos um deles
 * (`llm_policy`). Sem isso, `tools/list` nem mostra a tool e o agente segue com `search` e `read`.
 */
export async function askAnnounced(io: LlmIo, config: BrainConfig): Promise<boolean> {
  const machine = await loadLlmMachine(io);
  const providers = machine.config === null ? [] : await activeProviders(io, machine);
  if (providers.length === 0) return false;
  const policy = readLlmPolicy(config);
  if (policy.allow === 'none') return false;
  return policy.allow === 'any' || providers.some((provider) => provider.kind !== 'http');
}
