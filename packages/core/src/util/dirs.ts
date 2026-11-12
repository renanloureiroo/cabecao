import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Tudo de que a escolha das pastas depende, passado por parâmetro para dar para testar os três sistemas. */
export interface DirContext {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
}

const APP_DIR = 'cabecao';

export function currentDirContext(): DirContext {
  return { env: process.env, platform: process.platform, homedir: homedir() };
}

function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/** Variável definida e não vazia. */
function envValue(ctx: DirContext, name: string): string | undefined {
  const value = ctx.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** A especificação XDG manda ignorar caminho relativo; o mesmo cuidado vale para `%APPDATA%`. */
function absoluteEnv(ctx: DirContext, name: string): string | undefined {
  const value = envValue(ctx, name);
  return value !== undefined && pathFor(ctx.platform).isAbsolute(value) ? value : undefined;
}

function resolveDir(
  ctx: DirContext,
  names: { override: string; windows: string; xdg: string },
  fallback: { windows: string[]; other: string[] },
): string {
  const path = pathFor(ctx.platform);
  const override = envValue(ctx, names.override);
  if (override !== undefined) return path.normalize(override);
  if (ctx.platform === 'win32') {
    return path.join(absoluteEnv(ctx, names.windows) ?? path.join(ctx.homedir, ...fallback.windows), APP_DIR);
  }
  return path.join(absoluteEnv(ctx, names.xdg) ?? path.join(ctx.homedir, ...fallback.other), APP_DIR);
}

/**
 * Pasta da configuração da máquina. Ordem: `CABECAO_CONFIG_DIR` (usada como está); no Windows `%APPDATA%\cabecao`;
 * nos demais `$XDG_CONFIG_HOME/cabecao` ou `~/.config/cabecao` (inclusive no macOS).
 */
export function configDir(ctx: DirContext = currentDirContext()): string {
  return resolveDir(
    ctx,
    { override: 'CABECAO_CONFIG_DIR', windows: 'APPDATA', xdg: 'XDG_CONFIG_HOME' },
    { windows: ['AppData', 'Roaming'], other: ['.config'] },
  );
}

/**
 * Pasta do runtime e do modelo de embeddings. Ordem: `CABECAO_CACHE_DIR` (usada como está); no Windows
 * `%LOCALAPPDATA%\cabecao`; nos demais `$XDG_CACHE_HOME/cabecao` ou `~/.cache/cabecao`.
 */
export function cacheDir(ctx: DirContext = currentDirContext()): string {
  return resolveDir(
    ctx,
    { override: 'CABECAO_CACHE_DIR', windows: 'LOCALAPPDATA', xdg: 'XDG_CACHE_HOME' },
    { windows: ['AppData', 'Local'], other: ['.cache'] },
  );
}
