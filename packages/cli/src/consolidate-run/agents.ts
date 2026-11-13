// Adaptadores dos agentes que o `cabecao consolidate --run` sabe chamar sem ninguém olhando. Cada um sabe três coisas:
// montar o comando (argumentos, sem shell), escrever a configuração de MCP TEMPORÁRIA que aponta só para o servidor do
// Cabeção (nunca a do usuário) e ler a saída. Tudo aqui é puro: quem cria a pasta, grava os arquivos e roda o processo é
// `run.ts`; os testes conferem os argumentos sem executar agente nenhum.
//
// A regra de entrada é a segurança: um agente só tem adaptador se, em modo não interativo, dá para liberar APENAS as
// tools do servidor `cabecao` e negar shell, edição de arquivos e rede. Os que não deixam (ou que não foram testados)
// ficam em `UNSUPPORTED_AGENTS`, com o motivo, que a CLI mostra a quem pedir por eles.
//
// Fontes (consultadas em 13/11/2026) e versões conferidas com `--help` nesta data: Claude Code 2.1.323, Codex CLI
// 0.159.3, Antigravity CLI (`agy`) 1.5.0. Detalhes na pesquisa interna "Agentes - pesquisa de novembro de 2026".
import { join } from 'node:path';
import { SERVER_TOOL_NAMES } from './tools.ts';

export const RUN_AGENT_IDS = ['claude-code', 'codex', 'antigravity'] as const;
export type RunAgentId = (typeof RUN_AGENT_IDS)[number];

export function isRunAgentId(value: string): value is RunAgentId {
  return (RUN_AGENT_IDS as readonly string[]).includes(value);
}

/** Como o agente inicia o servidor do Cabeção: `node <bin> mcp --brain <cérebro> --consolidation <id>`. */
export interface ServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Variáveis que o servidor precisa (pastas, git, `PATH`); vão na configuração temporária, nunca segredos. */
  readonly env: Readonly<Record<string, string>>;
}

export interface PrepareInput {
  /** Pasta temporária vazia: diretório de trabalho do agente e lugar da configuração temporária. */
  readonly workDir: string;
  readonly server: ServerLaunch;
  readonly prompt: string;
  /** Modelo pedido com `--model`; sem ele, o mais barato que o agente deixa escolher. */
  readonly model: string | undefined;
  readonly timeoutMs: number;
}

export interface Invocation {
  readonly args: readonly string[];
  /** O roteiro pela entrada padrão (quando o agente lê dali), ou `null` se vai nos argumentos. */
  readonly stdin: string | null;
  /** Variáveis acrescentadas ao ambiente mínimo do agente. */
  readonly env: Readonly<Record<string, string>>;
  /** Arquivos da configuração temporária, com caminho relativo à pasta de trabalho (separado por `/`). */
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** O que o agente contou sobre a execução, quando contou. */
export interface AgentReport {
  /** A última mensagem do agente (o resumo), cortada. */
  readonly summary: string | null;
  readonly costUsd: number | null;
  readonly turns: number | null;
  /** O agente disse que falhou (erro, limite, cancelamento). */
  readonly error: string | null;
}

export interface ProcessOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AgentAdapter {
  readonly id: RunAgentId;
  readonly label: string;
  /** Executável procurado no `PATH`. */
  readonly binary: string;
  /** Nome do servidor do Cabeção na configuração temporária. */
  readonly serverName: string;
  /** Como o nome de uma tool aparece para o modelo (para o roteiro). */
  readonly toolExample: string;
  /** O que fica liberado e negado, em português (para o `--dry-run` e para a documentação). */
  readonly restrictions: readonly string[];
  /** Variáveis de ambiente do login do agente que são repassadas (o resto do ambiente não vai). */
  readonly loginEnv: readonly string[];
  prepare(input: PrepareInput): Invocation;
  parse(output: ProcessOutput): AgentReport;
}

/** Agentes conhecidos sem `--run`, com o motivo. */
export const UNSUPPORTED_AGENTS: Readonly<Record<string, string>> = {
  gemini:
    'o Gemini CLI deixou de atender contas pessoais em 18/06/2026 e foi substituído pelo Antigravity CLI (agy): use --agent antigravity. Para quem ainda tem o Gemini CLI (licença Enterprise ou chave paga), o modo não interativo não foi testado.',
  cursor:
    'o Cursor Agent em modo não interativo ("cursor-agent -p") tem acesso a todas as tools, inclusive shell e escrita; as permissões só se configuram em arquivo e a documentação não diz o que acontece com uma ação não liberada sem ninguém olhando. Sem essa garantia, o Cabeção não o chama.',
  vscode:
    'o VS Code não tem modo não interativo; o GitHub Copilot CLI ("copilot -p") tem opções para restringir as tools, mas ainda não foi testado com o Cabeção.',
  copilot:
    'o GitHub Copilot CLI ("copilot -p") tem opções para restringir as tools, mas ainda não foi testado com o Cabeção.',
  'claude-desktop': 'o Claude Desktop é um aplicativo de mesa, sem modo não interativo: use --agent claude-code.',
  opencode:
    'o OpenCode ("opencode run") permite negar shell e edição por configuração, mas ainda não foi testado com o Cabeção.',
};

const SUMMARY_MAX = 2000;

function clip(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length > SUMMARY_MAX ? `${trimmed.slice(0, SUMMARY_MAX)}…` : trimmed;
}

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // linha que não é JSON: segue procurando
    }
  }
  // saída num JSON só, com quebras de linha
  try {
    const value = JSON.parse(stdout) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // não é JSON
  }
  return null;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function stderrTail(output: ProcessOutput): string | null {
  const text = output.stderr.trim();
  return text === '' ? null : text.split('\n').slice(-3).join(' ').slice(0, 500);
}

/** A entrada da configuração JSON de MCP (o formato `mcpServers` do Claude Code e do Antigravity). */
function jsonServer(server: ServerLaunch): Record<string, unknown> {
  return { command: server.command, args: [...server.args], env: { ...server.env } };
}

/**
 * Claude Code (`claude -p`). Fontes: `claude --help` (2.1.323) e code.claude.com/docs (cli-reference, mcp,
 * permissions). As tools MCP chegam "adiadas" (o modelo precisa de ToolSearch para achá-las, spike 15):
 * `ENABLE_TOOL_SEARCH=false` as carrega de saída. Com `--strict-mcp-config` só o servidor da configuração temporária
 * existe, e as tools aparecem como `mcp__cabecao__<tool>`.
 */
const claudeCode: AgentAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  binary: 'claude',
  serverName: 'cabecao',
  toolExample: 'mcp__cabecao__recall',
  restrictions: [
    'só o servidor da configuração temporária (--strict-mcp-config --mcp-config): os servidores e plugins do usuário ficam de fora',
    'nenhuma tool embutida (--tools ""): sem shell, sem leitura ou edição de arquivos, sem busca ou acesso à web, sem subagentes',
    'só as tools do servidor do Cabeção liberadas (--allowedTools mcp__cabecao__*); qualquer outro pedido de permissão é negado (--permission-mode dontAsk, --permission-prompts none)',
    'sem as configurações do usuário, do projeto e locais (--restricted), sem comandos de barra nem skills (--disable-slash-commands) e sem gravar a sessão (--no-session-persistence)',
  ],
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
  prepare(input) {
    const config = { mcpServers: { cabecao: { type: 'stdio', ...jsonServer(input.server) } } };
    return {
      args: [
        '-p',
        '--output-format',
        'json',
        '--model',
        input.model ?? 'haiku',
        '--strict-mcp-config',
        '--mcp-config',
        join(input.workDir, 'mcp.json'),
        '--tools',
        '',
        '--allowedTools',
        'mcp__cabecao__*',
        '--permission-mode',
        'dontAsk',
        '--permission-prompts',
        'none',
        '--restricted',
        '--disable-slash-commands',
        '--no-session-persistence',
      ],
      // pela entrada padrão: `--mcp-config` e `--allowedTools` aceitam vários valores e engoliriam o roteiro
      stdin: input.prompt,
      env: { ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1' },
      files: [{ path: 'mcp.json', content: `${JSON.stringify(config, null, 2)}\n` }],
    };
  },
  parse(output) {
    const result = lastJsonObject(output.stdout);
    if (result === null) return { summary: null, costUsd: null, turns: null, error: stderrTail(output) };
    const isError = result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success');
    const text = typeof result.result === 'string' ? result.result : null;
    const detail = (isError ? clip(text) : null) ?? stderrTail(output);
    return {
      summary: clip(text),
      costUsd: num(result.total_cost_usd),
      turns: num(result.num_turns),
      error: isError ? `${String(result.subtype ?? 'erro')}${detail === null ? '' : `: ${detail}`}` : null,
    };
  },
};

/** Valor TOML de uma opção `-c` do Codex: string e lista de strings em JSON (que é TOML válido), tabela em linha. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineTable(values: Readonly<Record<string, string>>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${JSON.stringify(key)} = ${tomlString(value)}`)
    .join(', ')} }`;
}

/** Recursos do Codex desligados: tudo o que roda comando, mexe no navegador ou na tela, ou traz tools de fora. */
const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'image_generation',
  'multi_agent',
  'apps',
  'plugins',
  'hooks',
] as const;

/**
 * Codex CLI (`codex exec`). Fontes: `codex exec --help` e `codex features list` (0.159.3) e o código da Codex CLI
 * (codex-rs: `features.shell_tool = false` tira as tools de shell; `mcp_servers.<nome>.default_tools_approval_mode`
 * aprova as tools de um servidor). `--ignore-user-config` não lê o `config.toml` do usuário (o login continua);
 * o servidor entra por `-c mcp_servers.cabecao.*`. As tools aparecem como `mcp__cabecao__<tool>`.
 *
 * O `apply_patch` não tem chave para desligar: ele continua, mas a caixa de areia `read-only` com `approval_policy =
 * "never"` recusa qualquer escrita. A leitura de arquivos não é bloqueada pela caixa de areia quando o modelo tem uma
 * tool de leitura: sem shell e sem rede, o que ele ler só sai do computador por uma escrita no cérebro, que passa pelo
 * scanner de segredos.
 */
const codex: AgentAdapter = {
  id: 'codex',
  label: 'Codex',
  binary: 'codex',
  serverName: 'cabecao',
  toolExample: 'mcp__cabecao__recall',
  restrictions: [
    'não lê o config.toml do usuário nem as regras de execução (--ignore-user-config, --ignore-rules): os servidores, hooks e plugins dele ficam de fora; o login continua',
    `sem shell e sem as tools de navegador, tela, imagem, subagentes, apps e plugins (--disable ${CODEX_DISABLED_FEATURES.join(', ')})`,
    'caixa de areia somente leitura e nenhuma aprovação (--sandbox read-only, approval_policy = "never"): qualquer escrita em arquivo é recusada',
    'sem busca na web (web_search = "disabled"); só as tools do servidor do Cabeção aprovadas (default_tools_approval_mode = "approve")',
    'sem gravar a sessão (--ephemeral)',
  ],
  loginEnv: ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  prepare(input) {
    const prefix = 'mcp_servers.cabecao';
    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      input.workDir,
      '--json',
      '--color',
      'never',
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      '-c',
      'model_reasoning_effort="low"',
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      '-c',
      `${prefix}.command=${tomlString(input.server.command)}`,
      '-c',
      `${prefix}.args=[${input.server.args.map(tomlString).join(', ')}]`,
      '-c',
      `${prefix}.env=${tomlInlineTable(input.server.env)}`,
      '-c',
      `${prefix}.default_tools_approval_mode="approve"`,
      '-c',
      `${prefix}.startup_timeout_sec=60`,
      '-c',
      `${prefix}.tool_timeout_sec=300`,
      ...(input.model === undefined ? [] : ['--model', input.model]),
      // o roteiro vem da entrada padrão
      '-',
    ];
    return { args, stdin: input.prompt, env: {}, files: [] };
  },
  parse(output) {
    let summary: string | null = null;
    let error: string | null = null;
    let turns = 0;
    for (const line of output.stdout.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const item = event.item as Record<string, unknown> | undefined;
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        summary = item.text;
      }
      if (event.type === 'turn.completed') turns++;
      if (event.type === 'turn.failed' || event.type === 'error') {
        const detail = (event.error as { message?: unknown } | undefined)?.message ?? event.message;
        error = typeof detail === 'string' ? detail : String(event.type);
      }
    }
    if (summary === null && error === null && output.code !== 0) error = stderrTail(output);
    return { summary: clip(summary), costUsd: null, turns: turns === 0 ? null : turns, error };
  },
};

/** Nome do servidor na configuração temporária do Antigravity: diferente de `cabecao` para não colidir com o global. */
const ANTIGRAVITY_SERVER = 'cabecao-run';

/**
 * Antigravity CLI (`agy -p`). Fontes: `agy --help` (1.5.0) e antigravity.google/docs (cli/headless, mcp, permissions,
 * settings). O `agy` não tem opção para apontar outro arquivo de MCP: o servidor vai na configuração DA PASTA DE
 * TRABALHO (`.agents/mcp_config.json`), que é a pasta temporária; a global do usuário continua carregada, por isso o
 * nome `cabecao-run` (um `cabecao` global não toma o lugar dele). As permissões vão em `--settings` (só desta sessão,
 * nunca gravadas): libera `mcp(cabecao-run/*)` e nega comandos, escrita e web. Em modo `-p`, o que pede aprovação é
 * negado sem travar ("soft-denied", com aviso no stderr). As tools vão marcadas `eager`, registradas direto como
 * `mcp_cabecao-run_<tool>` (as preguiçosas exigiriam ler o esquema num arquivo fora da pasta de trabalho).
 */
const antigravity: AgentAdapter = {
  id: 'antigravity',
  label: 'Antigravity',
  binary: 'agy',
  serverName: ANTIGRAVITY_SERVER,
  toolExample: `mcp_${ANTIGRAVITY_SERVER}_recall`,
  restrictions: [
    `o servidor do Cabeção só na configuração da pasta temporária (.agents/mcp_config.json), com o nome ${ANTIGRAVITY_SERVER}; a configuração do usuário não é alterada`,
    `permissões só desta sessão (--settings): liberado mcp(${ANTIGRAVITY_SERVER}/*); negados command(*), write_file(*), read_url(*) e execute_url(*); arquivos fora da pasta de trabalho bloqueados (allowNonWorkspaceAccess: false)`,
    'o que pede aprovação é negado sem ninguém responder (modo -p); comandos só na caixa de areia (--sandbox)',
    'servidores MCP globais do usuário continuam carregados, mas as tools deles pedem aprovação e por isso são negadas',
  ],
  loginEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'],
  prepare(input) {
    const tools = Object.fromEntries(SERVER_TOOL_NAMES.map((name) => [name, { eager: true }]));
    const config = { mcpServers: { [ANTIGRAVITY_SERVER]: { ...jsonServer(input.server), tools } } };
    const settings = {
      toolPermission: 'request-review',
      enableTerminalSandbox: true,
      allowNonWorkspaceAccess: false,
      trustedWorkspaces: [input.workDir],
      permissions: {
        allow: [`mcp(${ANTIGRAVITY_SERVER}/*)`],
        deny: ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'],
      },
    };
    const seconds = Math.max(60, Math.floor(input.timeoutMs / 1000) - 15);
    return {
      args: [
        '--print',
        input.prompt,
        '--output-format',
        'json',
        '--print-timeout',
        `${seconds}s`,
        '--settings',
        JSON.stringify(settings),
        '--sandbox',
        '--disable-slash-commands',
        ...(input.model === undefined ? ['--effort', 'low'] : ['--model', input.model]),
      ],
      stdin: null,
      env: {},
      files: [{ path: '.agents/mcp_config.json', content: `${JSON.stringify(config, null, 2)}\n` }],
    };
  },
  parse(output) {
    const result = lastJsonObject(output.stdout);
    if (result === null) return { summary: null, costUsd: null, turns: null, error: stderrTail(output) };
    const status = typeof result.status === 'string' ? result.status : null;
    const errorText = typeof result.error === 'string' ? result.error : null;
    const failed = status !== null && status !== 'SUCCESS';
    return {
      summary: clip(typeof result.response === 'string' ? result.response : null),
      costUsd: null,
      turns: num(result.num_turns),
      error: failed || errorText !== null ? (errorText ?? status) : null,
    };
  },
};

export const RUN_AGENTS: Readonly<Record<RunAgentId, AgentAdapter>> = {
  'claude-code': claudeCode,
  codex,
  antigravity,
};
