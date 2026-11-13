import { posix, win32 } from 'node:path';
import type { Env } from '../types.ts';
import type { JsonValue } from './jsonc.ts';
import type { Launch } from './launch.ts';

/** Nome com que o servidor aparece em todos os clientes. */
export const SERVER_NAME = 'cabecao';

export const CLIENT_IDS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'vscode',
  'antigravity',
  'gemini',
] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

/** De onde saem os caminhos: sistema, ambiente e pasta do usuário, todos injetáveis. */
export interface Location {
  platform: NodeJS.Platform;
  env: Env;
  home: string;
}

export type JsonEntry = { [key: string]: JsonValue };

interface TargetBase {
  path: string;
  /**
   * `always`: o arquivo é criado se faltar. `if-dir-exists`: só é tocado quando a pasta dele já existe
   * (formato antigo, mantido para quem ainda o usa).
   */
  when: 'always' | 'if-dir-exists';
  /** Observação mostrada no `--print`. */
  note?: string;
}

export interface JsonTarget extends TargetBase {
  format: 'json';
  /** Chave da raiz que guarda os servidores: `mcpServers` ou `servers`. */
  section: string;
  /** Chaves que o cabecao define e mantém. */
  entry: (launch: Launch) => JsonEntry;
  /** Chaves gravadas só quando a entrada ainda não as tem; o que o usuário escolheu fica. */
  defaults?: JsonEntry;
}

export interface TomlTarget extends TargetBase {
  format: 'toml';
  /** Caminho da tabela: `[mcp_servers.cabecao]`. */
  table: readonly string[];
}

export type Target = JsonTarget | TomlTarget;

export interface ClientDef {
  id: ClientId;
  label: string;
  /** Nome do executável, quando o cliente tem um. Achá-lo no `PATH` conta como "detectado". */
  binary?: string;
  /** Pastas cuja existência indica que o cliente está instalado. */
  detectDirs: (location: Location) => string[];
  /** Arquivos cuja existência indica que o cliente está instalado (quando a pasta é dividida com outro cliente). */
  detectFiles?: (location: Location) => string[];
  targets: (location: Location) => Target[];
  /** Aviso mostrado ao registrar e no `--print` (cliente legado, por exemplo). */
  notice?: string;
}

function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function envPath(location: Location, name: string): string | undefined {
  const value = location.env[name];
  return value !== undefined && value !== '' && pathFor(location.platform).isAbsolute(value) ? value : undefined;
}

/** Pasta de dados de aplicativos de mesa (Electron): onde o Claude Desktop e o VS Code guardam a configuração. */
function appDataDir(location: Location): string {
  const path = pathFor(location.platform);
  if (location.platform === 'win32')
    return envPath(location, 'APPDATA') ?? path.join(location.home, 'AppData', 'Roaming');
  if (location.platform === 'darwin') return path.join(location.home, 'Library', 'Application Support');
  return envPath(location, 'XDG_CONFIG_HOME') ?? path.join(location.home, '.config');
}

const stdio = (launch: Launch): JsonEntry => ({ type: 'stdio', command: launch.command, args: launch.args });
const plain = (launch: Launch): JsonEntry => ({ command: launch.command, args: launch.args });

/** Pasta de configuração do Claude Code: `CLAUDE_CONFIG_DIR` troca tanto `~/.claude` quanto o `.claude.json`. */
function claudeCodeFile(location: Location): string {
  const path = pathFor(location.platform);
  return path.join(envPath(location, 'CLAUDE_CONFIG_DIR') ?? location.home, '.claude.json');
}

export const CLIENTS: Readonly<Record<ClientId, ClientDef>> = {
  // Fonte: code.claude.com/docs/en/mcp (escopo `user` no topo de ~/.claude.json) e spike 15, item 4.
  // O caminho preferido é `claude mcp add-json`; este arquivo é o recuo e a fonte para saber o que já existe.
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    detectDirs: (location) => {
      const path = pathFor(location.platform);
      return [envPath(location, 'CLAUDE_CONFIG_DIR') ?? path.join(location.home, '.claude')];
    },
    targets: (location) => [
      { format: 'json', path: claudeCodeFile(location), section: 'mcpServers', entry: stdio, when: 'always' },
    ],
  },
  // Fonte: modelcontextprotocol.io/docs/develop/connect-local-servers (os três caminhos e o exemplo sem `type`).
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    detectDirs: (location) => [pathFor(location.platform).join(appDataDir(location), 'Claude')],
    targets: (location) => [
      {
        format: 'json',
        path: pathFor(location.platform).join(appDataDir(location), 'Claude', 'claude_desktop_config.json'),
        section: 'mcpServers',
        entry: plain,
        when: 'always',
      },
    ],
  },
  // Fonte: documentação do Codex (config.toml, `[mcp_servers.<nome>]` com `command` e `args`). `CODEX_HOME`: a ajuda
  // da própria CLI (`codex exec --help`, 0.159: "--ignore-user-config  Do not load `$CODEX_HOME/config.toml`").
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    detectDirs: (location) => [codexHome(location)],
    targets: (location) => [
      {
        format: 'toml',
        path: pathFor(location.platform).join(codexHome(location), 'config.toml'),
        table: ['mcp_servers', SERVER_NAME],
        when: 'always',
      },
    ],
  },
  // Fonte: cursor.com/docs/context/mcp (`~/.cursor/mcp.json`, `mcpServers`, `type` "stdio").
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    binary: 'cursor',
    detectDirs: (location) => [pathFor(location.platform).join(location.home, '.cursor')],
    targets: (location) => [
      {
        format: 'json',
        path: pathFor(location.platform).join(location.home, '.cursor', 'mcp.json'),
        section: 'mcpServers',
        entry: stdio,
        when: 'always',
      },
    ],
  },
  // Fonte: code.visualstudio.com/docs/agents/reference/mcp-configuration. O arquivo atual é o do Copilot
  // (`~/.copilot/mcp-config.json`, raiz `mcpServers`). O `mcp.json` do perfil (raiz `servers`) é do harness
  // antigo, com remoção anunciada para fevereiro de 2027: é atualizado só se a pasta do perfil existir.
  // Conferido de novo em 13/11/2026 (página de 11/11/2026): `COPILOT_HOME` troca `~/.copilot`, e o harness antigo sai
  // em fevereiro de 2027. A documentação não dá o caminho do perfil por sistema: `<dados>/Code/User` é suposição.
  vscode: {
    id: 'vscode',
    label: 'VS Code',
    binary: 'code',
    detectDirs: (location) => [copilotHome(location), vscodeUserDir(location)],
    targets: (location) => [
      {
        format: 'json',
        path: pathFor(location.platform).join(copilotHome(location), 'mcp-config.json'),
        section: 'mcpServers',
        entry: stdio,
        defaults: { tools: ['*'] },
        when: 'always',
      },
      {
        format: 'json',
        path: pathFor(location.platform).join(vscodeUserDir(location), 'mcp.json'),
        section: 'servers',
        entry: stdio,
        when: 'if-dir-exists',
        note: 'formato antigo do VS Code, lido até fevereiro de 2027; só é gravado se a pasta existir',
      },
    ],
  },
  // Antigravity (Google): o sucessor do Gemini CLI para contas pessoais desde 18/06/2026, com CLI `agy`, IDE e App.
  // Fonte: antigravity.google/docs/mcp (consultada em 13/11/2026): global em `~/.gemini/config/mcp_config.json`, raiz
  // `mcpServers`, entrada stdio com `command` e `args` (sem `type`); o IDE lê o mesmo arquivo. Conferido com o `agy`
  // 1.5.0 numa pasta de usuário temporária: `agy mcp add` grava exatamente aí, e ignora `GEMINI_CLI_HOME`. No Windows,
  // `%USERPROFILE%\.gemini\config` é suposição (a documentação só mostra `~`). O caminho antigo do IDE e do App
  // (`~/.gemini/antigravity/mcp_config.json`) virou um link para o novo na migração para a 2.0 (relato no fórum do
  // Google AI, maio de 2026): é atualizado só se a pasta existir, e a escrita segue o link.
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    binary: 'agy',
    detectDirs: (location) => {
      const path = pathFor(location.platform);
      const gemini = path.join(location.home, '.gemini');
      return [
        path.join(gemini, 'antigravity-cli'),
        path.join(gemini, 'antigravity'),
        path.join(gemini, 'antigravity-ide'),
        path.join(gemini, 'config'),
      ];
    },
    targets: (location) => {
      const path = pathFor(location.platform);
      const gemini = path.join(location.home, '.gemini');
      return [
        {
          format: 'json',
          path: path.join(gemini, 'config', 'mcp_config.json'),
          section: 'mcpServers',
          entry: plain,
          when: 'always',
        },
        {
          format: 'json',
          path: path.join(gemini, 'antigravity', 'mcp_config.json'),
          section: 'mcpServers',
          entry: plain,
          when: 'if-dir-exists',
          note: 'caminho antigo do IDE e do App do Antigravity; só é gravado se a pasta existir',
        },
      ];
    },
  },
  // Gemini CLI: deixou de atender contas pessoais (gratuitas, Google AI Pro e Ultra) em 18/06/2026 e foi substituído
  // pelo Antigravity CLI; continua para licenças Gemini Code Assist Standard/Enterprise e chaves pagas de API (Google
  // Developers Blog, 19/05/2026). O registro continua o mesmo. Fonte: geminicli.com/docs/tools/mcp-server (atualizada em
  // 06/10/2026): `~/.gemini/settings.json`, `mcpServers`, sem `type`. A pasta `~/.gemini` é dividida com o Antigravity:
  // o cliente só conta como detectado pelo executável `gemini` ou pelo `settings.json`.
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    detectDirs: () => [],
    detectFiles: (location) => [pathFor(location.platform).join(location.home, '.gemini', 'settings.json')],
    targets: (location) => [
      {
        format: 'json',
        path: pathFor(location.platform).join(location.home, '.gemini', 'settings.json'),
        section: 'mcpServers',
        entry: plain,
        when: 'always',
      },
    ],
    notice:
      'o Gemini CLI deixou de atender contas pessoais em 18/06/2026 e foi substituído pelo Antigravity: se é o seu caso, use "cabecao install-client antigravity"',
  },
};

function codexHome(location: Location): string {
  return envPath(location, 'CODEX_HOME') ?? pathFor(location.platform).join(location.home, '.codex');
}

function copilotHome(location: Location): string {
  return envPath(location, 'COPILOT_HOME') ?? pathFor(location.platform).join(location.home, '.copilot');
}

function vscodeUserDir(location: Location): string {
  return pathFor(location.platform).join(appDataDir(location), 'Code', 'User');
}
