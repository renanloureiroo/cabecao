// O plugin do Cabeção no Claude Code: está instalado? está ligado? qual versão? Só LÊ arquivos do Claude Code, nunca
// executa o `claude`. É o que deixa o `doctor` e o `init` avisarem quando o plugin E o registro direto do servidor MCP
// (`install-client claude-code`) estão ativos ao mesmo tempo: o agente veria as tools em dobro.
//
// Onde o Claude Code guarda isso (lido em 13/11/2026; o formato do arquivo não é documentado, então a leitura é
// tolerante e, na dúvida, diz "não sei" em vez de afirmar):
// - `<pasta>/plugins/installed_plugins.json`: os plugins instalados, por `<plugin>@<marketplace>` (versão 2: uma lista
//   de instalações por plugin, com `version` e `installPath`; versão 1: um objeto por plugin);
// - `<pasta>/settings.json`, `enabledPlugins`: `"<plugin>@<marketplace>": false` desliga um plugin instalado.
// `<pasta>` é `CLAUDE_CONFIG_DIR`, senão `~/.claude`.
import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { Location } from './clients.ts';

export interface PluginState {
  /** O plugin `cabecao` aparece entre os instalados. */
  installed: boolean;
  /** Ligado (`true`), desligado em `enabledPlugins` (`false`) ou sem informação (`null`, conta como ligado). */
  enabled: boolean | null;
  /** A chave `cabecao@<marketplace>`. */
  key: string | null;
  version: string | null;
  /** O arquivo lido. */
  file: string;
}

function claudeDir(location: Location): string {
  const path = location.platform === 'win32' ? win32 : posix;
  const custom = location.env.CLAUDE_CONFIG_DIR;
  return custom !== undefined && custom !== '' && path.isAbsolute(custom)
    ? custom
    : path.join(location.home, '.claude');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** O plugin do Cabeção no Claude Code desta máquina. Nunca lança. */
export async function claudePlugin(location: Location): Promise<PluginState> {
  const path = location.platform === 'win32' ? win32 : posix;
  const dir = claudeDir(location);
  const file = path.join(dir, 'plugins', 'installed_plugins.json');
  const none: PluginState = { installed: false, enabled: null, key: null, version: null, file };
  const document = await readJson(file);
  if (!isObject(document)) return none;
  const plugins = isObject(document.plugins) ? document.plugins : document;
  const key = Object.keys(plugins).find((name) => /^cabecao@/.test(name));
  if (key === undefined) return none;
  const entry = plugins[key];
  const first = Array.isArray(entry) ? (entry[0] as unknown) : entry;
  const version = isObject(first) && typeof first.version === 'string' ? first.version : null;
  const settings = await readJson(path.join(dir, 'settings.json'));
  const enabledPlugins = isObject(settings) && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const flag = enabledPlugins[key];
  return { installed: true, enabled: typeof flag === 'boolean' ? flag : null, key, version, file };
}

/** O plugin está instalado e não foi desligado. */
export const pluginActive = (state: PluginState): boolean => state.installed && state.enabled !== false;
