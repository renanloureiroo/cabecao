// Listagem das notas: só `readdir` e `stat`, sem ler conteúdo. É a base da varredura incremental (decisão 20).
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ATOMIC_TMP_PREFIX, ATOMIC_TMP_SUFFIX, normalizeNfc } from '../util/index.ts';
import type { BrainConfig } from './config.ts';
import { LOG_MD } from './config.ts';
import { isPrivateTarget } from './paths.ts';
import { isArchivedPath } from './schema.ts';

export interface NoteFile {
  /** Caminho relativo ao cérebro, com `/` e em NFC. É a chave da nota em todo o resto do sistema. */
  readonly path: string;
  /**
   * O mesmo caminho como está gravado no disco. Só difere de `path` quando o nome foi criado em NFD (macOS antigo,
   * cópia de outra máquina); no Linux, é este que abre o arquivo.
   */
  readonly diskPath: string;
  readonly mtimeMs: number;
  readonly size: number;
  /** Está em `memory/_archive/`. */
  readonly archived: boolean;
}

/** Quantos `stat`/`readdir` ficam pendentes ao mesmo tempo. */
const CONCURRENCY = 64;

function isInside(realRoot: string, target: string): boolean {
  const rel = relative(realRoot, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Executa `worker` sobre a fila com paralelismo limitado; o `worker` pode enfileirar mais itens. */
async function drain<T>(queue: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let active = 0;
  let failure: unknown;
  let failed = false;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (!failed && active < CONCURRENCY && queue.length > 0) {
        const item = queue.pop() as T;
        active++;
        worker(item).then(
          () => {
            active--;
            pump();
          },
          (error: unknown) => {
            active--;
            if (!failed) {
              failed = true;
              failure = error;
            }
            pump();
          },
        );
      }
      if (active === 0 && (failed || queue.length === 0)) resolve();
    };
    pump();
  });
  if (failed) throw failure;
}

const gone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/**
 * Lista os arquivos `.md` dentro das `noteDirs`, ordenados por `path` (ordem de código, igual em qualquer máquina).
 *
 * Ignora pastas e arquivos ocultos (`.git/`, `.cabecao/`, `.obsidian/`, `.trash/`...), os temporários da escrita
 * atômica, o que não for `.md`, e também o catálogo (`indexMd`) e o diário (`log.md`), que não são notas. Uma pasta
 * de `noteDirs` que não existe é ignorada. Arquivos que somem no meio da varredura (edição no Obsidian) são pulados.
 *
 * Links simbólicos: só são seguidos quando o alvo real fica dentro do cérebro e fora de `.git/` e `.cabecao/`. Dentro de uma pasta alcançada por
 * link, outros links para pastas não são seguidos; isso corta qualquer ciclo sem depender da ordem da varredura.
 */
export async function listNoteFiles(
  root: string,
  config: Pick<BrainConfig, 'noteDirs' | 'indexMd'>,
): Promise<NoteFile[]> {
  const found = new Map<string, NoteFile>();
  const excluded = new Set([normalizeNfc(config.indexMd).toLowerCase(), LOG_MD]);
  let realRoot: Promise<string> | null = null;
  const getRealRoot = (): Promise<string> => {
    realRoot ??= realpath(root);
    return realRoot;
  };

  interface Task {
    /** Caminho relativo como no disco, com `/`; vazio para a raiz. */
    readonly rel: string;
    /** `root`: pasta de `noteDirs`, que pode ela mesma ser um link simbólico. */
    readonly kind: 'root' | 'dir' | 'file' | 'link';
    /** A pasta foi alcançada por um link simbólico. */
    readonly linked: boolean;
  }
  // uma pasta de notas dentro de outra já é coberta pela de fora
  const dirs = config.noteDirs.filter(
    (dir, i) =>
      config.noteDirs.indexOf(dir) === i &&
      !config.noteDirs.some((outer) => outer !== dir && (outer === '.' || dir.startsWith(`${outer}/`))),
  );
  const queue: Task[] = dirs.map((dir) => ({
    rel: dir === '.' ? '' : dir,
    kind: dir === '.' ? 'dir' : 'root',
    linked: false,
  }));

  const absolute = (rel: string): string => (rel === '' ? root : join(root, ...rel.split('/')));

  const addFile = (rel: string, mtimeMs: number, size: number): void => {
    const path = normalizeNfc(rel);
    if (excluded.has(path.toLowerCase())) return;
    if (!found.has(path)) found.set(path, { path, diskPath: rel, mtimeMs, size, archived: isArchivedPath(path) });
  };

  const isNoteName = (name: string): boolean =>
    name.length > 3 &&
    name.charCodeAt(0) !== 46 /* . */ &&
    name.slice(-3).toLowerCase() === '.md' &&
    !(name.startsWith(ATOMIC_TMP_PREFIX) && name.endsWith(ATOMIC_TMP_SUFFIX));

  const readDir = async (rel: string, linked: boolean): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(absolute(rel), { withFileTypes: true });
    } catch (error) {
      if (gone(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.charCodeAt(0) === 46 /* . */) continue;
      const child = rel === '' ? name : `${rel}/${name}`;
      if (entry.isDirectory()) queue.push({ rel: child, kind: 'dir', linked });
      else if (entry.isSymbolicLink()) queue.push({ rel: child, kind: 'link', linked });
      else if (entry.isFile() && isNoteName(name)) queue.push({ rel: child, kind: 'file', linked });
    }
  };

  await drain(queue, async (task) => {
    if (task.kind === 'dir') {
      await readDir(task.rel, task.linked);
      return;
    }
    try {
      if (task.kind === 'root') {
        // `wiki` (ou uma pasta acima dela) pode ser um link para fora do cérebro: só é percorrida se o alvo real
        // ficar dentro
        const linked = (await lstat(absolute(task.rel))).isSymbolicLink();
        const real = await realpath(absolute(task.rel));
        if (!isInside(await getRealRoot(), real) || isPrivateTarget(await getRealRoot(), real)) return;
        if ((await stat(real)).isDirectory()) await readDir(task.rel, linked);
        return;
      }
      if (task.kind === 'file') {
        const st = await stat(absolute(task.rel));
        addFile(task.rel, st.mtimeMs, st.size);
        return;
      }
      const real = await realpath(absolute(task.rel));
      // um link para dentro de `.git/` ou `.cabecao/` não é nota, nem para ler
      if (!isInside(await getRealRoot(), real) || isPrivateTarget(await getRealRoot(), real)) return;
      const st = await stat(real);
      if (st.isDirectory()) {
        if (!task.linked) await readDir(task.rel, true);
      } else if (st.isFile() && isNoteName(task.rel.slice(task.rel.lastIndexOf('/') + 1))) {
        addFile(task.rel, st.mtimeMs, st.size);
      }
    } catch (error) {
      // link quebrado ou em laço, arquivo apagado no meio da varredura
      if (gone(error) || (error as NodeJS.ErrnoException).code === 'ELOOP') return;
      throw error;
    }
  });

  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
