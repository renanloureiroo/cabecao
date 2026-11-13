// Chamar um agente de IA instalado (Claude Code, Codex) em modo não interativo, para qualquer comando que precise:
// quem pode ser chamado e com que credencial (`policy.ts`), achar o agente e montar o ambiente mínimo (`detect.ts`) e
// rodar o processo com tempo limite e encerramento da árvore de processos (`process.ts`). O `consolidate --run` monta
// os argumentos e a configuração de MCP por cima disto (`consolidate-run/agents.ts`).
export type { ChosenAgent } from './detect.ts';
export { agentEnv, chooseAgent, locateAgent, pickEnv, SOURCE_TEXT } from './detect.ts';
export type { CallableAgent, CallableAgentId } from './policy.ts';
export { CALLABLE_AGENT_IDS, CALLABLE_AGENTS, isCallableAgentId, NOT_CALLABLE_AGENTS } from './policy.ts';
export type { AgentProcessOptions, AgentProcessResult } from './process.ts';
export { runAgentProcess } from './process.ts';
