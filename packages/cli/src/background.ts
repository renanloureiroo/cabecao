// Sync em segundo plano e o log do sync em `<cérebro>/.cabecao/logs/sync.log`.
//
// O hook de fim de sessão do Claude Code tem só 1,5 s quando vem de um plugin (doc 07), e um sync com `git push` não
// cabe nisso. Por isso `cabecao sync --detach` (e `--hook`) só dispara um `cabecao sync --log` num processo
// DESTACADO e volta: o filho fica num grupo de processos próprio (`detached`), sem stdin nem stdout ligados ao pai, com
// o stderr no log e `unref()`, e assim sobrevive ao fim do pai e do Claude Code. No Windows, sem abrir janela.
// Dois syncs ao mesmo tempo não acontecem: a trava do sync no núcleo faz o segundo sair como "outro sync em andamento".
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { appendFile, mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_DIR } from '@cabecao/core';
import { CliError } from './errors.ts';
import type { CliIo } from './types.ts';

/** Pasta dos logs do Cabeção dentro do cérebro (`.cabecao/` fica fora do git). */
export function logDir(root: string): string {
  return join(root, LOCAL_DIR, 'logs');
}

export function syncLogPath(root: string): string {
  return join(logDir(root), 'sync.log');
}

/** Acima disto o log vira `sync.log.1` (só a geração anterior é guardada). */
export const SYNC_LOG_MAX_BYTES = 1024 * 1024;

/** Cria a pasta e gira o log, se estiver grande. Devolve o caminho do log. */
export async function prepareSyncLog(root: string, maxBytes = SYNC_LOG_MAX_BYTES): Promise<string> {
  const path = syncLogPath(root);
  await mkdir(logDir(root), { recursive: true });
  try {
    if ((await stat(path)).size > maxBytes) await rename(path, `${path}.1`);
  } catch {
    // não existe ainda (ou outro processo girou primeiro)
  }
  return path;
}

/** Acrescenta um bloco ao log do sync. */
export async function appendSyncLog(root: string, text: string): Promise<string> {
  const path = await prepareSyncLog(root);
  await appendFile(path, text.endsWith('\n') ? text : `${text}\n`);
  return path;
}

/** Cabeçalho de um bloco do log: `--- 2026-11-13T10:00:00.000Z → ...Z · sync · código 0 ---`. */
export function logBlock(startedAt: Date, finishedAt: Date, code: number, text: string): string {
  return `--- ${startedAt.toISOString()} → ${finishedAt.toISOString()} · sync · código ${code} ---\n${text.trimEnd()}\n`;
}

export interface DetachedCommand {
  file: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * Como o filho destacado é iniciado: `<node> <bin do cabecao> sync --log --brain <cérebro>`, sem shell, com a lista de
 * argumentos. `stderrFd` é o log aberto para acrescentar (um erro que derrube o filho antes de ele escrever no log
 * ainda fica registrado ali).
 */
export function detachedSyncCommand(
  io: Pick<CliIo, 'execPath' | 'binPath' | 'env'>,
  root: string,
  stderrFd: number,
): DetachedCommand {
  const bin = io.binPath;
  if (bin === undefined || bin === '') {
    throw new CliError('não sei onde está o programa cabecao para rodar o sync em segundo plano', {
      code: 'no_bin',
      hint: 'Rode o sync em primeiro plano: "cabecao sync".',
    });
  }
  return {
    file: io.execPath,
    args: [bin, 'sync', '--log', '--brain', root],
    options: {
      cwd: root,
      env: { ...io.env },
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      windowsHide: true,
    },
  };
}

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

async function defaultSpawn(): Promise<SpawnFn> {
  const { spawn } = await import('node:child_process');
  return (file, args, options) => spawn(file, [...args], options);
}

export interface DetachedSync {
  /** PID do processo do sync. */
  pid: number;
  log: string;
}

/**
 * Dispara o sync destacado e volta assim que o processo existe (milissegundos). `note` vai para o cabeçalho que este
 * processo grava no log antes de iniciar o filho (de onde veio o disparo).
 */
export async function startDetachedSync(
  io: Pick<CliIo, 'execPath' | 'binPath' | 'env'>,
  root: string,
  note: string,
  spawnFn?: SpawnFn,
): Promise<DetachedSync> {
  const log = await prepareSyncLog(root);
  await appendFile(log, `=== ${new Date().toISOString()} · sync em segundo plano (${note}) ===\n`);
  const handle = await open(log, 'a');
  try {
    const command = detachedSyncCommand(io, root, handle.fd);
    const child = (spawnFn ?? (await defaultSpawn()))(command.file, command.args, command.options);
    // `spawn` avisa da falha (programa inexistente, por exemplo) por evento: espera um dos dois antes de voltar
    const failure = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (error) => resolve(error));
    });
    if (failure !== null || child.pid === undefined) {
      const message = failure?.message ?? 'o processo não iniciou';
      throw new CliError(`não consegui iniciar o sync em segundo plano: ${message}`, { code: 'spawn_failed' });
    }
    child.unref();
    return { pid: child.pid, log };
  } finally {
    await handle.close();
  }
}
