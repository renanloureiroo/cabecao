// Que agente de IA o Cabeção pode chamar de dentro dele, em modo não interativo, e com que credencial. É a regra que
// vale para todo comando que roda um agente sozinho (o `consolidate --run` e o que vier depois): um agente só entra se
// os TERMOS dele permitem ser chamado por outro programa com a credencial em uso, conferido em fonte oficial, e se dá
// para restringi-lo às tools do Cabeção. As fontes (com data) estão na pesquisa interna "Agentes - pesquisa de
// novembro de 2026".
import type { Env } from '../types.ts';

/** Agentes que o Cabeção pode chamar em modo não interativo. */
export const CALLABLE_AGENT_IDS = ['claude-code', 'codex'] as const;
export type CallableAgentId = (typeof CALLABLE_AGENT_IDS)[number];

export function isCallableAgentId(value: string): value is CallableAgentId {
  return (CALLABLE_AGENT_IDS as readonly string[]).includes(value);
}

export interface CallableAgent {
  readonly id: CallableAgentId;
  readonly label: string;
  /** Executável procurado no `PATH`. */
  readonly binary: string;
  /** Variáveis do login do agente repassadas ao processo (o resto do ambiente não vai). */
  readonly loginEnv: readonly string[];
  /**
   * A credencial que os termos permitem para uso por outro programa, como variáveis a acrescentar ao ambiente do
   * agente; `null` quando ela não está disponível (a mensagem diz o que fazer).
   */
  credentials(env: Env): Readonly<Record<string, string>> | null;
  /** O que falta quando `credentials` devolve `null`. */
  readonly missingCredentials: string;
}

/**
 * Claude Code: a página "Legal and compliance" (code.claude.com/docs/en/legal-and-compliance, consultada em
 * 13/11/2026) diz que as restrições a terceiros não impedem "an end user from signing in to the unmodified Claude Code
 * binary with their own Claude subscription"; o Cabeção roda o `claude` publicado, na máquina do usuário, com o login
 * dele (assinatura ou chave de API), sem tocar nem repassar a credencial. Os limites anunciados da assinatura supõem
 * uso individual comum.
 *
 * Codex: a OpenAI manda usar chave de API em fluxos programáticos ("Use API key authentication for programmatic Codex
 * CLI workflows, such as CI/CD jobs", learn.chatgpt.com/docs/auth, consultada em 13/11/2026) e não diz que o login do
 * ChatGPT pode ser usado assim fora do Enterprise. Por isso o Codex só é chamado com chave de API: `CODEX_API_KEY` (ou
 * `OPENAI_API_KEY`, copiada para `CODEX_API_KEY`), que no `codex exec` tem precedência sobre o login guardado, então o
 * login do ChatGPT nunca é usado.
 */
export const CALLABLE_AGENTS: Readonly<Record<CallableAgentId, CallableAgent>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    loginEnv: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'AWS_PROFILE',
      'AWS_REGION',
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'CLOUD_ML_REGION',
    ],
    credentials: () => ({}),
    missingCredentials: '',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    loginEnv: ['CODEX_HOME', 'OPENAI_BASE_URL'],
    credentials(env) {
      const key = [env.CODEX_API_KEY, env.OPENAI_API_KEY].find((value) => value !== undefined && value.trim() !== '');
      return key === undefined ? null : { CODEX_API_KEY: key.trim() };
    },
    missingCredentials:
      'o Codex só é chamado com chave de API (CODEX_API_KEY ou OPENAI_API_KEY): a OpenAI orienta usar chave de API em uso programático, e o login do ChatGPT não é usado. Fonte: https://learn.chatgpt.com/docs/auth',
  },
};

/** Agentes conhecidos que o Cabeção NÃO chama sozinho, com o motivo (mostrado a quem pedir por eles). */
export const NOT_CALLABLE_AGENTS: Readonly<Record<string, string>> = {
  antigravity:
    'os termos do Antigravity não permitem: "Wrapping agy inside third-party coding agents or applications [...] is not supported under consumer plans", e usar software de terceiros para acessar o Antigravity viola os termos e pode suspender a conta (https://antigravity.google/docs/faq/). Para consolidar com o Antigravity, abra uma sessão nele e peça para seguir o prompt "consolidate" do Cabeção (ou os passos de "cabecao consolidate"), com as tools do servidor MCP registrado por "cabecao install-client antigravity".',
  gemini:
    'o Gemini CLI deixou de atender contas pessoais em 18/06/2026 e foi substituído pelo Antigravity, cujos termos não permitem ser chamado por outro programa no plano pessoal (https://antigravity.google/docs/faq/). Consolide numa sessão sua, com o prompt "consolidate" do Cabeção.',
  cursor:
    'o Cursor Agent em modo não interativo ("cursor-agent -p") tem acesso a todas as tools, inclusive shell e escrita; as permissões só se configuram em arquivo e a documentação não diz o que acontece com uma ação não liberada sem ninguém olhando. Sem essa garantia, o Cabeção não o chama.',
  vscode:
    'o VS Code não tem modo não interativo; o GitHub Copilot CLI ("copilot -p") tem opções para restringir as tools, mas os termos e as restrições ainda não foram conferidos com o Cabeção.',
  copilot:
    'o GitHub Copilot CLI ("copilot -p") tem opções para restringir as tools, mas os termos e as restrições ainda não foram conferidos com o Cabeção.',
  'claude-desktop': 'o Claude Desktop é um aplicativo de mesa, sem modo não interativo: use --agent claude-code.',
  opencode:
    'o OpenCode ("opencode run") permite negar shell e edição por configuração, mas ainda não foi testado com o Cabeção.',
};
