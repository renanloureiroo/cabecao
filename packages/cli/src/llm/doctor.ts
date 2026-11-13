// A linha do provedor de respostas no `doctor` e no `status`. Só lê o `llm.json` e, quando há provedor ligado, faz a
// verificação barata de cada um (binário no PATH, chave presente), SEM chamar o modelo: a chamada de verdade é o
// `cabecao llm test`, que custa uma pergunta. O `init` não mostra nada disso (o RAG é opcional e sob demanda).
import type { BrainConfig } from '@cabecao/core';
import { readLlmPolicy } from '@cabecao/core';
import type { CheckResult } from '../doctor/checks.ts';
import type { LlmIo, LlmSummary } from './describe.ts';
import { llmSummary } from './describe.ts';

export async function llmCheck(io: LlmIo, brainConfig: BrainConfig | null): Promise<CheckResult> {
  const summary = await llmSummary(io);
  const title = 'Respostas (ask)';
  const policy = brainConfig === null ? null : readLlmPolicy(brainConfig);
  if (policy?.problem != null) {
    return {
      id: 'llm',
      title,
      status: 'warn',
      message: `o "llm_policy" do .cabecao.json está inválido, e nada é enviado a provedor nenhum: ${policy.problem}`,
      fix: 'Corrija o "llm_policy" (allow: "none", "agent" ou "any"; exclude_paths, exclude_types e exclude_trust como listas).',
    };
  }
  if (summary.state === 'invalid') {
    return {
      id: 'llm',
      title,
      status: 'warn',
      message: summary.problem ?? 'llm.json inválido',
      fix: 'Rode "cabecao llm on" para refazer a configuração.',
    };
  }
  if (summary.state === 'none') {
    const { detectLlm } = await import('./machine.ts');
    const found = await detectLlm(io);
    const hint =
      found.claude.path !== null
        ? 'achei o Claude Code: "cabecao llm on" o usa, com uma confirmação'
        : found.envKeys.length > 0
          ? `achei a variável ${found.envKeys[0]?.env}: "cabecao llm on" a usa`
          : '"cabecao llm on" ativa';
    return { id: 'llm', title, status: 'ok', message: `opcional e desligado: nada sai da máquina (${hint})` };
  }
  if (summary.state === 'off') {
    return {
      id: 'llm',
      title,
      status: 'ok',
      message: `desligadas nesta máquina (${summary.label} configurado; "cabecao llm on" religa)`,
    };
  }
  if (policy?.allow === 'none') {
    return {
      id: 'llm',
      title,
      status: 'ok',
      message: `${summary.label} ligado nesta máquina, mas a "llm_policy" deste cérebro proíbe enviar trechos: o "ask" devolve só os trechos`,
    };
  }
  const { activeProviders, loadLlmMachine } = await import('./machine.ts');
  const machine = await loadLlmMachine(io);
  const providers = await activeProviders(io, machine);
  const problems: string[] = [];
  let available = 0;
  for (const provider of providers) {
    const availability = await provider.check();
    if (availability.ok) available++;
    else problems.push(`${provider.id}: ${availability.reason ?? 'indisponível'}`);
  }
  const where = summary.leaves_machine === true ? `envia trechos para ${summary.destination}` : 'roda nesta máquina';
  const items = [...problems];
  if (summary.provider === 'claude-code') {
    items.push('se o agente da conversa também é o Claude Code, cada "ask" abre uma segunda sessão (custa em dobro)');
  }
  return {
    id: 'llm',
    title,
    status: available === 0 ? 'warn' : 'ok',
    message: `${summary.label} (modelo ${summary.model}) · ${where}${available === 0 ? ' · nenhum provedor disponível agora' : ''}`,
    ...(items.length === 0 ? {} : { items }),
    fix:
      available === 0
        ? 'Rode "cabecao llm test" para ver o motivo e "cabecao llm status" para os detalhes.'
        : 'Para testar com uma chamada de verdade: cabecao llm test.',
  };
}

export type { LlmSummary };
