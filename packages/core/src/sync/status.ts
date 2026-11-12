// Leitura do estado do sync para `status` e `doctor`. Nada aqui fala com o remoto nem muda o cérebro.
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranch, statusPorcelain } from '../git/index.ts';
import { readBrainConfig } from '../vault/index.ts';
import { countCommits, type GitContext, git, revParse } from './git.ts';
import { isSyncablePath, parseConflictCopyPath, syncLayout } from './layout.ts';
import { resolveRemote } from './remote.ts';
import { readState } from './state.ts';
import type { ConflictCopy, SyncStatusInfo } from './types.ts';

async function context(root: string): Promise<GitContext> {
  const real = await realpath(root);
  return {
    root: real,
    scratchDir: syncLayout(real).dir,
    timeoutMs: 60_000,
    networkTimeoutMs: 0,
    staleGitLockMs: 30_000,
  };
}

/** Cópias de conflito (`nota.conflict-<máquina>-<data>.md`) presentes no cérebro, em ordem de caminho. */
export async function listConflicts(root: string): Promise<ConflictCopy[]> {
  const ctx = await context(root);
  const { stdout } = await git(ctx, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const copies: ConflictCopy[] = [];
  for (const path of new Set(stdout.split('\0'))) {
    const parsed = parseConflictCopyPath(path);
    if (parsed === null || !existsSync(join(ctx.root, ...path.split('/')))) continue;
    copies.push({
      copy: path,
      original: parsed.original,
      originalExists: existsSync(join(ctx.root, ...parsed.original.split('/'))),
      machine: parsed.machine,
      date: parsed.date,
    });
  }
  return copies.sort((a, b) => (a.copy < b.copy ? -1 : a.copy > b.copy ? 1 : 0));
}

/** Se há um sync segurando a trava agora (dono vivo nesta máquina, ou trava recente de outra). */
async function syncRunning(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof owner.pid !== 'number') return true;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  } catch {
    return false;
  }
}

/**
 * Situação do sync sem ir ao remoto: último sync, commits locais não enviados e do remoto não integrados (pela
 * última busca), mudanças pendentes, conflitos e remoto configurado.
 */
export async function syncStatus(root: string): Promise<SyncStatusInfo> {
  const ctx = await context(root);
  const layout = syncLayout(ctx.root);
  await readBrainConfig(ctx.root); // recusa uma pasta que não é cérebro, como antes
  const branch = await currentBranch(ctx.root);
  const remote = branch === null ? null : await resolveRemote(ctx, branch, undefined);
  const head = await revParse(ctx, 'HEAD^{commit}');
  const tracking = remote === null ? null : await revParse(ctx, remote.trackingRef);
  let unpushed: number | null = null;
  let unpulled: number | null = null;
  if (remote !== null && head !== null) {
    unpushed = await countCommits(ctx, head, ...(tracking === null ? [] : ['--not', tracking]));
    unpulled = tracking === null ? 0 : await countCommits(ctx, tracking, '--not', head);
  }
  // mesmo critério do commit de edições do sync (`collectPending`): o que o git lista, menos `.cabecao/` e temporários
  const pending = (await statusPorcelain(ctx.root)).filter((entry) => isSyncablePath(entry.path)).length;
  const state = await readState(layout);
  return {
    branch,
    remote: remote === null ? null : { name: remote.name, url: remote.url, branch: remote.branch },
    unpushed,
    unpulled,
    pendingChanges: pending,
    conflicts: (await listConflicts(ctx.root)).length,
    lastSync: state.lastSync ?? null,
    running: await syncRunning(layout.syncLock),
  };
}
