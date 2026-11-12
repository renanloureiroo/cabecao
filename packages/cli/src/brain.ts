import { resolve } from 'node:path';
import { configDir, readMachineConfig } from '@cabecao/core';
import { CliError } from './errors.ts';
import type { CliIo } from './types.ts';

// Este módulo carrega o núcleo: importe-o só de dentro de um comando, nunca do roteador.

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

/**
 * Pasta do cérebro a usar: a pedida com `--brain` ou `CABECAO_BRAIN`; senão, o cérebro padrão gravado na
 * configuração da máquina pelo `init`. Falha com uma mensagem clara quando não há nenhuma.
 */
export async function resolveBrain(
  io: Pick<CliIo, 'env' | 'platform' | 'homedir' | 'cwd'> & { brain: string | undefined },
): Promise<string> {
  if (io.brain !== undefined) return io.brain;
  const config = await readMachineConfig(configDir({ env: io.env, platform: io.platform, homedir: homeDir(io) }));
  if (config?.defaultBrain !== undefined) return resolve(io.cwd, config.defaultBrain);
  throw new CliError('nenhum cérebro configurado nesta máquina', {
    code: 'EBRAIN',
    hint: 'Passe --brain <pasta>, defina CABECAO_BRAIN ou rode "cabecao init".',
  });
}
