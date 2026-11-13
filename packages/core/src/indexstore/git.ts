// Plumbing da branch de índice. Tudo passa pela camada de git do sync (`sync/git.ts`), que já roda sem terminal e
// repete quando outro processo segura um `*.lock` do git. Nada aqui toca na pasta de trabalho nem no índice do usuário.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError } from '../git/index.ts';
import { type GitContext, git, gitText } from '../sync/git.ts';
import { parseGenerationRef, parseTrackingRef } from './layout.ts';

export type { GitContext } from '../sync/git.ts';

export const DEFAULT_INDEX_TIMEOUT_MS = 120_000;
export const DEFAULT_INDEX_NETWORK_TIMEOUT_MS = 60_000;
export const DEFAULT_INDEX_STALE_GIT_LOCK_MS = 30_000;

export function makeGitContext(
  root: string,
  scratchDir: string,
  options: { timeoutMs?: number; networkTimeoutMs?: number; staleGitLockMs?: number } = {},
): GitContext {
  return {
    root,
    scratchDir,
    timeoutMs: options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
    networkTimeoutMs: options.networkTimeoutMs ?? DEFAULT_INDEX_NETWORK_TIMEOUT_MS,
    staleGitLockMs: options.staleGitLockMs ?? DEFAULT_INDEX_STALE_GIT_LOCK_MS,
  };
}

/** Uma entrada de `git ls-tree -r -l`. */
export interface TreeItem {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  /** Tamanho do blob em bytes (`-1` para o que não é blob). */
  readonly size: number;
  readonly path: string;
}

/** Árvore inteira de um commit (ou de uma pasta, com `prefix`), com o tamanho de cada blob. */
export async function lsTree(ctx: GitContext, treeish: string, prefix?: string): Promise<Map<string, TreeItem>> {
  const args = ['ls-tree', '-r', '-l', '-z', '--full-tree', treeish];
  if (prefix !== undefined) args.push('--', prefix);
  const { stdout } = await git(ctx, args);
  const out = new Map<string, TreeItem>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode = '', type = '', oid = '', size = '-'] = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    out.set(path, { mode, type, oid, size: size === '-' ? -1 : Number(size), path });
  }
  return out;
}

/** Uma referência da branch de índice, local ou de acompanhamento de um remoto. */
export interface IndexRef {
  readonly ref: string;
  readonly oid: string;
  readonly generation: number;
  /** `null` para a branch local; nome do remoto para `refs/remotes/<remoto>/...`. */
  readonly remote: string | null;
}

/** Todas as referências do índice que apontam para commits: as locais e as de acompanhamento. */
export async function listIndexRefs(ctx: GitContext): Promise<IndexRef[]> {
  const { stdout } = await git(ctx, [
    'for-each-ref',
    '--format=%(objectname) %(objecttype) %(refname)',
    'refs/heads/cabecao/',
    'refs/remotes/',
  ]);
  const refs: IndexRef[] = [];
  for (const line of stdout.split('\n')) {
    const [oid = '', type = '', ref = ''] = line.split(' ');
    if (type !== 'commit') continue;
    const local = parseGenerationRef(ref);
    if (local !== null) {
      refs.push({ ref, oid, generation: local, remote: null });
      continue;
    }
    const tracking = parseTrackingRef(ref);
    if (tracking) refs.push({ ref, oid, generation: tracking.generation, remote: tracking.remote });
  }
  return refs.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** Os commits da lista que não são ancestrais de nenhum outro (`git merge-base --independent`). */
export async function independentTips(ctx: GitContext, oids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(oids)];
  if (unique.length < 2) return unique;
  const out = await gitText(ctx, ['merge-base', '--independent', ...unique]);
  const keep = new Set(out.split('\n').filter(Boolean));
  return unique.filter((oid) => keep.has(oid));
}

/** Ancestral comum, ou `null` se os históricos não se tocam. */
export async function mergeBase(ctx: GitContext, a: string, b: string): Promise<string | null> {
  const result = await git(ctx, ['merge-base', a, b], { allowFailure: true });
  if (result.exitCode === 0) return result.stdout.trim() || null;
  if (result.exitCode === 1) return null;
  throw new GitError({ args: result.args, exitCode: result.exitCode, stderr: result.stderr });
}

/** O objeto existe no banco local. */
export async function hasObject(ctx: GitContext, spec: string): Promise<boolean> {
  return (await git(ctx, ['cat-file', '-e', spec], { allowFailure: true })).exitCode === 0;
}

/** SHA da árvore vazia (gravada, se faltar). Funciona com SHA-1 e SHA-256. */
export async function emptyTree(ctx: GitContext): Promise<string> {
  return gitText(ctx, ['mktree'], { input: '' });
}

const NO_IDENTITY = /tell me who you are|empty ident|unable to auto-detect email|invalid ident|name consists only/i;
/** Identidade usada só quando o git do usuário não tem nenhuma (clone recém-feito numa máquina sem configuração). */
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'Cabeção',
  GIT_AUTHOR_EMAIL: 'cabecao@localhost',
  GIT_COMMITTER_NAME: 'Cabeção',
  GIT_COMMITTER_EMAIL: 'cabecao@localhost',
};

/**
 * Commit sem tocar em nada da pasta de trabalho, nunca assinado (`--no-gpg-sign`: assinar pode pedir senha num
 * processo sem terminal). Usa a identidade do git do usuário; sem nenhuma configurada, uma identidade neutra.
 */
export async function commitTree(
  ctx: GitContext,
  tree: string,
  parents: readonly string[],
  message: string,
): Promise<string> {
  const args = ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'];
  const first = await git(ctx, args, { input: message, allowFailure: true });
  if (first.exitCode === 0) return first.stdout.trim();
  if (!NO_IDENTITY.test(first.stderr)) {
    throw new GitError({ args, exitCode: first.exitCode, stdout: first.stdout, stderr: first.stderr });
  }
  return gitText(ctx, args, { input: message, env: FALLBACK_IDENTITY });
}

/** A referência não estava no valor esperado: outro processo a moveu. */
export class IndexRefRaceError extends Error {
  override readonly name = 'IndexRefRaceError';
  readonly ref: string;

  constructor(ref: string, detail: string) {
    super(`a referência ${ref} mudou durante a operação: ${detail}`);
    this.ref = ref;
  }
}

const REF_RACE = /cannot lock ref|is at [0-9a-f]+ but expected|reference already exists|unable to resolve reference/i;

/**
 * `update-ref` condicional: move `ref` para `next` só se ela ainda estiver em `expected` (`null` = não pode existir).
 * `next = null` apaga. Sem reflog novo (o reflog seguraria vetores antigos no disco por 90 dias). Lança
 * {@link IndexRefRaceError} quando o valor atual não é o esperado.
 */
export async function updateRef(
  ctx: GitContext,
  ref: string,
  next: string | null,
  expected: string | null,
  zeroLength: number,
): Promise<void> {
  const zero = '0'.repeat(zeroLength);
  const args =
    next === null
      ? ['-c', 'core.logAllRefUpdates=false', 'update-ref', '-d', ref, ...(expected === null ? [] : [expected])]
      : ['-c', 'core.logAllRefUpdates=false', 'update-ref', '-m', 'cabecao index', ref, next, expected ?? zero];
  const result = await git(ctx, args, { allowFailure: true });
  if (result.exitCode === 0) return;
  if (REF_RACE.test(result.stderr)) throw new IndexRefRaceError(ref, result.stderr.trim().split('\n')[0] ?? '');
  throw new GitError({ args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Apaga índices temporários (`index-<pid>-<hex>`) deixados por processos que morreram no meio. */
export async function cleanScratch(scratchDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(scratchDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = /^index-(\d+)-[0-9a-f]+(?:\.lock)?$/.exec(name);
    if (!match || pidAlive(Number(match[1]))) continue;
    await rm(join(scratchDir, name), { force: true }).catch(() => {});
    removed++;
  }
  return removed;
}
