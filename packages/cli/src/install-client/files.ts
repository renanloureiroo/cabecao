import { constants } from 'node:fs';
import { access, copyFile, readFile, stat } from 'node:fs/promises';
import { FileChangedError, fileStamp, writeFileAtomic } from '@cabecao/core';
import { CliError } from '../errors.ts';
import type { Env } from '../types.ts';

export interface FileChange {
  status: 'created' | 'updated' | 'unchanged';
  /** Caminho da cópia de segurança criada nesta execução. */
  backup?: string;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * O arquivo existe e está marcado como somente leitura (sem permissão de escrita para ninguém, ou sem permissão
 * para este usuário). A gravação atômica troca o arquivo inteiro por um novo e passaria por cima da proteção: quem
 * marcou o arquivo assim não quer que ele seja alterado.
 */
async function isReadOnly(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o222) === 0) return true;
    await access(path, constants.W_OK);
    return false;
  } catch (error) {
    return isErrno(error, 'EACCES') || isErrno(error, 'EPERM');
  }
}

/**
 * Lê o arquivo, aplica `edit` e grava o resultado de forma atômica. `edit` recebe `undefined` quando o arquivo
 * não existe e devolve o texto novo, ou `undefined` para não mexer. Um erro lançado por `edit` sobe sem que
 * nada tenha sido gravado.
 *
 * Na primeira alteração de um arquivo que já existia, o original é copiado para `<arquivo>.bak`; se a cópia já
 * existe, ela é mantida: guarda o estado de antes do cabecao, não o da última execução.
 *
 * Um arquivo somente leitura não é alterado: a edição falha com um erro claro e nada é gravado.
 */
export async function editFile(
  path: string,
  edit: (current: string | undefined) => string | undefined,
): Promise<FileChange> {
  const stamp = await fileStamp(path);
  const current = stamp === null ? undefined : await readFile(path, 'utf8');
  const next = edit(current);
  if (next === undefined || next === current) return { status: 'unchanged' };
  if (current !== undefined && (await isReadOnly(path))) {
    throw new CliError(`${path} está marcado como somente leitura; nada foi gravado.`, {
      code: 'ECLIENTCONFIG',
      hint: 'Libere a escrita no arquivo (por exemplo, "chmod u+w" no macOS e no Linux) e rode de novo, ou use --print e cole a configuração à mão.',
    });
  }

  let backup: string | undefined;
  if (current !== undefined) {
    const candidate = `${path}.bak`;
    try {
      await copyFile(path, candidate, constants.COPYFILE_EXCL);
      backup = candidate;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
  }

  try {
    // 0o600 num arquivo novo: esses arquivos costumam guardar chaves de outros servidores.
    await writeFileAtomic(path, next, { ifUnchangedSince: stamp, mode: 0o600 });
  } catch (error) {
    if (error instanceof FileChangedError) {
      throw new CliError(`${path} mudou enquanto era lido; nada foi gravado. Rode de novo.`, { cause: error });
    }
    throw error;
  }
  return { status: current === undefined ? 'created' : 'updated', ...(backup === undefined ? {} : { backup }) };
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Procura um executável no `PATH` do ambiente injetado, sem rodar nada. No Windows tenta as extensões de
 * `PATHEXT`. Devolve o caminho completo, ou `undefined`.
 */
export async function findExecutable(
  name: string,
  io: { env: Env; platform: NodeJS.Platform },
): Promise<string | undefined> {
  const windows = io.platform === 'win32';
  const dirs = (io.env.PATH ?? io.env.Path ?? '').split(windows ? ';' : ':').filter((dir) => dir !== '');
  const extensions = windows ? (io.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '') : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = `${dir}${windows ? '\\' : '/'}${name}${extension}`;
      try {
        const info = await stat(candidate);
        if (info.isFile() && (windows || (info.mode & 0o111) !== 0)) return candidate;
      } catch {
        // não está nesta pasta
      }
    }
  }
  return undefined;
}
