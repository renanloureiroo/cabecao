// O `ask` com os provedores desta máquina: usado pelo comando `cabecao ask` e pela tool `ask` do servidor MCP (que roda
// no mesmo processo do `cabecao mcp`). Lê o `llm.json`, monta os provedores, chama o núcleo e grava uma linha no log
// local. O que volta para o agente é só `AskResult.output`: nada do provedor.
import type { AskBrain, AskInput, AskOptions, AskResult, BrainConfig } from '@cabecao/core';
import { ask, readLlmPolicy } from '@cabecao/core';
import type { BuildOptions, LlmIo, LlmMachine } from './machine.ts';
import { activeProviders, appendAskLog, loadLlmMachine } from './machine.ts';

export interface RunAskOptions extends Pick<AskOptions, 'signal' | 'onProgress' | 'onClaim'> {
  readonly machine?: LlmMachine;
  readonly build?: BuildOptions;
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
  const result = await ask(brain, input, {
    providers,
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
