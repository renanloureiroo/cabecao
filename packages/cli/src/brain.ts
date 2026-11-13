import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Brain, MachineConfig, OpenBrainOptions } from '@cabecao/core';
import {
  BRAIN_CONFIG_FILE,
  BrainError,
  ConfigError,
  configDir,
  GitError,
  GitIdentityError,
  GitVersionError,
  INVALID_CONFIG_HINT,
  installSqliteWarningFilter,
  LockTimeoutError,
  openBrain,
  readMachineConfig,
  VaultError,
} from '@cabecao/core';
import { dirContext } from './dirs.ts';
import { embeddingProvider } from './embeddings.ts';
import { CliError } from './errors.ts';
import type { CliIo } from './types.ts';

// Este módulo carrega o núcleo: importe-o só de dentro de um comando, nunca do roteador.
//
// O filtro do aviso experimental do `node:sqlite` é instalado AQUI, e só aqui: todo comando passa por este módulo
// (para achar o cérebro ou a pasta do usuário) antes de tocar no banco, e um módulo ES termina de ser avaliado antes
// de quem o importa continuar. Assim nenhum comando mostra "ExperimentalWarning: SQLite is an experimental feature".
installSqliteWarningFilter();

export { dirContext, homeDir } from './dirs.ts';

/** Pasta da configuração da máquina, a partir do ambiente injetado (respeita `CABECAO_CONFIG_DIR`). */
export function machineConfigDir(io: Pick<CliIo, 'env' | 'platform' | 'homedir'>): string {
  return configDir(dirContext(io));
}

/** Configuração da máquina (nome, cérebro padrão), ou `null` se o `init` ainda não rodou aqui. */
export async function readMachine(io: Pick<CliIo, 'env' | 'platform' | 'homedir'>): Promise<MachineConfig | null> {
  try {
    return await readMachineConfig(machineConfigDir(io));
  } catch (error) {
    throw toCliError(error);
  }
}

async function isBrainDir(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, BRAIN_CONFIG_FILE))).isFile();
  } catch {
    return false;
  }
}

/**
 * Pasta do cérebro a usar, nesta ordem: a pedida com `--brain` ou `CABECAO_BRAIN`; o cérebro padrão gravado na
 * configuração da máquina pelo `init`; a pasta atual, se ela for um cérebro (tem `.cabecao.json`). Falha com uma
 * mensagem clara quando não há nenhuma.
 */
export async function resolveBrain(
  io: Pick<CliIo, 'env' | 'platform' | 'homedir' | 'cwd'> & { brain: string | undefined },
): Promise<string> {
  if (io.brain !== undefined) return io.brain;
  const config = await readMachine(io);
  if (config?.defaultBrain !== undefined) return resolve(io.cwd, config.defaultBrain);
  if (await isBrainDir(io.cwd)) return io.cwd;
  throw new CliError('nenhum cérebro configurado nesta máquina', {
    code: 'EBRAIN',
    hint: 'Passe --brain <pasta>, defina CABECAO_BRAIN, entre na pasta de um cérebro ou rode "cabecao init".',
  });
}

/**
 * Converte um erro do núcleo numa mensagem pronta para o terminal, com o que fazer. O `code` dos erros da camada de
 * operações (`not_a_brain`, `nothing_to_undo`...) é o mesmo que o servidor MCP devolve. O que não é reconhecido volta
 * como está (o roteador mostra como erro inesperado).
 */
export function toCliError(error: unknown): unknown {
  if (error instanceof CliError) return error;
  if (error instanceof BrainError) {
    return new CliError(error.message, {
      code: error.code,
      ...(error.nextStep === null ? {} : { hint: error.nextStep }),
      cause: error,
    });
  }
  if (error instanceof VaultError && error.code.startsWith('config_')) {
    return new CliError(error.message, {
      code: error.code === 'config_not_found' ? 'not_a_brain' : 'invalid_config',
      hint:
        error.code === 'config_not_found'
          ? 'Confira o caminho do cérebro ou rode "cabecao init".'
          : error.code === 'config_schema_too_new'
            ? 'Este cérebro é de uma versão mais nova do Cabeção: atualize com "npx cabecao@latest".'
            : INVALID_CONFIG_HINT,
      cause: error,
    });
  }
  if (error instanceof ConfigError) return new CliError(error.message, { code: error.code, cause: error });
  if (error instanceof GitVersionError) {
    return new CliError(error.message, {
      code: 'EGITVERSION',
      hint: 'Baixe o git em https://git-scm.com',
      cause: error,
    });
  }
  if (error instanceof GitIdentityError) return new CliError(error.message, { code: error.code, cause: error });
  if (error instanceof LockTimeoutError) {
    return new CliError(`o cérebro está ocupado por outro processo (${error.message})`, {
      code: 'locked',
      hint: 'Tente de novo em alguns segundos.',
      cause: error,
    });
  }
  if (error instanceof GitError) {
    return new CliError(error.message, {
      code: 'git_failed',
      hint: 'Rode "cabecao doctor" para ver o que há com o repositório.',
      cause: error,
    });
  }
  return error;
}

/** Nome com que a CLI aparece nos commits (`Cabecao-Client: cli`) e na proveniência (`origin: human`). */
export const CLI_CLIENT = 'cli';

/**
 * Abre o cérebro de `root` como o usuário (cliente `cli`, ator `human`), com o nome da máquina tirado da configuração
 * do ambiente injetado. Feche com `close()`; prefira `withBrain`.
 */
export async function openCliBrain(
  io: Pick<CliIo, 'env' | 'platform' | 'homedir'>,
  root: string,
  extra: Partial<OpenBrainOptions> = {},
): Promise<Brain> {
  const machine = (await readMachine(io))?.machine;
  try {
    return await openBrain(root, {
      client: CLI_CLIENT,
      actor: 'human',
      // o runtime de embeddings é injetado sempre: criar o provedor não carrega nada (o modelo só carrega na busca ou
      // no cálculo que precisar dele)
      embeddings: embeddingProvider(io),
      ...(machine === undefined ? {} : { machine }),
      ...extra,
    });
  } catch (error) {
    throw toCliError(error);
  }
}

/** Abre o cérebro de `root`, roda `fn` e fecha (no Windows o banco aberto impede apagar a pasta). */
export async function withBrain<T>(
  io: Pick<CliIo, 'env' | 'platform' | 'homedir'>,
  root: string,
  fn: (brain: Brain) => Promise<T>,
  extra: Partial<OpenBrainOptions> = {},
): Promise<T> {
  const brain = await openCliBrain(io, root, extra);
  try {
    return await fn(brain);
  } catch (error) {
    throw toCliError(error);
  } finally {
    await brain.close();
  }
}
