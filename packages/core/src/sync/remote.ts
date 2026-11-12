// Conversa com o remoto: qual remoto e qual branch, buscar e enviar. Qualquer remoto git, sem API de provedor.
import { classifyGitError, GitError, type GitErrorCategory, redactCredentials } from '../git/index.ts';
import { type GitContext, git, revParse } from './git.ts';

export interface RemoteTarget {
  readonly name: string;
  /** URL sem credenciais. */
  readonly url: string;
  /** Branch do remoto que recebe o conteúdo: a que a branch local acompanha, senão a de mesmo nome. */
  readonly branch: string;
  /** Referência local com a última ponta conhecida do remoto. */
  readonly trackingRef: string;
}

/** O remoto pedido explicitamente não existe neste repositório. */
export class MissingRemoteError extends Error {
  override readonly name = 'MissingRemoteError';
}

/**
 * Descobre o remoto e a branch remota da branch local. Nada é assumido sobre o nome da branch principal: vale o
 * que o clone configurou (`branch.<nome>.merge`), senão o mesmo nome da branch local. Devolve `null` quando não há
 * remoto configurado (cérebro só local).
 */
export async function resolveRemote(
  ctx: GitContext,
  localBranch: string,
  explicit: string | undefined,
): Promise<RemoteTarget | null> {
  const { stdout } = await git(ctx, ['config', '-z', '--list'], { allowFailure: true });
  const config = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    const newline = record.indexOf('\n');
    if (newline === -1) config.set(record, 'true');
    else config.set(record.slice(0, newline), record.slice(newline + 1));
  }
  const tracked = config.get(`branch.${localBranch}.remote`);
  const name = explicit ?? (tracked && tracked !== '.' ? tracked : 'origin');
  const url = config.get(`remote.${name}.url`);
  if (url === undefined) {
    if (explicit !== undefined) throw new MissingRemoteError(`o remoto "${explicit}" não existe neste repositório`);
    return null;
  }
  const merge = config.get(`branch.${localBranch}.merge`);
  const branch = tracked === name && merge?.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : localBranch;
  return { name, url: redactCredentials(url), branch, trackingRef: `refs/remotes/${name}/${branch}` };
}

/** Falha ao falar com o remoto, já classificada. */
export class RemoteError extends Error {
  override readonly name = 'RemoteError';
  readonly category: GitErrorCategory;
  readonly detail: string;

  constructor(category: GitErrorCategory, detail: string) {
    super(detail);
    this.category = category;
    this.detail = detail;
  }
}

/** Últimas linhas úteis do stderr, sem credenciais. */
function errorDetail(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^hint:/.test(line));
  return redactCredentials(lines.slice(-3).join(' | ')).slice(0, 500);
}

function asRemoteError(error: unknown): RemoteError {
  if (error instanceof RemoteError) return error;
  if (error instanceof GitError) return new RemoteError(error.category, errorDetail(error.stderr || error.message));
  throw error;
}

/**
 * Atualiza a referência local do remoto e devolve a ponta remota da branch (`null` se o remoto ainda não tem a
 * branch). Uma ida ao remoto quando nada mudou (`ls-remote`); duas quando há commits novos (mais o `fetch`).
 * Lança {@link RemoteError}.
 */
export async function fetchRemote(ctx: GitContext, remote: RemoteTarget): Promise<string | null> {
  try {
    const ref = `refs/heads/${remote.branch}`;
    const listed = await git(ctx, ['ls-remote', '--', remote.name, ref], { network: true });
    const oid =
      listed.stdout
        .split('\n')
        .map((line) => line.split('\t'))
        .find((parts) => parts[1] === ref)?.[0] ?? null;
    const known = await revParse(ctx, remote.trackingRef);
    if (oid === null) {
      if (known !== null) await git(ctx, ['update-ref', '-d', remote.trackingRef]);
      return null;
    }
    if (oid === known) return oid;
    if ((await revParse(ctx, `${oid}^{commit}`)) !== null) {
      // já temos o commit (o envio anterior foi nosso): basta mover a referência
      await git(ctx, ['update-ref', remote.trackingRef, oid]);
      return oid;
    }
    await git(
      ctx,
      ['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote.name, `+${ref}:${remote.trackingRef}`],
      {
        network: true,
      },
    );
    return revParse(ctx, remote.trackingRef);
  } catch (error) {
    throw asRemoteError(error);
  }
}

/** Uma referência a enviar: commit local → referência completa no remoto. */
export interface PushRef {
  readonly sha: string;
  readonly ref: string;
}

export type PushOutcome =
  | { readonly ok: true; readonly atomic: boolean }
  | { readonly ok: false; readonly error: RemoteError; readonly race: boolean };

/** Recusa por corrida (outra máquina enviou antes): buscar de novo resolve. Regra do servidor não. */
function isRace(stderr: string): boolean {
  if (/hook declined|protected branch|not allowed|GH00\d|push declined|deny/i.test(stderr)) return false;
  return /\[rejected\]|fetch first|non-fast-forward|cannot lock ref|incorrect old value|stale info/i.test(stderr);
}

function failed(stderr: string): PushOutcome {
  return { ok: false, error: new RemoteError(classifyGitError(stderr), errorDetail(stderr)), race: isRace(stderr) };
}

/**
 * Envia as referências num único `git push --atomic`: ou o remoto aceita todas, ou nenhuma. É o ponto de extensão
 * para enviar o conteúdo junto com a branch de índice. Servidor sem suporte a envio atômico: envia uma por vez, na
 * ordem dada, parando na primeira recusa (quem chama põe o conteúdo por último). Nunca força: o remoto só aceita
 * avanço simples.
 */
export async function pushRefs(ctx: GitContext, remote: string, refs: readonly PushRef[]): Promise<PushOutcome> {
  const specs = refs.map((ref) => `${ref.sha}:${ref.ref}`);
  try {
    const atomic = await git(ctx, ['push', '--atomic', '--no-verify', '--quiet', remote, ...specs], {
      network: true,
      allowFailure: true,
    });
    if (atomic.exitCode === 0) return { ok: true, atomic: true };
    if (!/does not support --atomic/i.test(atomic.stderr)) return failed(atomic.stderr);
    for (const spec of specs) {
      const one = await git(ctx, ['push', '--no-verify', '--quiet', remote, spec], {
        network: true,
        allowFailure: true,
      });
      if (one.exitCode !== 0) return failed(one.stderr);
    }
    return { ok: true, atomic: false };
  } catch (error) {
    return { ok: false, error: asRemoteError(error), race: false };
  }
}
