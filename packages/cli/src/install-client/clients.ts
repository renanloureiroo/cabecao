import { posix, win32 } from 'node:path';
import type { Env } from '../types.ts';
import type { JsonValue } from './jsonc.ts';
import type { Launch } from './launch.ts';

/** Nome com que o servidor aparece em todos os clientes. */
export const SERVER_NAME = 'cabecao';

export const CLIENT_IDS = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'vscode', 'gemini'] as const;
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
  targets: (location: Location) => Target[];
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
  // Fonte: documentação do Codex (config.toml, `[mcp_servers.<nome>]` com `command` e `args`).
  // `CODEX_HOME` não aparece na página de MCP: é suposição, apoiada no comportamento conhecido da CLI.
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
  // A documentação não dá o caminho do perfil por sistema: `<dados>/Code/User` é suposição.
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
  // Fonte: geminicli.com/docs/tools/mcp-server (`~/.gemini/settings.json`, `mcpServers`, sem `type`).
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    detectDirs: (location) => [pathFor(location.platform).join(location.home, '.gemini')],
    targets: (location) => [
      {
        format: 'json',
        path: pathFor(location.platform).join(location.home, '.gemini', 'settings.json'),
        section: 'mcpServers',
        entry: plain,
        when: 'always',
      },
    ],
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
