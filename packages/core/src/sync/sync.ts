// `syncBrain`: o algoritmo do doc 04 para o conteúdo (branch principal).
//
//   trava → recupera → commita edições de fora → busca → integra em memória → aplica de uma vez → envia
//                          ↑                                                                  │
//                          └──────────── envio recusado ou arquivo editado no meio ◀──────────┘
import { existsSync } from 'node:fs';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { commitPaths, GitError, headSha, statusPorcelain } from '../git/index.ts';
import {
  acquireLock,
  defaultMachineName,
  isValidMachineName,
  type LockHandle,
  LockTimeoutError,
  readMachineConfig,
  sanitizeMachineName,
  withLock,
} from '../util/index.ts';
import { readBrainConfig, VaultError, writeIndexMd } from '../vault/index.ts';
import { CatalogCache, isCatalogNote, type NoteMeta, noteMetaFromText, renderCatalog } from './catalog.ts';
import { commitMessage, type SyncContext } from './context.ts';
import { countCommits, diffNames, git, gitText, handleGitLockError, isAncestor, listTree, revParse } from './git.ts';
import { integrateDiverged, UnrelatedHistoriesError, withCatalogCommit } from './integrate.ts';
import { atomicTempOwner, isSyncablePath, syncLayout } from './layout.ts';
import { fetchRemote, MissingRemoteError, pushRefs, RemoteError, type RemoteTarget, resolveRemote } from './remote.ts';
import { scanFile, scanOutgoing } from './secrets.ts';
import { clearJournal, readState, recover, type SyncState, writeJournal, writeState } from './state.ts';
import type {
  SecretLocation,
  SyncChange,
  SyncConflict,
  SyncIntegration,
  SyncOptions,
  SyncResult,
  SyncStep,
} from './types.ts';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCK_TIMEOUT_MS = 250;
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_GIT_LOCK_MS = 30_000;
const LOCAL_TIMEOUT_MS = 60_000;
/** Espera pela trava curta da pasta de trabalho (uma escrita de nota a segura por milissegundos). */
const WORKTREE_LOCK_TIMEOUT_MS = 30_000;
/** Operações do git que outro cliente deixou pela metade. */
const IN_PROGRESS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

/** Encerra o sync com um resultado já preenchido (bloqueio, remoto fora do ar...). */
class Stop extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function machineName(option: string | undefined): Promise<string> {
  if (option !== undefined) return isValidMachineName(option) ? option : sanitizeMachineName(option);
  try {
    return (await readMachineConfig())?.machine ?? defaultMachineName();
  } catch {
    return defaultMachineName();
  }
}

interface PendingFile {
  readonly path: string;
  readonly change: SyncChange['change'];
  /** Conteúdo atual (arquivos que existem). */
  readonly data: Buffer | null;
}

/** Mudanças na pasta de trabalho que o sync põe no commit de edições feitas fora do Cabeção. */
async function collectPending(ctx: SyncContext, notes: string[]): Promise<PendingFile[]> {
  const entries = await statusPorcelain(ctx.root, { timeoutMs: ctx.timeoutMs });
  const seen = new Set<string>();
  const files: PendingFile[] = [];
  for (const entry of entries) {
    const untracked = entry.index === '?';
    const added = untracked || entry.index === 'A';
    for (const path of [entry.path, entry.origPath]) {
      if (path === undefined || seen.has(path)) continue;
      seen.add(path);
      const owner = atomicTempOwner(path);
      if (owner !== null) {
        // temporário de escrita atômica de um processo que morreu antes do rename
        if (owner !== process.pid && !pidAlive(owner)) {
          await rm(join(ctx.root, ...path.split('/')), { force: true });
          notes.push(`temporário abandonado removido: ${path}`);
        }
        continue;
      }
      if (!isSyncablePath(path, ctx.config)) continue;
      let data: Buffer | null = null;
      try {
        const file = join(ctx.root, ...path.split('/'));
        if ((await stat(file)).isFile()) data = await readFile(file);
      } catch {
        // apagado
      }
      if (data === null && untracked) continue; // sumiu desde o `git status`
      files.push({
        path,
        change: data === null ? 'deleted' : added && path === entry.path ? 'added' : 'modified',
        data,
      });
    }
  }
  return files;
}

function editMessage(ctx: SyncContext, files: readonly PendingFile[]): string {
  const listed = files
    .map((file) => file.path)
    .filter((path) => path !== ctx.config.indexMd)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = listed.length;
  const notes = listed.every((path) => path.toLowerCase().endsWith('.md'));
  const noun = notes
    ? n === 1
      ? 'nota alterada'
      : 'notas alteradas'
    : n === 1
      ? 'arquivo alterado'
      : 'arquivos alterados';
  return commitMessage(ctx, {
    action: 'edit',
    client: 'manual',
    numFiles: n,
    body:
      n === 0
        ? [`edit: ${ctx.config.indexMd} regenerado`]
        : [`edit: ${n} ${noun} fora do Cabeção`, ...listed.map((p) => `- ${p}`)],
  });
}

/**
 * Um commit só com as edições feitas fora do Cabeção (padrão `edit` do doc 12), com o catálogo já regenerado na
 * mesma árvore. Devolve `null` quando nada mudou de fato e `retry` quando a pasta mudou no meio.
 */
async function commitEdits(
  ctx: SyncContext,
  state: SyncState,
  files: readonly PendingFile[],
): Promise<{ sha: string } | null | 'retry'> {
  return withLock(
    ctx.layout.worktreeLock,
    async () => {
      const head = await headSha(ctx.root, { timeoutMs: ctx.timeoutMs });
      const overrides = new Map<string, NoteMeta | null>();
      for (const file of files) {
        if (!isCatalogNote(file.path, ctx.config)) continue;
        overrides.set(file.path, file.data === null ? null : noteMetaFromText(file.data.toString('utf8')));
      }
      const catalog = await renderCatalog(ctx, head === null ? [] : await listTree(ctx, head), overrides);
      await writeIndexMd(ctx.root, ctx.config, catalog);
      const paths = [...new Set([...files.map((file) => file.path), ctx.config.indexMd])];
      try {
        const sha = await commitPaths(ctx.root, paths, editMessage(ctx, files), { timeoutMs: ctx.timeoutMs });
        if (sha === null) return null;
        state.catalogOk = sha;
        return { sha };
      } catch (error) {
        if (!(error instanceof GitError) || error.timedOut) throw error;
        // outro git segurando o índice, ou um arquivo que sumiu entre o `status` e o `add`: o ciclo recomeça
        if (await handleGitLockError(ctx, error.stderr)) await sleep(50);
        return 'retry';
      }
    },
    { timeoutMs: WORKTREE_LOCK_TIMEOUT_MS },
  );
}

type ApplyOutcome = { kind: 'applied' } | { kind: 'refused'; detail: string };

/**
 * Leva a branch e a pasta de trabalho de `from` para `to` de uma vez (`git reset --keep`). O `reset --keep`
 * confere tudo antes de escrever: se um arquivo que muda tem edição local (o Obsidian salvou durante o sync), ele
 * recusa sem mudar nada, e o ciclo recomeça commitando essa edição. Arquivos que não mudam ficam como estão.
 */
async function applyTarget(ctx: SyncContext, branch: string, from: string | null, to: string): Promise<ApplyOutcome> {
  await writeJournal(ctx.layout, { kind: 'apply', branch, from, to, pid: process.pid, at: Date.now() });
  await ctx.fault('journaled');
  return withLock(
    ctx.layout.worktreeLock,
    async (): Promise<ApplyOutcome> => {
      if ((await revParse(ctx, 'HEAD^{commit}')) !== from) {
        await clearJournal(ctx.layout);
        return { kind: 'refused', detail: 'a branch local mudou durante o sync' };
      }
      const result =
        from === null
          ? await git(ctx, ['read-tree', '-m', '-u', to], { allowFailure: true })
          : await git(ctx, ['reset', '--keep', '--quiet', to], { allowFailure: true });
      if (result.exitCode !== 0) {
        await clearJournal(ctx.layout);
        if (/not uptodate|would be overwritten|Cannot merge|Could not reset index file/i.test(result.stderr)) {
          return { kind: 'refused', detail: result.stderr.trim().split('\n')[0] ?? '' };
        }
        throw new GitError({ args: result.args, exitCode: result.exitCode, stderr: result.stderr });
      }
      if (from === null) await git(ctx, ['update-ref', `refs/heads/${branch}`, to, '0'.repeat(to.length)]);
      await ctx.fault('applied');
      await clearJournal(ctx.layout);
      return { kind: 'applied' };
    },
    { timeoutMs: WORKTREE_LOCK_TIMEOUT_MS },
  );
}

async function changesBetween(ctx: SyncContext, from: string | null, to: string): Promise<SyncChange[]> {
  if (from === null) {
    return (await listTree(ctx, to)).map((entry) => ({ path: entry.path, change: 'added', origin: 'remote' }));
  }
  const kinds: Record<string, SyncChange['change']> = { A: 'added', D: 'deleted' };
  return (await diffNames(ctx, from, to)).map((entry) => ({
    path: entry.path,
    change: kinds[entry.status] ?? 'modified',
    origin: 'remote',
  }));
}

function uniqueSecrets(list: readonly SecretLocation[]): SecretLocation[] {
  const seen = new Set<string>();
  return list.filter((hit) => {
    const key = `${hit.path}\0${hit.line}\0${hit.column}\0${hit.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeSecrets(list: readonly SecretLocation[]): string {
  const shown = list.slice(0, 5).map((hit) => `${hit.path}:${hit.line}, regra ${hit.rule}`);
  return list.length > 5 ? `${shown.join('; ')}; e mais ${list.length - 5}` : shown.join('; ');
}

const INTEGRATION_RANK: Record<SyncIntegration, number> = { none: 0, 'fast-forward': 1, replay: 2, merge: 3 };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const OFFLINE_HINT: Record<string, string> = {
  auth: 'o remoto recusou a credencial ou não há credencial salva. Confira o acesso com "git fetch" no terminal (chave SSH, token ou gerenciador de credenciais)',
  network: 'não consegui falar com o remoto (sem rede, servidor fora do ar ou tempo esgotado)',
  'not-found': 'o remoto não foi encontrado: confira a URL com "git remote -v"',
  rejected: 'o remoto recusou o envio',
  unknown: 'o remoto respondeu com um erro inesperado',
};

function summary(result: SyncResult): string {
  const parts: string[] = [];
  if (result.committed > 0) parts.push(plural(result.committed, 'commit criado', 'commits criados'));
  if (result.pulled > 0) parts.push(plural(result.pulled, 'commit recebido', 'commits recebidos'));
  if (result.pushed > 0) parts.push(plural(result.pushed, 'commit enviado', 'commits enviados'));
  const conflicts = result.conflicts.length;
  const tail =
    conflicts > 0
      ? ` ${plural(conflicts, 'conflito preservado', 'conflitos preservados')}: as duas versões ficaram no cérebro; resolva e apague a cópia .conflict-*.`
      : '';
  return parts.length === 0 && conflicts === 0 ? '' : `${parts.join(', ')}.${tail}`;
}

/**
 * Sincroniza o conteúdo do cérebro com o remoto. Nunca lança por falha de operação: o resultado diz o que houve.
 *
 * Nada se perde: edições de fora viram commit antes de qualquer integração; a integração é calculada só com
 * objetos do git; a pasta de trabalho muda numa única operação que recusa sobrescrever arquivo editado; conflitos
 * viram cópias; o envio nunca força.
 */
export async function syncBrain(root: string, options: SyncOptions = {}): Promise<SyncResult> {
  const started = performance.now();
  const result: SyncResult = {
    status: 'ok',
    pulled: 0,
    pushed: 0,
    committed: 0,
    conflicts: [],
    changedPaths: [],
    attempts: 0,
    ms: 0,
    message: '',
    branch: null,
    remote: null,
    integration: 'none',
  };
  const finish = (): SyncResult => {
    result.ms = Math.round(performance.now() - started);
    return result;
  };

  let brainRoot: string;
  try {
    brainRoot = await realpath(root);
  } catch {
    result.status = 'error';
    result.message = `A pasta do cérebro não existe: ${root}`;
    return finish();
  }
  const layout = syncLayout(brainRoot);
  let lock: LockHandle;
  try {
    lock = await acquireLock(layout.syncLock, { timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      result.status = 'busy';
      result.message = `Outro sync já está em andamento${error.owner ? ` (processo ${error.owner.pid})` : ''}; nada foi feito.`;
    } else {
      result.status = 'error';
      result.message = `Não consegui criar a trava do sync em ${layout.syncLock}: ${error instanceof Error ? error.message : String(error)}`;
    }
    return finish();
  }

  let state: SyncState = {};
  const cache = new CatalogCache(layout.catalogCache);
  try {
    state = await readState(layout);
    await cache.load();
    await runSync(brainRoot, options, result, state, cache);
  } catch (error) {
    if (!(error instanceof Stop)) {
      result.status = 'error';
      if (error instanceof UnrelatedHistoriesError) {
        result.message =
          'O remoto tem um histórico sem nenhum commit em comum com este cérebro; o Cabeção não junta os dois sozinho.';
      } else if (error instanceof VaultError || error instanceof MissingRemoteError) {
        result.message = error.message;
      } else {
        result.message = `O sync falhou: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } finally {
    try {
      state.lastSync = { at: new Date().toISOString(), status: result.status, message: result.message };
      await writeState(layout, state);
      await cache.save();
    } catch {
      // estado é só informativo
    }
    await lock.release();
  }
  return finish();
}

async function runSync(
  root: string,
  options: SyncOptions,
  result: SyncResult,
  state: SyncState,
  cache: CatalogCache,
): Promise<void> {
  const layout = syncLayout(root);
  const config = await readBrainConfig(root);
  const ctx: SyncContext = {
    root,
    scratchDir: layout.dir,
    timeoutMs: LOCAL_TIMEOUT_MS,
    networkTimeoutMs: options.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
    staleGitLockMs: options.staleGitLockMs ?? DEFAULT_STALE_GIT_LOCK_MS,
    config,
    cache,
    layout,
    machine: await machineName(options.machine),
    client: options.client ?? 'cli',
    session: options.session,
    now: options.now ?? (() => new Date()),
    fault: async (step: SyncStep) => {
      await options.faultAt?.(step);
    },
  };
  const changed = new Set<string>();
  const stop: (patch: Partial<SyncResult>) => never = (patch) => {
    Object.assign(result, patch);
    throw new Stop();
  };

  await ctx.fault('locked');
  const gitDir = await gitText(ctx, ['rev-parse', '--absolute-git-dir']).catch(() =>
    stop({ status: 'error', message: `A pasta ${root} não é um repositório git.` }),
  );
  const recovered = await recover(ctx, layout, gitDir);
  if (recovered.length > 0) result.recovered = recovered;
  await ctx.fault('recovered');

  const branch = await gitText(ctx, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => null);
  result.branch = branch;
  if (branch === null) {
    stop({
      status: 'blocked',
      reason: 'detached-head',
      message:
        'O repositório está com HEAD solto (fora de uma branch); volte para a branch principal e rode o sync de novo.',
    });
  }
  const inProgress = IN_PROGRESS.filter((name) => existsSync(join(gitDir, name)));
  if (inProgress.length > 0) {
    stop({
      status: 'blocked',
      reason: 'git-operation',
      message: `Há uma operação do git em andamento no cérebro (${inProgress.join(', ')}), deixada por outro programa. Termine-a ou aborte-a (por exemplo "git rebase --abort") e rode o sync de novo; o Cabeção não mexe no conteúdo enquanto isso.`,
    });
  }
  const remote: RemoteTarget | null = await resolveRemote(ctx, branch, options.remote);
  result.remote = remote?.name ?? null;

  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const startHead = await revParse(ctx, 'HEAD^{commit}');
  const conflicts = new Map<string, SyncConflict>();
  let lastRetry = '';
  /** Registra o que mudou num ciclo e avisa quem reindexa. Chamado também quando o ciclo recomeça. */
  const flush = async (cycle: SyncChange[]): Promise<void> => {
    if (cycle.length === 0) return;
    for (const change of cycle) changed.add(change.path);
    result.changedPaths = [...changed].sort();
    await options.onApplied?.(cycle);
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;
    const cycle: SyncChange[] = [];
    const notes: string[] = [];

    // 1. Edições feitas fora do Cabeção: scanner de segredos e um commit só.
    const pending = await collectPending(ctx, notes);
    if (notes.length > 0) result.recovered = [...(result.recovered ?? []), ...notes];
    if (pending.length > 0) {
      const secrets = pending.flatMap((file) => (file.data === null ? [] : scanFile(file.path, file.data, 'pending')));
      if (secrets.length > 0) {
        stop({
          status: 'blocked',
          reason: 'secrets',
          secrets,
          message: `Possível segredo em ${plural(secrets.length, 'lugar', 'lugares')} (${describeSecrets(secrets)}). Nada foi commitado nem enviado. Remova o segredo, ou marque a linha com "cabecao:allow-secret" se não for um, e rode o sync de novo.`,
        });
      }
      const edit = await commitEdits(ctx, state, pending);
      if (edit === 'retry') {
        lastRetry = 'a pasta de trabalho mudou enquanto as edições eram commitadas';
        continue;
      }
      if (edit !== null) {
        result.committed++;
        cycle.push(...pending.map((file) => ({ path: file.path, change: file.change, origin: 'local' as const })));
      }
    }
    await ctx.fault('committed');

    // 2. Remoto.
    let up: string | null = null;
    let online = false;
    if (remote !== null) {
      try {
        up = await fetchRemote(ctx, remote);
        online = true;
        delete result.remoteError;
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        result.remoteError = { category: error.category, detail: error.detail };
      }
    }
    await ctx.fault('fetched');

    // 3. Integração em memória: só objetos novos no banco do git; a pasta de trabalho não muda.
    const head = await revParse(ctx, 'HEAD^{commit}');
    let target = head;
    let created = 0;
    let integration: SyncIntegration = 'none';
    let integrated: SyncConflict[] = [];
    if (online && up !== null && up !== head) {
      if (head === null || (await isAncestor(ctx, head, up))) {
        target = up;
        integration = 'fast-forward';
      } else if (!(await isAncestor(ctx, up, head))) {
        const merged = await integrateDiverged(ctx, up, head);
        target = merged.target;
        state.catalogOk = target;
        integration = merged.kind;
        created += merged.created;
        integrated = merged.conflicts;
      }
    }
    if (target !== null && state.catalogOk !== target) {
      const fixed = await withCatalogCommit(ctx, target);
      target = fixed.commit;
      state.catalogOk = target;
      if (fixed.created) created++;
    }
    await ctx.fault('integrated');

    // 4. Aplicação única.
    if (target !== null && target !== head) {
      const applied = await applyTarget(ctx, branch, head, target);
      if (applied.kind === 'refused') {
        lastRetry = applied.detail;
        await flush(cycle);
        continue;
      }
      cycle.push(...(await changesBetween(ctx, head, target)));
    }
    result.committed += created;
    if (integration !== 'none' && up !== null) {
      result.pulled = await countCommits(ctx, up, ...(startHead === null ? [] : ['--not', startHead]));
      if (INTEGRATION_RANK[integration] > INTEGRATION_RANK[result.integration]) result.integration = integration;
      for (const conflict of integrated) conflicts.set(`${conflict.path}\0${conflict.copy ?? ''}`, conflict);
      result.conflicts = [...conflicts.values()];
    }
    await flush(cycle);

    // 5. Envio.
    if (remote === null) {
      result.message = `Sem remoto configurado: as mudanças ficaram em commits locais. ${summary(result)}`.trim();
      return;
    }
    if (!online) {
      const category = result.remoteError?.category ?? 'unknown';
      stop({
        status: 'offline',
        message:
          `Remoto ${remote.name} indisponível: ${OFFLINE_HINT[category] ?? OFFLINE_HINT.unknown}. As mudanças ficaram em commits locais e vão no próximo sync. ${summary(result)}`.trim(),
      });
    }
    // depois da aplicação, a branch está em `target`
    const local = target;
    if (local === null || local === up) {
      result.message = summary(result) || 'Nada a sincronizar: o cérebro já está igual ao remoto.';
      return;
    }
    const outgoing = uniqueSecrets(await scanOutgoing(ctx, up, local));
    if (outgoing.length > 0) {
      stop({
        status: 'blocked',
        reason: 'secrets',
        secrets: outgoing,
        message: `Possível segredo em ${plural(outgoing.length, 'lugar', 'lugares')} de commits que seriam enviados (${describeSecrets(outgoing)}). Nada foi enviado. O segredo já está num commit local: tire-o do histórico (por exemplo desfazendo o commit) ou marque a linha com "cabecao:allow-secret" se não for um.`,
      });
    }
    const sending = await countCommits(ctx, local, ...(up === null ? [] : ['--not', up]));
    const pushed = await pushRefs(ctx, remote.name, [{ sha: local, ref: `refs/heads/${remote.branch}` }]);
    if (pushed.ok) {
      await ctx.fault('pushed');
      await git(ctx, ['update-ref', remote.trackingRef, local]);
      result.pushed = sending;
      result.message = summary(result);
      return;
    }
    if (pushed.race) {
      lastRetry = 'outra máquina enviou antes, a cada tentativa';
      continue;
    }
    result.remoteError = { category: pushed.error.category, detail: pushed.error.detail };
    stop({
      status: pushed.error.category === 'rejected' ? 'error' : 'offline',
      message: `O envio para ${remote.name} falhou: ${OFFLINE_HINT[pushed.error.category] ?? OFFLINE_HINT.unknown} (${pushed.error.detail}). As mudanças ficaram em commits locais.`,
    });
  }
  stop({
    status: 'error',
    message: `Desisti depois de ${plural(maxAttempts, 'tentativa', 'tentativas')}: ${lastRetry || 'o cérebro mudou a cada ciclo'}. Nada se perdeu; rode o sync de novo.`,
  });
}
