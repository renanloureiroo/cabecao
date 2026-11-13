// O `ask` com os provedores desta máquina: usado pelo comando `cabecao ask` e pela tool `ask` do servidor MCP (que roda
// no mesmo processo do `cabecao mcp`). Lê o `llm.json`, monta os provedores, chama o núcleo e grava uma linha no log
// local. O que volta para o agente é só `AskResult.output`: nada do provedor.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AskBrain, AskInput, AskOptions, AskResult, BrainConfig } from '@cabecao/core';
import { ask, readLlmPolicy, writeFileAtomic } from '@cabecao/core';
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
const HOUR_MS = 60 * 60 * 1000;

async function recentCalls(dir: string, now: number): Promise<number[]> {
  try {
    const value = JSON.parse(await readFile(join(dir, USAGE_FILE), 'utf8')) as { calls?: unknown };
    return Array.isArray(value.calls)
      ? value.calls.filter((at): at is number => typeof at === 'number' && at > now - HOUR_MS && at <= now)
      : [];
  } catch {
    return [];
  }
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
  // teto de gasto: por hora (na máquina toda) e por sessão do servidor; estourado, o ask devolve só os trechos
  const now = (options.now ?? Date.now)();
  const calls = machine.configDir === '' ? [] : await recentCalls(machine.configDir, now);
  const limitReached =
    limits !== undefined &&
    providers.length > 0 &&
    (calls.length >= limits.max_calls_per_hour ||
      (options.session !== undefined && options.session.calls >= limits.max_calls_per_session));
  const result = await ask(brain, input, {
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
  const { output, diagnostics } = result;
  // conta só a pergunta que chegou a um provedor
  if (diagnostics.provider !== null || diagnostics.attempts.some((a) => a.kind !== 'not_installed')) {
    if (options.session !== undefined) options.session.calls += 1;
    if (machine.configDir !== '') {
      await writeFileAtomic(join(machine.configDir, USAGE_FILE), `${JSON.stringify({ calls: [...calls, now] })}\n`, {
        mode: 0o600,
      }).catch(() => {});
    }
  }
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
