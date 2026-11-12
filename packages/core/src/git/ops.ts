/**
 * Operações de git usadas pelo resto do núcleo. Todas passam por `runGit`: sem shell, sem interação e só com o
 * binário `git` do usuário.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommitTrailers, formatDate, parseCommitTrailers } from './commit-message.ts';
import { GitError, GitStateError } from './errors.ts';
import { type GitOpOptions, type GitResult, runGit } from './run.ts';

/** Prefixo das tags de ponto de restauração. São locais: nenhuma operação daqui as envia ao remoto. */
export const RESTORE_TAG_PREFIX = 'cabecao/restore/';

function git(
  repo: string,
  args: readonly string[],
  options: GitOpOptions,
  extra: { input?: string; allowFailure?: boolean } = {},
): Promise<GitResult> {
  return runGit(args, { ...options, ...extra, cwd: repo });
}

function failure(result: GitResult): GitError {
  return new GitError({ args: result.args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
}

/** Grava a mensagem num arquivo temporário para o `git commit -F`; a entrada padrão fica livre para os caminhos. */
async function withMessageFile<T>(message: string, run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cabecao-commit-'));
  try {
    const file = join(dir, 'message.txt');
    await writeFile(file, message, 'utf8');
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Opções de assinatura: `--no-gpg-sign` por padrão, para um `commit.gpgsign` com senha não travar o processo. */
function signFlags(sign: boolean | undefined): string[] {
  return sign ? [] : ['--no-gpg-sign'];
}

export interface CommitOptions extends GitOpOptions {
  /**
   * `true` deixa o git seguir `commit.gpgsign` do usuário. O padrão (`false`) passa `--no-gpg-sign`: a assinatura
   * pode pedir senha, e um processo sem terminal ficaria parado até o tempo limite.
   */
  sign?: boolean;
}

/** `true` quando a pasta está dentro da árvore de trabalho de um repositório git. Pasta inexistente: `false`. */
export async function isRepo(dir: string, options: GitOpOptions = {}): Promise<boolean> {
  try {
    const result = await git(dir, ['rev-parse', '--is-inside-work-tree'], options, { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  } catch (error) {
    if (error instanceof GitError && !error.timedOut) return false;
    throw error;
  }
}

/** SHA do commit em `HEAD`, ou `null` num repositório ainda sem commits. */
export async function headSha(repo: string, options: GitOpOptions = {}): Promise<string | null> {
  const result = await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options, {
    allowFailure: true,
  });
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return null;
  throw failure(result);
}

/** Nome da branch atual (também num repositório sem commits), ou `null` com `HEAD` solto. */
export async function currentBranch(repo: string, options: GitOpOptions = {}): Promise<string | null> {
  const result = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options, { allowFailure: true });
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return null;
  throw failure(result);
}

export interface StatusEntry {
  /** Estado no índice (primeira coluna do formato porcelain v1): `M`, `A`, `D`, `R`, `?`, espaço... */
  index: string;
  /** Estado na pasta de trabalho (segunda coluna). */
  worktree: string;
  /** Caminho relativo à raiz do repositório, com `/`, sem aspas nem escapes. */
  path: string;
  /** Caminho anterior, em renomeações e cópias. */
  origPath?: string;
}

/** `git status --porcelain=v1 -z`, com cada arquivo não rastreado listado individualmente. */
export async function statusPorcelain(repo: string, options: GitOpOptions = {}): Promise<StatusEntry[]> {
  const { stdout } = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  const tokens = stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.length < 4) continue;
    const entry: StatusEntry = { index: token.charAt(0), worktree: token.charAt(1), path: token.slice(3) };
    if (/[RC]/.test(entry.index + entry.worktree)) {
      const origPath = tokens[++i];
      if (origPath !== undefined) entry.origPath = origPath;
    }
    entries.push(entry);
  }
  return entries;
}

export interface DefaultRemoteBranchOptions extends GitOpOptions {
  /** Nome do remoto. Padrão: `origin`. */
  remote?: string;
  /** Pergunta ao remoto mesmo que o clone já tenha a resposta guardada. */
  refresh?: boolean;
}

/**
 * Nome da branch principal que o remoto usa (`main`, `master`, `trunk`...). Nada é assumido.
 *
 * Primeiro lê `refs/remotes/<remoto>/HEAD`, que o `git clone` grava e não exige rede. Se não existir (remoto
 * acrescentado depois com `git remote add`) ou com `refresh`, pergunta ao remoto com `git ls-remote --symref`.
 * Devolve `null` quando o remoto não informa a branch, o que acontece em remotos vazios. Lança `GitError` quando o
 * remoto não existe ou não responde.
 */
export async function defaultRemoteBranch(
  repo: string,
  options: DefaultRemoteBranchOptions = {},
): Promise<string | null> {
  const { remote = 'origin', refresh = false, ...rest } = options;
  if (!remote || remote.startsWith('-')) throw new TypeError(`Nome de remoto inválido: "${remote}".`);
  if (!refresh) {
    const local = await git(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], rest, {
      allowFailure: true,
    });
    const name = local.stdout.trim();
    if (local.exitCode === 0 && name.startsWith(`${remote}/`)) return name.slice(remote.length + 1);
  }
  const { stdout } = await git(repo, ['ls-remote', '--symref', '--', remote, 'HEAD'], rest);
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(stdout)?.[1] ?? null;
}

function normalizePaths(paths: readonly string[]): string[] {
  const list = paths.map((path) => (process.platform === 'win32' ? path.replaceAll('\\', '/') : path));
  if (list.length === 0) throw new TypeError('commitPaths precisa de pelo menos um caminho.');
  for (const path of list) {
    if (!path || path.includes('\0')) throw new TypeError('Caminho vazio ou com caractere nulo.');
  }
  return [...new Set(list)];
}

/**
 * Faz um commit só com os caminhos dados (relativos à raiz do repositório) e devolve o SHA, ou `null` quando
 * nenhum deles mudou.
 *
 * - Arquivos novos, alterados e apagados da lista entram; o que estiver fora dela fica de fora, mesmo que já
 *   esteja preparado no índice (`git commit --only`), e continua preparado depois.
 * - Os caminhos são literais (`--literal-pathspecs`): colchetes, asteriscos e dois-pontos em nomes de nota não
 *   são tratados como padrão. Uma pasta inclui tudo que há dentro dela.
 * - Usa `--no-verify` (não depende de hooks do usuário) e não assina, a menos de `sign: true`.
 * - A lista vai pela entrada padrão, então não há limite de tamanho de linha de comando (32 mil caracteres no
 *   Windows).
 * - A mensagem é gravada como veio: nenhuma linha de coautoria ou atribuição é acrescentada.
 */
export async function commitPaths(
  repo: string,
  paths: readonly string[],
  message: string,
  options: CommitOptions = {},
): Promise<string | null> {
  const { sign, ...rest } = options;
  const input = normalizePaths(paths).join('\0');
  const pathspec = ['--pathspec-from-file=-', '--pathspec-file-nul'];
  await git(repo, ['--literal-pathspecs', 'add', ...pathspec], rest, { input });
  return withMessageFile(message, async (file) => {
    const result = await git(
      repo,
      [
        '--literal-pathspecs',
        'commit',
        '--only',
        '--no-verify',
        ...signFlags(sign),
        '--cleanup=whitespace',
        '-F',
        file,
        ...pathspec,
      ],
      rest,
      { input, allowFailure: true },
    );
    // "Nada a commitar" sai com código 1 e explica no stdout; erro de verdade escreve no stderr.
    if (result.exitCode === 1 && result.stderr.trim() === '') return null;
    if (result.exitCode !== 0) throw failure(result);
    return headSha(repo, rest);
  });
}

export interface TrailerCommit {
  sha: string;
  /** Data do autor, em ISO 8601 com o fuso de quem gravou. */
  authorDate: string;
  subject: string;
  message: string;
  trailers: CommitTrailers;
}

/** Busca por operação ou por sessão; exatamente um dos dois. O valor pode ser só o começo do identificador. */
export type TrailerQuery = { op: string; session?: never } | { session: string; op?: never };

/**
 * Commits alcançáveis a partir de `HEAD` cujo rodapé `Cabecao-Op` ou `Cabecao-Session` começa com o valor dado,
 * do mais novo para o mais antigo (a ordem que o `revertCommits` espera).
 *
 * O `git log --grep` só pré-seleciona; cada mensagem é conferida com `parseCommitTrailers`, para que um texto
 * igual no corpo de outro commit não entre no resultado.
 */
export async function findCommitsByTrailer(
  repo: string,
  query: TrailerQuery,
  options: GitOpOptions = {},
): Promise<TrailerCommit[]> {
  const key = query.op !== undefined ? 'op' : 'session';
  const value = (query.op ?? query.session ?? '').trim();
  if (!value || /\s/.test(value)) throw new TypeError('Informe o identificador da operação ou da sessão.');
  if ((await headSha(repo, options)) === null) return [];
  const needle = `Cabecao-${key === 'op' ? 'Op' : 'Session'}: ${value}`;
  const { stdout } = await git(
    repo,
    ['log', '-z', '--fixed-strings', `--grep=${needle}`, '--format=%H%n%aI%n%B', 'HEAD'],
    options,
  );
  const commits: TrailerCommit[] = [];
  for (const record of stdout.split('\0')) {
    const [sha, authorDate, ...lines] = record.replace(/^\n+/, '').split('\n');
    if (!sha || authorDate === undefined) continue;
    const message = lines.join('\n');
    const trailers = parseCommitTrailers(message);
    if (!trailers[key]?.startsWith(value)) continue;
    commits.push({ sha, authorDate, subject: lines[0] ?? '', message, trailers });
  }
  return commits;
}

/**
 * Desfaz os commits dados com UM commit novo de `git revert`, sem reescrever histórico. Devolve o SHA, ou `null`
 * quando desfazer não muda nada.
 *
 * - `shas` vai do mais novo para o mais antigo, como devolve o `findCommitsByTrailer`.
 * - O índice precisa estar limpo (lança {@link GitStateError}): o commit de revert leva o índice inteiro, e
 *   mudanças preparadas por outro motivo entrariam junto. Mudanças não preparadas em outros arquivos não
 *   atrapalham.
 * - Se o revert não aplica (conflito com mudanças posteriores, arquivo alterado na pasta de trabalho, commit de
 *   merge), o repositório volta ao estado anterior e o `GitError` do git é lançado.
 */
export async function revertCommits(
  repo: string,
  shas: readonly string[],
  message: string,
  options: CommitOptions = {},
): Promise<string | null> {
  const { sign, ...rest } = options;
  if (shas.length === 0) throw new TypeError('revertCommits precisa de pelo menos um commit.');
  for (const sha of shas) {
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new TypeError(`SHA inválido: "${sha}".`);
  }
  const staged = await git(repo, ['diff', '--cached', '--quiet'], rest, { allowFailure: true });
  if (staged.exitCode === 1) {
    throw new GitStateError(
      'Há mudanças preparadas no índice; faça o commit delas ou tire-as do índice antes de desfazer.',
    );
  }
  if (staged.exitCode !== 0) throw failure(staged);

  const undoPartialRevert = async () => {
    await git(repo, ['revert', '--quit'], rest, { allowFailure: true });
    await git(repo, ['reset', '--merge'], rest, { allowFailure: true });
  };
  const reverted = await git(repo, ['revert', '--no-commit', '--no-edit', ...signFlags(sign), ...shas], rest, {
    allowFailure: true,
  });
  if (reverted.exitCode !== 0) {
    await undoPartialRevert();
    throw failure(reverted);
  }
  return withMessageFile(message, async (file) => {
    const result = await git(
      repo,
      ['commit', '--no-verify', ...signFlags(sign), '--cleanup=whitespace', '-F', file],
      rest,
      { allowFailure: true },
    );
    // O `revert --no-commit` deixa o git em "revert em andamento" até o commit; aqui ele já terminou ou falhou.
    await git(repo, ['revert', '--quit'], rest, { allowFailure: true });
    if (result.exitCode === 1 && result.stderr.trim() === '') return null;
    if (result.exitCode !== 0) {
      await undoPartialRevert();
      throw failure(result);
    }
    return headSha(repo, rest);
  });
}

/** Nome de ponto de restauração para um instante, no fuso da máquina: `2026-11-12-143210-482`. */
export function restorePointName(date: Date): string {
  return formatDate(date, 'YYYY-MM-DD-HHmmss-SSS');
}

export interface RestorePoint {
  /** Nome completo da tag: `cabecao/restore/<nome>`. */
  tag: string;
  /** Commit marcado. */
  sha: string;
}

/**
 * Cria a tag local `cabecao/restore/<nome>` no commit atual, antes de uma manutenção.
 *
 * `name` é normalmente o `restorePointName(data)`; uma `Date` é convertida assim. A tag é leve e nunca assinada.
 * Lança `GitError` se a tag já existe ou se o nome não serve para uma referência do git, e {@link GitStateError}
 * num repositório sem commits.
 */
export async function createRestorePoint(
  repo: string,
  name: string | Date,
  options: GitOpOptions = {},
): Promise<RestorePoint> {
  const suffix = typeof name === 'string' ? name.trim() : restorePointName(name);
  if (!suffix || suffix.startsWith('-')) throw new TypeError(`Nome de ponto de restauração inválido: "${suffix}".`);
  const sha = await headSha(repo, options);
  if (sha === null) throw new GitStateError('O repositório ainda não tem commits; não há o que restaurar.');
  const tag = `${RESTORE_TAG_PREFIX}${suffix}`;
  await git(repo, ['tag', '--no-sign', '--', tag, sha], options);
  return { tag, sha };
}
