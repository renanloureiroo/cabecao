// Onde o sync guarda o que é dele e quais arquivos do cérebro ele põe em commit.
import { join } from 'node:path';
import { ATOMIC_TMP_PREFIX, ATOMIC_TMP_SUFFIX } from '../util/index.ts';

export { conflictCopyPath, isConflictCopyPath, parseConflictCopyPath } from './conflict-name.ts';

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

/** Pasta local do Cabeção (banco, travas, estado do sync). Nunca vai para o git, em nenhum nível. */
const LOCAL_DIR = '.cabecao';

export function syncLayout(root: string): SyncLayout {
  const cabecao = join(root, LOCAL_DIR);
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

const ATOMIC_TMP = new RegExp(
  `^${ATOMIC_TMP_PREFIX.replace('.', '\\.')}(\\d+)-[0-9a-f]+${ATOMIC_TMP_SUFFIX.replace('.', '\\.')}$`,
);

/** PID do dono de um temporário da escrita atômica (`.cabecao-<pid>-<hex>.tmp`), ou `null` se não for um. */
export function atomicTempOwner(path: string): number | null {
  const match = ATOMIC_TMP.exec(path.slice(path.lastIndexOf('/') + 1));
  return match ? Number(match[1]) : null;
}

/**
 * Diz se uma mudança na pasta de trabalho entra no commit de edições feitas fora do Cabeção e no envio.
 *
 * Tudo sincroniza (decisão do dono do projeto): notas, anexos, `dashboards/`, `CLAUDE.md`, `AGENTS.md`,
 * `.gitignore`, `.gitattributes`, `.cabecao.json`, pastas novas e pastas ocultas como `.obsidian/`. Ficam de fora
 * só:
 *
 * - o que o `.gitignore` (ou `.git/info/exclude`, ou o `core.excludesFile`) exclui: quem lista as mudanças é o
 *   próprio git (`git status`), então essas regras nunca são reimplementadas aqui;
 * - `.git/` e `.cabecao/` (em qualquer nível), mesmo que o `.gitignore` do usuário não cite `.cabecao/`;
 * - os temporários da escrita atômica (`.cabecao-<pid>-<hex>.tmp`).
 */
export function isSyncablePath(path: string): boolean {
  if (path === '' || path.endsWith('/')) return false; // pasta (repositório embutido): não é arquivo do cérebro
  const segments = path.split('/');
  const dirs = segments.slice(0, -1);
  if (dirs.includes('.git') || dirs.includes(LOCAL_DIR)) return false;
  if (segments.at(-1) === '.git') return false;
  return atomicTempOwner(path) === null;
}
