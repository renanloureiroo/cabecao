// Onde o sync guarda o que é dele e quais arquivos do cérebro ele põe em commit.
import { join } from 'node:path';
import { formatDate } from '../git/index.ts';
import { ATOMIC_TMP_PREFIX, ATOMIC_TMP_SUFFIX } from '../util/index.ts';
import type { BrainConfig } from '../vault/index.ts';
import { BRAIN_CONFIG_FILE, isInNoteDirs, LOG_MD } from '../vault/index.ts';

export interface SyncLayout {
  /** Trava de um sync por vez (pode durar segundos). */
  readonly syncLock: string;
  /**
   * Trava curta em volta do que mexe na pasta de trabalho e no `HEAD` (commit das edições, `reset --keep`). Quem
   * mais fizer commit no cérebro (as operações de escrita) deve segurá-la também, para o `reset` nunca correr
   * contra um commit novo.
   */
  readonly worktreeLock: string;
  /** Pasta de estado do sync. */
  readonly dir: string;
  /** Diário de intenção: existe só enquanto a pasta de trabalho está sendo atualizada. */
  readonly journal: string;
  readonly state: string;
  /** Tipo e validade das notas por blob, para regenerar o `index.md` sem reler o cérebro inteiro. */
  readonly catalogCache: string;
}

export function syncLayout(root: string): SyncLayout {
  const cabecao = join(root, '.cabecao');
  const dir = join(cabecao, 'sync');
  return {
    syncLock: join(cabecao, 'locks', 'sync.lock'),
    worktreeLock: join(cabecao, 'locks', 'worktree.lock'),
    dir,
    journal: join(dir, 'journal.json'),
    state: join(dir, 'state.json'),
    catalogCache: join(dir, 'catalog-cache.json'),
  };
}

/** Arquivos da raiz que pertencem ao cérebro mesmo fora das `noteDirs`. */
const ROOT_FILES = new Set([LOG_MD, 'AGENTS.md', BRAIN_CONFIG_FILE, '.gitattributes', '.gitignore']);

const ATOMIC_TMP = new RegExp(
  `^${ATOMIC_TMP_PREFIX.replace('.', '\\.')}(\\d+)-[0-9a-f]+${ATOMIC_TMP_SUFFIX.replace('.', '\\.')}$`,
);

/** PID do dono de um temporário da escrita atômica (`.cabecao-<pid>-<hex>.tmp`), ou `null` se não for um. */
export function atomicTempOwner(path: string): number | null {
  const match = ATOMIC_TMP.exec(path.slice(path.lastIndexOf('/') + 1));
  return match ? Number(match[1]) : null;
}

/**
 * Diz se uma mudança na pasta de trabalho entra no commit de edições feitas fora do Cabeção: arquivos dentro das
 * `noteDirs` (notas e anexos) e os arquivos do cérebro na raiz (`log.md`, catálogo, `AGENTS.md`, configuração).
 * Nunca entram pastas e arquivos ocultos (`.obsidian/`, `.cabecao/`, `.trash/`) nem temporários da escrita
 * atômica. O `.gitignore` já foi respeitado por quem listou as mudanças (`git status`).
 */
export function isSyncablePath(path: string, config: Pick<BrainConfig, 'noteDirs' | 'indexMd'>): boolean {
  if (path === config.indexMd || ROOT_FILES.has(path)) return true;
  if (path.split('/').some((segment) => segment.startsWith('.'))) return false;
  return isInNoteDirs(path, config);
}

/** Nome da cópia de conflito: `wiki/nota.md` → `wiki/nota.conflict-<máquina>-<AAAAMMDD-HHmmss>[-n].md`. */
export function conflictCopyPath(path: string, machine: string, date: Date, n = 1): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const cut = dot > slash + 1 ? dot : path.length;
  const suffix = n > 1 ? `-${n}` : '';
  return `${path.slice(0, cut)}.conflict-${machine}-${formatDate(date, 'YYYYMMDD-HHmmss')}${suffix}${path.slice(cut)}`;
}

const CONFLICT_COPY = /^(.*)\.conflict-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-(\d{8})-(\d{6})(?:-\d+)?(\.[^./]+)?$/;

/** Lê o nome de uma cópia de conflito; `null` se o caminho não for uma. */
export function parseConflictCopyPath(path: string): { original: string; machine: string; date: string } | null {
  const match = CONFLICT_COPY.exec(path);
  if (!match) return null;
  const [, stem = '', machine = '', day = '', time = '', ext = ''] = match;
  if (stem === '' || stem.endsWith('/')) return null;
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}`;
  return { original: `${stem}${ext}`, machine, date };
}
