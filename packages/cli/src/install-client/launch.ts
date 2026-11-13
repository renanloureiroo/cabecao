import { realpath } from 'node:fs/promises';
import type { CliIo } from '../types.ts';

/** Como o cliente inicia o servidor MCP. */
export interface Launch {
  command: string;
  args: string[];
  /** `node`: caminho direto para o Node e para o arquivo do bin. `npx`: baixa (ou reusa) o pacote a cada início. */
  via: 'node' | 'npx';
}

// Pastas de execução temporária: npm (`~/.npm/_npx/<hash>`), pnpm (`dlx`, `dlx-<pid>`), yarn (`xfs-<id>/dlx-<pid>`)
// e bun (`bunx-<uid>-<pacote>`). O que mora nelas some na limpeza do cache; não serve de endereço fixo.
const EPHEMERAL_SEGMENT = /^(?:_npx|dlx|dlx-.*|xfs-.*|bunx-.*)$/;

/** O arquivo do bin em uso, se ele mora num lugar estável (instalação global ou local) e é um `.mjs`/`.js`. */
async function stableBin(binPath: string | undefined): Promise<string | undefined> {
  if (binPath === undefined || binPath === '') return undefined;
  let real: string;
  try {
    // O bin global é um link em `<prefixo>/bin`: o registro aponta para o arquivo de verdade.
    real = await realpath(binPath);
  } catch {
    return undefined;
  }
  // Rodando do código-fonte (`node src/bin.ts`) não há o que registrar: exigiria Node 22.18+ no cliente.
  if (!/\.[cm]?js$/.test(real)) return undefined;
  if (real.split(/[\\/]/).some((segment) => EPHEMERAL_SEGMENT.test(segment))) return undefined;
  return real;
}

/**
 * Decide como o servidor é referenciado na configuração do cliente.
 *
 * - Instalação estável: `<node> <arquivo do bin> mcp --brain <pasta>`. Não depende do `PATH` do cliente (os
 *   aplicativos de mesa não herdam o do terminal) e economiza o 0,5–1,4 s de `npx` a cada início de sessão.
 *   Em troca, o registro quebra se esse Node ou essa instalação forem removidos: basta rodar `install-client`
 *   de novo.
 * - Rodando por `npx`/`dlx`, do código-fonte, ou com `--npx`: `npx -y cabecao mcp --brain <pasta>`. No Windows
 *   o `npx` é um `.cmd`, que não pode ser iniciado sem shell: vai por `cmd /c`.
 *
 * A pasta do cérebro vai como argumento, e não em `env`, porque assim o formato é o mesmo em todos os clientes.
 */
export async function resolveLaunch(
  io: Pick<CliIo, 'execPath' | 'binPath' | 'platform'>,
  brain: string,
  forceNpx: boolean,
): Promise<Launch> {
  const serverArgs = ['mcp', '--brain', brain];
  const bin = forceNpx ? undefined : await stableBin(io.binPath);
  if (bin !== undefined) return { command: io.execPath, args: [bin, ...serverArgs], via: 'node' };
  const npx = ['npx', '-y', 'cabecao', ...serverArgs];
  if (io.platform === 'win32') return { command: 'cmd', args: ['/c', ...npx], via: 'npx' };
  return { command: 'npx', args: npx.slice(1), via: 'npx' };
}
