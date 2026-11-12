// Comandos git do sync. Tudo passa pelo ambiente sem terminal da camada `git/` (`runGit` e `buildGitEnv`).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildGitEnv, GitError, type GitResult, runGit } from '../git/index.ts';

export interface GitContext {
  /** Raiz do cérebro (pasta de trabalho do repositório). */
  readonly root: string;
  /** Pasta para os índices temporários do git. */
  readonly scratchDir: string;
  readonly timeoutMs: number;
  readonly networkTimeoutMs: number;
  readonly staleGitLockMs: number;
}

export interface GitCall {
  input?: string | Uint8Array;
  env?: Readonly<Record<string, string | undefined>>;
  allowFailure?: boolean;
  /** Fala com o remoto: usa o tempo limite de rede. */
  network?: boolean;
}

const LOCK_HELD = /Unable to create '([^'\n]+\.lock)': File exists/;

/**
 * Se o erro do git foi "outro processo segura o `*.lock`", apaga o lock quando ele é velho demais para ser de um
 * processo vivo. Devolve `true` quando o erro era esse (vale tentar de novo).
 */
export async function handleGitLockError(ctx: GitContext, stderr: string): Promise<boolean> {
  const held = LOCK_HELD.exec(stderr)?.[1];
  if (held === undefined) return false;
  await dropStaleGitLock(ctx, held);
  return true;
}

/** Apaga um `*.lock` do git deixado por um processo que morreu (mais velho que o limite). */
export async function dropStaleGitLock(ctx: GitContext, lockPath: string): Promise<void> {
  const path = isAbsolute(lockPath) ? lockPath : join(ctx.root, lockPath);
  try {
    if (Date.now() - (await stat(path)).mtimeMs > ctx.staleGitLockMs) await unlink(path);
  } catch {
    // já sumiu ou outro processo cuidou
  }
}

/**
 * `runGit` na raiz do cérebro. Quando outro processo git (Obsidian Git, o terminal) segura um `*.lock`, espera e
 * tenta de novo; um lock mais velho que `staleGitLockMs` é de processo morto e é apagado.
 */
export async function git(ctx: GitContext, args: readonly string[], call: GitCall = {}): Promise<GitResult> {
  const deadline = Date.now() + ctx.staleGitLockMs + 5_000;
  for (;;) {
    const result = await runGit(args, {
      cwd: ctx.root,
      timeoutMs: call.network ? ctx.networkTimeoutMs : ctx.timeoutMs,
      allowFailure: true,
      ...(call.input === undefined ? {} : { input: call.input }),
      ...(call.env === undefined ? {} : { env: call.env }),
    });
    if (result.exitCode === 0) return result;
    const held = LOCK_HELD.exec(result.stderr)?.[1];
    if (held !== undefined && Date.now() < deadline) {
      await dropStaleGitLock(ctx, held);
      await sleep(20 + Math.random() * 60);
      continue;
    }
    if (call.allowFailure) return result;
    throw new GitError({ args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  }
}

export async function gitText(ctx: GitContext, args: readonly string[], call: GitCall = {}): Promise<string> {
  return (await git(ctx, args, call)).stdout.trim();
}

/**
 * Como `runGit`, mas devolve a saída em bytes: o `cat-file --batch` informa tamanhos em bytes, e um anexo binário
 * não sobrevive à conversão para texto. Usa o mesmo ambiente sem terminal (`buildGitEnv`).
 */
export async function gitBytes(ctx: GitContext, args: readonly string[], input?: string): Promise<Buffer> {
  const env = await buildGitEnv(args, { cwd: ctx.root });
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'git.exe' : 'git', [...args], {
      cwd: ctx.root,
      env,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new GitError({
          args,
          exitCode: null,
          signal: 'SIGKILL',
          stderr: Buffer.concat(stderr).toString(),
          timedOut: true,
        }),
      );
    }, ctx.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new GitError({ args, exitCode: null, summary: `não foi possível iniciar o git: ${cause.message}`, cause }),
      );
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      if (code === 0) resolve(out);
      else reject(new GitError({ args, exitCode: code, signal, stderr: Buffer.concat(stderr).toString() }));
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** SHA do objeto, ou `null` se não existe. Exemplos: `HEAD^{commit}`, `abc123:wiki/x.md`. */
export async function revParse(ctx: GitContext, spec: string): Promise<string | null> {
  const result = await git(ctx, ['rev-parse', '-q', '--verify', '--end-of-options', spec], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function treeOf(ctx: GitContext, commit: string): Promise<string> {
  return gitText(ctx, ['rev-parse', '--verify', `${commit}^{tree}`]);
}

/** `a` é ancestral de `b` (ou igual a ele). */
export async function isAncestor(ctx: GitContext, a: string, b: string): Promise<boolean> {
  const result = await git(ctx, ['merge-base', '--is-ancestor', a, b], { allowFailure: true });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GitError({ args: result.args, exitCode: result.exitCode, stderr: result.stderr });
}

/** Quantos commits há em `range` (`a..b`). */
export async function countCommits(ctx: GitContext, ...revs: string[]): Promise<number> {
  return Number(await gitText(ctx, ['rev-list', '--count', ...revs]));
}

/**
 * Lê vários objetos de uma vez (`git cat-file --batch`). Aceita SHAs e nomes como `<commit>:<caminho>`; o mapa
 * devolvido usa o nome pedido. Objetos que não existem ficam de fora.
 */
export async function readObjects(ctx: GitContext, names: Iterable<string>): Promise<Map<string, Buffer>> {
  const list = [...new Set(names)].filter((name) => !name.includes('\n'));
  const found = new Map<string, Buffer>();
  if (list.length === 0) return found;
  const out = await gitBytes(ctx, ['cat-file', '--batch'], `${list.join('\n')}\n`);
  let offset = 0;
  for (const name of list) {
    const newline = out.indexOf(10, offset);
    if (newline === -1) break;
    const header = out.subarray(offset, newline).toString('utf8').split(' ');
    offset = newline + 1;
    if (header.length !== 3) continue; // "<nome> missing" ou "<nome> ambiguous"
    const size = Number(header[2]);
    found.set(name, out.subarray(offset, offset + size));
    offset += size + 1;
  }
  return found;
}

/** Grava um blob no banco de objetos e devolve o SHA. */
export async function writeBlob(ctx: GitContext, data: string | Uint8Array): Promise<string> {
  return gitText(ctx, ['hash-object', '-w', '--stdin'], { input: data });
}

/** Troca, acrescenta ou (com `oid: null`) remove um caminho numa árvore. */
export interface TreeEdit {
  readonly path: string;
  readonly oid: string | null;
  /** Padrão: `100644`. */
  readonly mode?: string;
}

/**
 * Árvore nova a partir de `base` com as edições aplicadas, montada num índice descartável: o índice do usuário e
 * a pasta de trabalho não são tocados.
 */
export async function editTree(ctx: GitContext, base: string, edits: readonly TreeEdit[]): Promise<string> {
  if (edits.length === 0) return base;
  await mkdir(ctx.scratchDir, { recursive: true });
  const indexFile = join(ctx.scratchDir, `index-${process.pid}-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(ctx, ['read-tree', base], { env });
    const zero = '0'.repeat(base.length);
    const lines = edits.map((edit) =>
      edit.oid === null ? `0 ${zero}\t${edit.path}` : `${edit.mode ?? '100644'} ${edit.oid}\t${edit.path}`,
    );
    await git(ctx, ['update-index', '-z', '--index-info'], { env, input: `${lines.join('\0')}\0` });
    return await gitText(ctx, ['write-tree'], { env });
  } finally {
    await rm(indexFile, { force: true });
    await rm(`${indexFile}.lock`, { force: true });
  }
}

export interface AuthorInfo {
  readonly name: string;
  readonly email: string;
  readonly date: string;
}

/** Cria um commit sem tocar em nada da pasta de trabalho. Nunca assina (assinatura pode pedir senha). */
export async function commitTree(
  ctx: GitContext,
  tree: string,
  parents: readonly string[],
  message: string,
  author?: AuthorInfo,
): Promise<string> {
  const env = author
    ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date }
    : undefined;
  return gitText(ctx, ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], {
    input: message,
    ...(env === undefined ? {} : { env }),
  });
}

/** Uma entrada de `git ls-tree -r`. */
export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  /** Caminho como está no repositório, com `/`. */
  readonly path: string;
}

export async function listTree(ctx: GitContext, treeish: string): Promise<TreeEntry[]> {
  const { stdout } = await git(ctx, ['ls-tree', '-r', '-z', '--full-tree', treeish]);
  const entries: TreeEntry[] = [];
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode = '', type = '', oid = ''] = record.slice(0, tab).split(' ');
    entries.push({ mode, type, oid, path: record.slice(tab + 1) });
  }
  return entries;
}

/** Diferença entre dois commits: `A`, `M`, `D`, `T` por caminho, sem detecção de renomeação. */
export async function diffNames(
  ctx: GitContext,
  from: string,
  to: string,
): Promise<{ status: string; path: string }[]> {
  const { stdout } = await git(ctx, ['diff', '--name-status', '-z', '--no-renames', from, to]);
  const tokens = stdout.split('\0');
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i];
    const path = tokens[i + 1];
    if (status && path) out.push({ status: status.charAt(0), path });
  }
  return out;
}
