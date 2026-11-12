// Nome das cópias de conflito (`nota.conflict-<máquina>-<data>.md`). Módulo sem dependências do resto do sync, para
// o banco local (`db/`) reconhecer as cópias sem importar o sync inteiro.
import { formatDate } from '../git/index.ts';

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

/** O caminho é uma cópia de conflito criada pelo sync. */
export function isConflictCopyPath(path: string): boolean {
  return parseConflictCopyPath(path) !== null;
}
