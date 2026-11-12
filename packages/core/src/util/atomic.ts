import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isErrno, isWindowsTransient } from './errors.ts';

/** Data de modificação e tamanho: a mesma "impressão" que a varredura incremental usa para detectar mudança. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface WriteFileAtomicOptions {
  /**
   * Impressão do arquivo quando o chamador o leu. Se o arquivo no disco não bater mais com ela (foi editado,
   * apagado ou trocado), a escrita é recusada com `FileChangedError`. Passe `null` para exigir que o arquivo
   * ainda NÃO exista.
   */
  ifUnchangedSince?: FileStamp | null;
  /** Modo de um arquivo NOVO (sujeito ao umask). Um arquivo que já existe mantém o modo que tinha. */
  mode?: number;
}

/** O arquivo mudou desde a leitura informada em `ifUnchangedSince`; nada foi gravado. */
export class FileChangedError extends Error {
  readonly code = 'ECHANGED';
  readonly path: string;
  readonly expected: FileStamp | null;
  readonly actual: FileStamp | null;

  constructor(path: string, expected: FileStamp | null, actual: FileStamp | null) {
    super(`o arquivo mudou desde a leitura e não foi sobrescrito: ${path}`);
    this.name = 'FileChangedError';
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Prefixo e sufixo dos temporários, para quem precisar ignorá-los (git, varredura). */
export const ATOMIC_TMP_PREFIX = '.cabecao-';
export const ATOMIC_TMP_SUFFIX = '.tmp';

/** Impressão atual do arquivo, ou `null` se ele não existe. */
export async function fileStamp(path: string): Promise<FileStamp | null> {
  try {
    const st = await stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
    throw error;
  }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export interface RenameRetryOptions {
  platform?: NodeJS.Platform;
  /** Esperas entre tentativas, em ms. O número de novas tentativas é o tamanho da lista. */
  delaysMs?: readonly number[];
  rename?: (from: string, to: string) => Promise<void>;
}

/** Cerca de 2 s no total: o bastante para antivírus/indexador soltarem o arquivo, curto para não parecer travado. */
const RENAME_DELAYS_MS = [5, 10, 20, 40, 80, 120, 160, 200, 200, 200, 200, 200, 200, 200, 200] as const;

/**
 * `rename` que, no Windows, tenta de novo quando o destino está momentaneamente aberto por outro processo
 * (`EPERM`, `EBUSY`, `EACCES`). Nos outros sistemas esses erros são definitivos e sobem na hora.
 */
export async function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const delays = options.delaysMs ?? RENAME_DELAYS_MS;
  const doRename = options.rename ?? rename;
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isWindowsTransient(error, platform)) throw error;
      await sleep(delay);
    }
  }
}

/** Segue link simbólico para gravar no alvo em vez de trocar o link por um arquivo comum. */
async function resolveTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return path;
    throw error;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // Torna o rename durável em queda de energia. No Windows não dá para abrir pasta; em alguns sistemas de arquivos
  // o fsync de pasta não existe. É reforço, não requisito: falha aqui não invalida a escrita.
  if (process.platform === 'win32') return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // reforço opcional
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Grava `data` em `path` de forma atômica: escreve num temporário na mesma pasta, faz `fsync` e renomeia por cima.
 * Quem lê vê o arquivo antigo inteiro ou o novo inteiro, nunca metade. Cria a pasta se faltar, preserva o modo do
 * arquivo existente e nunca deixa o temporário para trás.
 *
 * Com `ifUnchangedSince`, a conferência é feita imediatamente antes do rename. Sobra uma janela de microssegundos
 * entre conferir e renomear; quem precisar de garantia total contra outro escritor do Cabeção usa `withLock`.
 *
 * Devolve a impressão do arquivo gravado, pronta para ser usada na próxima escrita condicional.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<FileStamp> {
  const target = await resolveTarget(path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });

  let existingMode: number | undefined;
  try {
    const st = await stat(target);
    if (st.isDirectory()) {
      throw Object.assign(new Error(`o destino é uma pasta, não um arquivo: ${target}`), { code: 'EISDIR' });
    }
    existingMode = st.mode & 0o7777;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }

  const tmp = join(dir, `${ATOMIC_TMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}${ATOMIC_TMP_SUFFIX}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(tmp, 'wx', options.mode ?? 0o666);
    await handle.writeFile(data);
    if (existingMode !== undefined && process.platform !== 'win32') await handle.chmod(existingMode);
    await handle.sync();
    const written = await handle.stat();
    await handle.close();
    handle = undefined;

    if (options.ifUnchangedSince !== undefined) {
      const actual = await fileStamp(target);
      if (!sameStamp(options.ifUnchangedSince, actual)) {
        throw new FileChangedError(path, options.ifUnchangedSince, actual);
      }
    }

    await renameWithRetry(tmp, target);
    await syncDirectory(dir);
    return { mtimeMs: written.mtimeMs, size: written.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
