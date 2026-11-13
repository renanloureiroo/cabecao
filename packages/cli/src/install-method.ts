// Como ESTE cabecao foi instalado (pelo caminho do arquivo que está rodando) e o comando certo para atualizar ou
// desinstalar, no canal em uso: enquanto a versão for de pré-lançamento (`0.1.0-beta.N`), o canal é a etiqueta
// `beta` do npm; numa versão final, `latest`. Sem o núcleo: as mensagens de erro usam isto.
import { realpathSync } from 'node:fs';
import type { CliIo } from './types.ts';
import { VERSION } from './version.ts';

export type InstallMethod = 'npm-global' | 'pnpm-global' | 'npx' | 'local' | 'plugin' | 'source' | 'unknown';

/** A etiqueta do npm do canal desta versão: `beta` para `0.1.0-beta.2`, `latest` para `1.0.0`. */
export function channel(version: string = VERSION): string {
  const pre = version.split('+')[0]?.split('-')[1];
  return pre === undefined || pre === '' ? 'latest' : (pre.split('.')[0] ?? 'latest');
}

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** A forma de instalação, pelo caminho do bin (`process.argv[1]`) e pelo ambiente. */
export function installMethod(io: Pick<CliIo, 'binPath' | 'env'>): InstallMethod {
  const bin = io.binPath;
  if (bin === undefined || bin === '') return 'unknown';
  const path = real(bin).replaceAll('\\', '/');
  const lower = path.toLowerCase();
  const root = io.env.CLAUDE_PLUGIN_ROOT;
  if (
    lower.includes('/.claude/plugins/') ||
    (root !== undefined && root !== '' && path.startsWith(root.replaceAll('\\', '/')))
  ) {
    return 'plugin';
  }
  if (/\/(?:_npx|dlx(?:-[^/]*)?|xfs-[^/]*|bunx-[^/]*)\//.test(lower)) return 'npx';
  if (/\/packages\/cli\/(?:src|dist)\//.test(lower) && !lower.includes('/node_modules/')) return 'source';
  if (/\/pnpm\/(?:global|[^/]*\/global)\//.test(lower) || lower.includes('/.pnpm-global/')) return 'pnpm-global';
  if (/\/lib\/node_modules\/cabecao\//.test(lower) || /\/npm\/node_modules\/cabecao\//.test(lower)) return 'npm-global';
  if (lower.includes('/node_modules/cabecao/')) return 'local';
  return 'unknown';
}

/** O comando que atualiza o Cabeção, para a forma de instalação detectada e o canal desta versão. */
export function upgradeCommand(io: Pick<CliIo, 'binPath' | 'env'>, version: string = VERSION): string {
  const tag = channel(version);
  switch (installMethod(io)) {
    case 'pnpm-global':
      return `pnpm add -g cabecao@${tag}`;
    case 'npx':
      return `npx cabecao@${tag} <comando>`;
    case 'local':
      return `npm i cabecao@${tag}`;
    case 'plugin':
      return '/plugin update cabecao@cabecao';
    case 'source':
      return 'git pull && pnpm build';
    default:
      return `npm i -g cabecao@${tag}`;
  }
}

/** Frase com o comando: `atualize com "npm i -g cabecao@beta"`. */
export function upgradeHint(io: Pick<CliIo, 'binPath' | 'env'>, version: string = VERSION): string {
  const method = installMethod(io);
  const command = upgradeCommand(io, version);
  if (method === 'plugin') return `atualize o plugin no Claude Code: "${command}"`;
  if (method === 'npx') return `rode pelo npx com a versão nova: "${command}"`;
  if (method === 'source') return `atualize o código-fonte: "${command}"`;
  return `atualize com "${command}"`;
}

/** O comando que tira o PROGRAMA da máquina (o `uninstall` cuida do resto), ou `null` quando não há o que tirar. */
export function removeProgramCommand(io: Pick<CliIo, 'binPath' | 'env'>): string | null {
  switch (installMethod(io)) {
    case 'pnpm-global':
      return 'pnpm remove -g cabecao';
    case 'local':
      return 'npm uninstall cabecao';
    case 'plugin':
      return '/plugin uninstall cabecao@cabecao';
    case 'npx':
    case 'source':
      return null;
    default:
      return 'npm uninstall -g cabecao';
  }
}
