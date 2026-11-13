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
import type { ResolvedActor } from './actor.ts';
import { dirContext } from './dirs.ts';
import { embeddingProvider } from './embeddings.ts';
import { CliError } from './errors.ts';
import { systemError } from './syserr.ts';
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
      // o roteador troca a dica de config_schema_too_new pelo comando de atualização desta instalação
      code: error.code,
      ...(error.nextStep === null ? {} : { hint: error.nextStep }),
      ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
      cause: error,
    });
  }
  if (error instanceof VaultError && error.code.startsWith('config_')) {
    return new CliError(error.message, {
      code:
        error.code === 'config_not_found'
          ? 'not_a_brain'
          : error.code === 'config_schema_too_new'
            ? 'config_schema_too_new'
            : 'invalid_config',
      hint:
        error.code === 'config_not_found'
          ? 'Confira o caminho do cérebro ou rode "cabecao init".'
          : error.code === 'config_schema_too_new'
            ? 'Este cérebro é de uma versão mais nova do Cabeção: atualize o Cabeção nesta máquina.'
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
    const cause = error.cause as NodeJS.ErrnoException | undefined;
    if (error.exitCode === null && cause?.code === 'ENOENT' && /PATH/.test(error.message)) {
      return new CliError('o Cabeção precisa do git e não o achou no PATH', {
        code: 'git_missing',
        hint: 'Instale o git: no macOS, "xcode-select --install" (ou "brew install git"); no Linux, pelo gerenciador de pacotes (por exemplo "sudo apt install git"); no Windows, https://git-scm.com. Depois abra um terminal novo e rode o comando de novo.',
        cause: error,
      });
    }
    return new CliError(error.message, {
      code: 'git_failed',
      hint: 'Rode "cabecao doctor" para ver o que há com o repositório.',
      cause: error,
    });
  }
  return systemError(error) ?? error;
}

/** Nome com que o usuário aparece nos commits (`Cabecao-Client: cli`) e na proveniência (`origin: human`). */
export const CLI_CLIENT = 'cli';

/** O que abrir o cérebro precisa saber do processo: o ambiente e QUEM roda (resolvido pelo roteador, `actor.ts`). */
/** O nome que vai para os commits: `cli` para o usuário, o do agente para um agente. */
export const clientOf = (actor: ResolvedActor): string => (actor.actor === 'human' ? CLI_CLIENT : actor.client);

export type BrainIo = Pick<CliIo, 'env' | 'platform' | 'homedir'> & { readonly actor: ResolvedActor };

/**
 * Abre o cérebro de `root` com o ator resolvido: o usuário no terminal (cliente `cli`, ator `human`, com as ações
 * elevadas confirmadas no terminal) ou um agente (o nome dele, ator `agent`: as MESMAS regras do servidor MCP). O nome
 * da máquina vem da configuração do ambiente injetado. Feche com `close()`; prefira `withBrain`.
 */
export async function openCliBrain(io: BrainIo, root: string, extra: Partial<OpenBrainOptions> = {}): Promise<Brain> {
  const machine = (await readMachine(io))?.machine;
  const human = io.actor.actor === 'human';
  try {
    return await openBrain(root, {
      client: clientOf(io.actor),
      actor: human ? 'human' : 'agent',
      confirmElevated: human,
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
  io: BrainIo,
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
