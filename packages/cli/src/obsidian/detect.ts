// O Obsidian está com este vault aberto? Com o aplicativo aberto, ele ignora e regrava os arquivos de `.obsidian/`
// (spike 15, item 8b: a edição externa do `graph.json` foi sobrescrita quando a aba do grafo fechou).
//
// Dois sinais, os dois só de leitura: o `obsidian.json` global do aplicativo marca com `"open": true` os vaults que
// estavam abertos (continua marcado depois de fechar o aplicativo com o vault aberto) e a lista de processos diz se o
// aplicativo está rodando. Os dois juntos = aberto; um só = talvez. Nada da configuração do Obsidian é alterado.
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homeDir } from '../dirs.ts';
import type { CliIo } from '../types.ts';

export interface ObsidianPresence {
  /** O `obsidian.json` conhece este vault. */
  readonly registered: boolean;
  /** E o marca como aberto. */
  readonly markedOpen: boolean;
  /** O processo do Obsidian está rodando (`null`: não deu para saber). */
  readonly running: boolean | null;
}

/** Onde o Obsidian guarda o `obsidian.json` em cada sistema (instalação normal e, no Linux, Flatpak e Snap). */
export function obsidianConfigCandidates(io: Pick<CliIo, 'env' | 'platform' | 'homedir'>): string[] {
  const home = homeDir(io);
  if (io.platform === 'darwin') return [join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')];
  if (io.platform === 'win32') {
    return [join(io.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')];
  }
  const xdg =
    io.env.XDG_CONFIG_HOME !== undefined && io.env.XDG_CONFIG_HOME !== ''
      ? io.env.XDG_CONFIG_HOME
      : join(home, '.config');
  return [
    join(xdg, 'obsidian', 'obsidian.json'),
    join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
    join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),
  ];
}

async function canonical(path: string, platform: NodeJS.Platform): Promise<string> {
  let real = path;
  try {
    real = await realpath(path);
  } catch {
    // caminho que não existe mais: compara como está
  }
  const normal = real.replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? normal.toLowerCase() : normal;
}

async function vaultState(
  root: string,
  io: Pick<CliIo, 'env' | 'platform' | 'homedir'>,
): Promise<{ registered: boolean; markedOpen: boolean }> {
  const target = await canonical(root, io.platform);
  for (const file of obsidianConfigCandidates(io)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const vaults = (parsed as { vaults?: Record<string, { path?: unknown; open?: unknown }> } | null)?.vaults;
    if (typeof vaults !== 'object' || vaults === null) continue;
    for (const vault of Object.values(vaults)) {
      if (typeof vault?.path !== 'string') continue;
      if ((await canonical(vault.path, io.platform)) === target) {
        return { registered: true, markedOpen: vault.open === true };
      }
    }
  }
  return { registered: false, markedOpen: false };
}

async function obsidianRunning(io: Pick<CliIo, 'exec' | 'platform'>): Promise<boolean | null> {
  try {
    if (io.platform === 'win32') {
      const result = await io.exec('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], { timeoutMs: 5000 });
      if (result.code !== 0) return null;
      return /obsidian\.exe/i.test(result.stdout);
    }
    // nome exato do processo, sem diferenciar maiúsculas: "Obsidian" no macOS, "obsidian" no Linux
    const result = await io.exec('pgrep', ['-x', '-i', 'obsidian'], { timeoutMs: 5000 });
    if (result.code === 1) return false;
    if (result.code !== 0) return null;
    return result.stdout.trim() !== '';
  } catch {
    return null;
  }
}

export async function obsidianPresence(
  root: string,
  io: Pick<CliIo, 'env' | 'platform' | 'homedir' | 'exec'>,
): Promise<ObsidianPresence> {
  const state = await vaultState(root, io);
  return { ...state, running: await obsidianRunning(io) };
}
