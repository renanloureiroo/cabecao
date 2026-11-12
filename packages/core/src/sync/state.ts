// Estado do sync em `.cabecao/sync/`: o resumo do último sync e o diário de intenção da aplicação.
import { readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock, LockTimeoutError, writeFileAtomic } from '../util/index.ts';
import { diffNames, dropStaleGitLock, type GitContext, git, gitText, revParse, treeOf } from './git.ts';
import type { SyncLayout } from './layout.ts';
import type { SyncStatus } from './types.ts';

export interface SyncState {
  lastSync?: { at: string; status: SyncStatus; message: string };
  /** Último commit cujo `index.md` foi conferido: evita recalcular o catálogo num sync em que nada mudou. */
  catalogOk?: string;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function readState(layout: SyncLayout): Promise<SyncState> {
  const raw = await readJson(layout.state);
  if (typeof raw !== 'object' || raw === null) return {};
  const value = raw as Record<string, unknown>;
  const state: SyncState = {};
  const last = value.lastSync as Record<string, unknown> | undefined;
  if (last && typeof last.at === 'string' && typeof last.status === 'string' && typeof last.message === 'string') {
    state.lastSync = { at: last.at, status: last.status as SyncStatus, message: last.message };
  }
  if (typeof value.catalogOk === 'string') state.catalogOk = value.catalogOk;
  return state;
}

export async function writeState(layout: SyncLayout, state: SyncState): Promise<void> {
  await writeFileAtomic(layout.state, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Diário de intenção: gravado antes de a pasta de trabalho começar a mudar (`reset --keep`) e apagado logo depois.
 * Se o processo morrer no meio, o próximo sync sabe de onde para onde a pasta estava indo.
 */
export interface ApplyJournal {
  readonly kind: 'apply';
  readonly branch: string;
  readonly from: string | null;
  readonly to: string;
  readonly pid: number;
  readonly at: number;
}

export async function writeJournal(layout: SyncLayout, journal: ApplyJournal): Promise<void> {
  await writeFileAtomic(layout.journal, `${JSON.stringify(journal)}\n`);
}

export async function clearJournal(layout: SyncLayout): Promise<void> {
  await rm(layout.journal, { force: true });
}

async function readJournal(layout: SyncLayout): Promise<ApplyJournal | null> {
  const raw = await readJson(layout.journal);
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'apply' || typeof value.to !== 'string' || typeof value.branch !== 'string') return null;
  return {
    kind: 'apply',
    branch: value.branch,
    from: typeof value.from === 'string' ? value.from : null,
    to: value.to,
    pid: typeof value.pid === 'number' ? value.pid : 0,
    at: typeof value.at === 'number' ? value.at : 0,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Termina o que uma aplicação interrompida deixou. Quem chama já segura a trava do sync, então o dono do diário
 * morreu ou abortou. Idempotente: rodar de novo depois de uma recuperação também interrompida dá o mesmo resultado.
 *
 * - `HEAD` já está no destino: o `reset` terminou; nada a fazer.
 * - O índice já tem a árvore do destino e só o `HEAD` ficou para trás: avança a branch.
 * - Arquivos já trocados pela versão do destino e o resto não: volta esses arquivos à versão de origem (que está
 *   no `HEAD`), para eles não parecerem edições do usuário. O ciclo normal aplica tudo de novo, de uma vez. Um
 *   arquivo que não bate com nenhuma das duas versões é edição do usuário e não é tocado.
 */
async function recoverApply(ctx: GitContext, journal: ApplyJournal, gitDir: string): Promise<string | null> {
  if (journal.pid !== process.pid && !pidAlive(journal.pid)) {
    // `index.lock` criado depois do diário por um git que morreu junto com o sync
    const lock = join(gitDir, 'index.lock');
    try {
      if ((await stat(lock)).mtimeMs >= journal.at - 1_000) await unlink(lock);
    } catch {
      // não havia
    }
  }
  const head = await revParse(ctx, 'HEAD^{commit}');
  if (head === journal.to) return 'a atualização da pasta de trabalho tinha terminado antes da interrupção';
  if (head !== journal.from) return null;

  const indexTree = await git(ctx, ['write-tree'], { allowFailure: true });
  const target = await treeOf(ctx, journal.to);
  if (indexTree.exitCode === 0 && indexTree.stdout.trim() === target) {
    const zero = '0'.repeat(journal.to.length);
    await git(ctx, ['update-ref', `refs/heads/${journal.branch}`, journal.to, journal.from ?? zero]);
    return 'a branch avançou para o commit que já estava aplicado na pasta de trabalho';
  }
  if (journal.from === null) return null;

  const changed = await diffNames(ctx, journal.from, journal.to);
  const paths = changed.map((entry) => entry.path);
  if (paths.length === 0) return null;
  const present: string[] = [];
  for (const path of paths) {
    try {
      if ((await stat(join(ctx.root, ...path.split('/')))).isFile()) present.push(path);
    } catch {
      // ausente
    }
  }
  const hashes = new Map<string, string>();
  if (present.length > 0) {
    const out = await gitText(ctx, ['hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n` });
    out.split('\n').forEach((oid, i) => {
      const path = present[i];
      if (path !== undefined) hashes.set(path, oid);
    });
  }
  const restore: string[] = [];
  const remove: string[] = [];
  for (const path of paths) {
    const [fromOid, toOid] = await Promise.all([
      revParse(ctx, `${journal.from}:${path}`),
      revParse(ctx, `${journal.to}:${path}`),
    ]);
    const disk = hashes.get(path) ?? null;
    if (disk === fromOid || disk !== toOid) continue; // intocado, ou edição do usuário
    if (fromOid === null) remove.push(path);
    else restore.push(path);
  }
  for (const path of remove) await rm(join(ctx.root, ...path.split('/')), { force: true });
  if (restore.length > 0) {
    await git(ctx, ['--literal-pathspecs', 'checkout', journal.from, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: restore.join('\0'),
    });
  }
  const n = restore.length + remove.length;
  return n === 0 ? null : `${n} arquivo(s) de uma atualização interrompida voltaram à versão anterior`;
}

/** Recupera o que uma execução interrompida deixou. Devolve o que foi feito, para o resultado. */
export async function recover(ctx: GitContext, layout: SyncLayout, gitDir: string): Promise<string[]> {
  const notes: string[] = [];
  // `index.lock` de um git que morreu há mais tempo que o limite
  await dropStaleGitLock(ctx, join(gitDir, 'index.lock'));
  // trava da pasta de trabalho de um processo morto: tomá-la e soltá-la limpa o arquivo
  try {
    await (await acquireLock(layout.worktreeLock, { timeoutMs: 100 })).release();
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error;
  }
  // índices descartáveis de merge em memória: só o sync os usa, e quem chama segura a trava do sync
  try {
    for (const name of await readdir(layout.dir)) {
      if (name.startsWith('index-')) await rm(join(layout.dir, name), { force: true });
    }
  } catch {
    // a pasta ainda não existe
  }
  const journal = await readJournal(layout);
  if (journal !== null) {
    const done = await recoverApply(ctx, journal, gitDir);
    if (done !== null) notes.push(done);
    await clearJournal(layout);
  }
  return notes;
}
