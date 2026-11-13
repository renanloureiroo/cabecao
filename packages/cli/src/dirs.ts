import type { DirContext } from '@cabecao/core';
import { CliError } from './errors.ts';
import type { CliIo } from './types.ts';

/** Pasta do usuário: `HOME` (ou `USERPROFILE` no Windows) do ambiente injetado; depois, a do sistema. */
export function homeDir(io: Pick<CliIo, 'env' | 'platform' | 'homedir'>): string {
  const names = io.platform === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME', 'USERPROFILE'];
  for (const name of names) {
    const value = io.env[name];
    if (value !== undefined && value !== '') return value;
  }
  if (io.homedir !== undefined && io.homedir !== '') return io.homedir;
  throw new CliError('não encontrei a pasta do usuário: defina a variável HOME', { code: 'EHOME' });
}

/** Ambiente, sistema e pasta do usuário injetados, no formato que o núcleo usa para achar as pastas. */
export function dirContext(io: Pick<CliIo, 'env' | 'platform' | 'homedir'>): DirContext {
  return { env: io.env, platform: io.platform, homedir: homeDir(io) };
}
