/**
 * `cabecao remote <url>`: liga um cérebro só local a um remoto, ou troca o remoto de um cérebro.
 *
 * - Remoto vazio: o cérebro é enviado e o upstream configurado.
 * - Remoto com conteúdo da MESMA história (o mesmo cérebro, num endereço novo, mais adiantado ou mais atrasado):
 *   o remoto é ligado; se o local estiver só à frente, é enviado; se estiver atrás ou divergente, o próximo
 *   `cabecao sync` integra.
 * - Remoto com conteúdo de OUTRA história: recusado, para não misturar históricos em silêncio.
 */
import { resolve } from 'node:path';
import type { GitOpOptions } from '../git/index.ts';
import { currentBranch, headSha, redactCredentials, runGit } from '../git/index.ts';
import { readBrainConfig } from '../vault/index.ts';
import { detectRepoKind } from './detect.ts';
import type { InitDetection } from './init.ts';
import type { RemoteFailure, VisibilityCheck } from './remote.ts';
import {
  checkRemoteVisibility,
  describeRemoteFailure,
  normalizeRemoteUrl,
  PROBE_TIMEOUT_MS,
  probeRemote,
  publicRemoteWarning,
  remoteFailureMessage,
  remoteUrlProblem,
  resolveRemoteArg,
  TRANSFER_TIMEOUT_MS,
} from './remote.ts';
import type { InitWarning } from './shared.ts';
import { checkRemoteHead, gitOptions, isRepoRoot, Rollback } from './shared.ts';

/** Como o histórico local se relaciona com a branch principal do remoto. */
export type RemoteRelation = 'empty' | 'same' | 'ahead' | 'behind' | 'diverged' | 'unrelated';

/**
 * - `connected`: o remoto foi ligado (e, se dava, o cérebro foi enviado).
 * - `already-connected`: o cérebro já usava esse remoto; nada mudou.
 * - `refused`: o remoto tem outra história; nada mudou.
 * - `remote-error`: URL inválida, sem permissão, sem rede ou envio recusado; nada mudou.
 */
export type ConnectCase = 'connected' | 'already-connected' | 'refused' | 'remote-error';

export interface ConnectRemoteOptions extends GitOpOptions {
  /** Verificação de repositório público; `false` desliga. Padrão: {@link checkRemoteVisibility}. */
  readonly visibilityCheck?: false | ((url: string) => Promise<VisibilityCheck>);
}

export interface ConnectRemoteResult {
  readonly ok: boolean;
  readonly case: ConnectCase;
  readonly message: string;
  readonly root: string;
  /** Branch principal depois da operação (o nome que o remoto usa). */
  readonly branch: string | null;
  /** Remoto ligado, sem credenciais. */
  readonly remote: string | null;
  /** Remoto que havia antes, sem credenciais. */
  readonly previousRemote: string | null;
  readonly relation: RemoteRelation | null;
  readonly pushed: boolean;
  /** O que há no remoto, quando ele foi recusado. */
  readonly detection: InitDetection | null;
  readonly error: RemoteFailure | null;
  readonly warnings: readonly InitWarning[];
  readonly nextSteps: readonly string[];
}

/** Referência temporária onde a branch do remoto é baixada para comparar históricos. */
const PROBE_REF = 'refs/cabecao/connect-probe';

async function git(root: string, args: string[], options: GitOpOptions, allowFailure = false) {
  return runGit(args, { ...options, cwd: root, allowFailure });
}

async function configValue(root: string, key: string, options: GitOpOptions): Promise<string | null> {
  const result = await git(root, ['config', '--get', key], options, true);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function restoreConfig(root: string, key: string, value: string | null, options: GitOpOptions) {
  if (value === null) await git(root, ['config', '--unset', key], options, true);
  else await git(root, ['config', key, value], options);
}

async function refValue(root: string, ref: string, options: GitOpOptions): Promise<string | null> {
  const result = await git(root, ['rev-parse', '--verify', '--quiet', ref], options, true);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function isAncestor(root: string, a: string, b: string, options: GitOpOptions): Promise<boolean> {
  return (await git(root, ['merge-base', '--is-ancestor', a, b], options, true)).exitCode === 0;
}

async function relationTo(root: string, head: string | null, remoteSha: string, options: GitOpOptions) {
  if (head === null) return 'unrelated' as const;
  if (head === remoteSha) return 'same' as const;
  if (await isAncestor(root, head, remoteSha, options)) return 'behind' as const;
  if (await isAncestor(root, remoteSha, head, options)) return 'ahead' as const;
  const base = await git(root, ['merge-base', head, remoteSha], options, true);
  return base.exitCode === 0 ? ('diverged' as const) : ('unrelated' as const);
}

/**
 * Liga o cérebro em `root` ao remoto `url` (o futuro `cabecao remote <url>`), ou troca o remoto que ele já tem.
 * Em qualquer falha, o remoto, a branch e o upstream voltam a ser como eram. Lança `VaultError` se `root` não é um
 * cérebro.
 */
export async function connectRemote(
  rootDir: string,
  url: string,
  options: ConnectRemoteOptions = {},
): Promise<ConnectRemoteResult> {
  const root = resolve(rootDir);
  const quick = gitOptions(options);
  await readBrainConfig(root);
  if (!(await isRepoRoot(root, quick)))
    throw new Error(`${root} tem um .cabecao.json, mas não é a raiz de um repositório git.`);

  const warnings: InitWarning[] = [];
  const previous = (await configValue(root, 'remote.origin.url', quick)) ?? null;
  const branch = await currentBranch(root, quick);
  if (branch === null) throw new Error(`o cérebro em ${root} está com HEAD solto; volte para a branch principal.`);
  const base = {
    root,
    previousRemote: previous === null ? null : redactCredentials(previous),
    detection: null,
    error: null,
    warnings,
  };
  const fail = (failure: RemoteFailure, remote: string): ConnectRemoteResult => ({
    ...base,
    ok: false,
    case: 'remote-error',
    message: `${failure.message} Nada foi alterado.`,
    branch,
    remote: redactCredentials(remote),
    relation: null,
    pushed: false,
    error: failure,
    nextSteps:
      failure.category === 'invalid-url'
        ? []
        : [`Confira o acesso no terminal: git ls-remote ${redactCredentials(remote)}`],
  });

  const problem = remoteUrlProblem(url);
  if (problem !== null) {
    return fail(
      { category: 'invalid-url', message: `${remoteFailureMessage('invalid-url', url)} (${problem})`, detail: problem },
      url,
    );
  }
  const remote = resolveRemoteArg(url);
  const shownRemote = redactCredentials(remote);
  if (previous !== null && normalizeRemoteUrl(previous, root) === normalizeRemoteUrl(remote)) {
    return {
      ...base,
      ok: true,
      case: 'already-connected',
      message: `O cérebro já usa ${shownRemote}; nada mudou.`,
      branch,
      remote: shownRemote,
      relation: null,
      pushed: false,
      nextSteps: [],
    };
  }

  let probe: Awaited<ReturnType<typeof probeRemote>>;
  try {
    probe = await probeRemote(remote, gitOptions(options, PROBE_TIMEOUT_MS));
  } catch (error) {
    return fail(describeRemoteFailure(error, remote), remote);
  }
  if (options.visibilityCheck !== false) {
    try {
      const check = await (options.visibilityCheck ?? ((target: string) => checkRemoteVisibility(target)))(remote);
      if (check.visibility === 'public' && check.provider !== null) {
        warnings.push({ code: 'public-remote', message: publicRemoteWarning(remote, check.provider) });
      }
    } catch {
      // é só um aviso
    }
  }

  const head = await headSha(root, quick);
  const transfer = gitOptions(options, TRANSFER_TIMEOUT_MS);
  const rollback = new Rollback();
  const setOrigin = async () => {
    if (previous === null) {
      await git(root, ['remote', 'add', 'origin', remote], quick);
      rollback.add(async () => {
        await git(root, ['remote', 'remove', 'origin'], quick, true);
      });
    } else {
      await git(root, ['remote', 'set-url', 'origin', remote], quick);
      rollback.add(async () => {
        await git(root, ['remote', 'set-url', 'origin', previous], quick);
      });
    }
  };
  const push = async (name: string): Promise<RemoteFailure | null> => {
    try {
      await git(root, ['push', '--quiet', '--set-upstream', 'origin', name], transfer);
      return null;
    } catch (error) {
      return describeRemoteFailure(error, remote);
    }
  };

  try {
    if (probe.empty) {
      await setOrigin();
      let pushed = false;
      if (head !== null) {
        const failure = await push(branch);
        if (failure !== null) {
          await rollback.run();
          return fail(failure, remote);
        }
        pushed = true;
        rollback.commit();
        await git(root, ['remote', 'set-head', 'origin', branch], quick, true);
        await checkRemoteHead(root, branch, options, warnings);
      }
      rollback.commit();
      return {
        ...base,
        ok: true,
        case: 'connected',
        message: pushed
          ? `Remoto ${shownRemote} ligado; o cérebro foi enviado na branch ${branch}.`
          : `Remoto ${shownRemote} ligado.`,
        branch,
        remote: shownRemote,
        relation: 'empty',
        pushed,
        nextSteps: [`Em outra máquina, rode cabecao init ${shownRemote}.`],
      };
    }

    const remoteBranch = probe.defaultBranch ?? branch;
    try {
      await git(
        root,
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--',
          remote,
          `+refs/heads/${remoteBranch}:${PROBE_REF}`,
        ],
        transfer,
      );
    } catch (error) {
      return fail(describeRemoteFailure(error, remote), remote);
    }
    const remoteSha = await refValue(root, PROBE_REF, quick);
    if (remoteSha === null) throw new Error(`a branch ${remoteBranch} do remoto não foi baixada`);
    const relation = await relationTo(root, head, remoteSha, quick);

    if (relation === 'unrelated') {
      const detection = await detectRepoKind(root, { ref: PROBE_REF });
      return {
        ...base,
        ok: false,
        case: 'refused',
        message: `${shownRemote} já tem conteúdo sem nenhuma história em comum com este cérebro (${detection.reason}). Para não misturar históricos, nada foi alterado.`,
        branch,
        remote: shownRemote,
        relation,
        pushed: false,
        detection: { kind: detection.kind, reason: detection.reason, stats: detection.stats },
        nextSteps: [
          'Para ligar este cérebro, use um repositório vazio.',
          `Para usar o que já está nesse remoto, rode cabecao init ${shownRemote} --dir <outra pasta>.`,
        ],
      };
    }

    // mesma história: liga o remoto, adota o nome de branch dele e configura o upstream
    const upstreamKeys = [`branch.${branch}.remote`, `branch.${branch}.merge`];
    const upstreamBefore = await Promise.all(upstreamKeys.map((key) => configValue(root, key, quick)));
    const trackingRef = `refs/remotes/origin/${remoteBranch}`;
    const trackingBefore = await refValue(root, trackingRef, quick);
    await setOrigin();
    rollback.add(async () => {
      if (trackingBefore === null) await git(root, ['update-ref', '-d', trackingRef], quick, true);
      else await git(root, ['update-ref', trackingRef, trackingBefore], quick);
    });
    rollback.add(async () => {
      for (const [i, key] of upstreamKeys.entries()) await restoreConfig(root, key, upstreamBefore[i] ?? null, quick);
    });
    let localBranch = branch;
    if (remoteBranch !== branch && (await refValue(root, `refs/heads/${remoteBranch}`, quick)) === null) {
      await git(root, ['branch', '-m', branch, remoteBranch], quick);
      rollback.add(async () => {
        await git(root, ['branch', '-m', remoteBranch, branch], quick);
      });
      localBranch = remoteBranch;
      warnings.push({
        code: 'branch-renamed',
        message: `A branch local "${branch}" passou a se chamar "${remoteBranch}", o nome que o remoto usa.`,
      });
    }
    await git(root, ['update-ref', trackingRef, remoteSha], quick);
    await git(root, ['branch', `--set-upstream-to=origin/${remoteBranch}`, localBranch], quick);

    let pushed = false;
    if (relation === 'ahead') {
      const failure = await push(localBranch);
      if (failure !== null) {
        await rollback.run();
        return fail(failure, remote);
      }
      pushed = true;
    }
    rollback.commit();
    await git(root, ['remote', 'set-head', 'origin', remoteBranch], quick, true);
    const integrate = relation === 'behind' || relation === 'diverged';
    return {
      ...base,
      ok: true,
      case: 'connected',
      message: `Remoto ${shownRemote} ligado (branch ${remoteBranch}).${
        pushed
          ? ' Os commits locais foram enviados.'
          : integrate
            ? ' O remoto tem mudanças que ainda não estão aqui.'
            : ''
      }`,
      branch: localBranch,
      remote: shownRemote,
      relation,
      pushed,
      nextSteps: integrate ? ['Rode cabecao sync para integrar as mudanças do remoto.'] : [],
    };
  } catch (error) {
    await rollback.run();
    throw error;
  } finally {
    await git(root, ['update-ref', '-d', PROBE_REF], quick, true).catch(() => {});
  }
}
