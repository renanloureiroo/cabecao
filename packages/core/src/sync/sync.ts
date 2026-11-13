// `syncBrain`: o algoritmo do doc 04 para o conteúdo (branch principal).
//
//   trava → recupera → commita edições de fora → busca → integra em memória → aplica de uma vez → envia
//                          ↑                                                                  │
//                          └──────────── envio recusado ou arquivo editado no meio ◀──────────┘
import { existsSync } from 'node:fs';
import { lstat, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { commitPaths, GitError, headSha, statusPorcelain } from '../git/index.ts';
import {
  fetchRemoteIndex,
  INDEX_REF_PATTERN,
  type IndexPushRef,
  indexManifestAt,
  indexPushRef,
  listIndexBranches,
  parseGenerationRef,
  recordIndexPushed,
  trackingRef,
} from '../indexstore/index.ts';
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
import { readBrainConfig, SUPPORTED_SCHEMA_VERSION, VaultError, writeIndexMd } from '../vault/index.ts';
import { CatalogCache, isCatalogNote, type NoteMeta, noteMetaFromText, renderCatalog } from './catalog.ts';
import { keepValidConfig, loadSyncConfig, newerSchemaIn } from './config-guard.ts';
import { commitMessage, type SyncContext } from './context.ts';
import { countCommits, git, gitText, handleGitLockError, isAncestor, listTree, revParse } from './git.ts';
import { integrateDiverged, UnrelatedHistoriesError, withCatalogCommit } from './integrate.ts';
import { atomicTempOwner, isSyncablePath, syncLayout } from './layout.ts';
import {
  fetchRemote,
  listRemoteRefs,
  MissingRemoteError,
  pushRefs,
  RemoteError,
  type RemoteTarget,
  resolveRemote,
} from './remote.ts';
import { SMALL_FILE_BYTES, scanFile, scanOutgoing, scanWorktreeFile } from './secrets.ts';
import { clearJournal, readState, recover, type SyncState, writeJournal, writeState } from './state.ts';
import type {
  SecretLocation,
  SyncChange,
  SyncConflict,
  SyncIndexResult,
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
  /** O arquivo existe (não foi apagado). */
  readonly present: boolean;
  /**
   * Conteúdo já lido: arquivos pequenos e links simbólicos (o git guarda o destino do link, não o arquivo apontado).
   * Arquivos grandes ficam `null` e são lidos aos pedaços pelo scanner.
   */
  readonly data: Buffer | null;
  /** Não deu para ler o arquivo (permissão, arquivo travado por outro programa): mensagem do sistema. */
  readonly unreadable?: string;
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Mudanças na pasta de trabalho que o sync põe no commit de edições feitas fora do Cabeção: tudo o que o git lista
 * (ele já respeita o `.gitignore`), menos `.cabecao/` e os temporários da escrita atômica (`isSyncablePath`).
 */
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
      if (!isSyncablePath(path)) continue;
      const file = join(ctx.root, ...path.split('/'));
      const change: SyncChange['change'] = added && path === entry.path ? 'added' : 'modified';
      let info: Awaited<ReturnType<typeof lstat>> | null;
      try {
        info = await lstat(file);
      } catch (error) {
        if (!isMissing(error)) {
          files.push({ path, change, present: true, data: null, unreadable: errorText(error) });
          continue;
        }
        info = null;
      }
      if (info === null) {
        if (!untracked) files.push({ path, change: 'deleted', present: false, data: null });
        continue; // não rastreado que sumiu desde o `git status`
      }
      // pasta (submódulo, repositório embutido) e arquivos especiais não são conteúdo do cérebro
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      try {
        const data = info.isSymbolicLink()
          ? await readlink(file, { encoding: 'buffer' })
          : info.size <= SMALL_FILE_BYTES
            ? await readFile(file)
            : null;
        files.push({ path, change, present: true, data });
      } catch (error) {
        if (isMissing(error)) {
          if (!untracked) files.push({ path, change: 'deleted', present: false, data: null });
        } else {
          files.push({ path, change, present: true, data: null, unreadable: errorText(error) });
        }
      }
    }
  }
  return files;
}

/** Scanner de segredos nas edições pendentes: todos os arquivos, de qualquer tipo e tamanho. */
async function scanPending(
  ctx: SyncContext,
  files: readonly PendingFile[],
): Promise<{ secrets: SecretLocation[]; unscannable: { path: string; reason: string }[] }> {
  const secrets: SecretLocation[] = [];
  const unscannable: { path: string; reason: string }[] = [];
  for (const file of files) {
    if (!file.present) continue;
    if (file.unreadable !== undefined) {
      unscannable.push({ path: file.path, reason: file.unreadable });
      continue;
    }
    if (file.data !== null) {
      secrets.push(...scanFile(file.path, file.data, 'pending').map(stripLine));
      continue;
    }
    const scanned = await scanWorktreeFile(join(ctx.root, ...file.path.split('/')), file.path, 'pending');
    if ('unscannable' in scanned) unscannable.push({ path: file.path, reason: scanned.unscannable });
    else secrets.push(...scanned.hits.map(stripLine));
  }
  return { secrets, unscannable };
}

function stripLine(hit: SecretLocation & { lineText?: string }): SecretLocation {
  return {
    path: hit.path,
    line: hit.line,
    column: hit.column,
    rule: hit.rule,
    description: hit.description,
    where: hit.where,
  };
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
): Promise<{ sha: string } | null | { retry: string }> {
  return withLock(
    ctx.layout.worktreeLock,
    async () => {
      const head = await headSha(ctx.root, { timeoutMs: ctx.timeoutMs });
      const overrides = new Map<string, NoteMeta | null>();
      for (const file of files) {
        if (!isCatalogNote(file.path, ctx.config)) continue;
        if (!file.present) {
          overrides.set(file.path, null);
          continue;
        }
        const data = file.data ?? (await readFile(join(ctx.root, ...file.path.split('/'))).catch(() => null));
        overrides.set(file.path, data === null ? null : noteMetaFromText(data.toString('utf8')));
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
        if (await handleGitLockError(ctx, error.stderr)) {
          await sleep(50);
          return { retry: 'outro programa git segurava o índice do repositório' };
        }
        const detail = error.stderr.trim().split('\n')[0] ?? '';
        return { retry: `o git recusou o commit das edições${detail === '' ? '' : ` (${detail})`}` };
      }
    },
    { timeoutMs: WORKTREE_LOCK_TIMEOUT_MS },
  );
}

type ApplyOutcome =
  | { kind: 'applied' }
  | { kind: 'refused'; detail: string; paths: string[] }
  | { kind: 'moved'; detail: string };

/** Caminhos que o `git reset --keep` (ou o `read-tree -m -u`) recusou sobrescrever, lidos da mensagem de erro. */
export function refusedPaths(stderr: string): string[] {
  const out = new Set<string>();
  for (const match of stderr.matchAll(/Entry '([^'\n]+)'/g)) if (match[1] !== undefined) out.add(match[1]);
  let listing = false;
  for (const line of stderr.split('\n')) {
    if (/would be (?:overwritten|removed|lost)/i.test(line) && line.trimEnd().endsWith(':')) {
      listing = true;
      continue;
    }
    if (listing && /^\t/.test(line)) out.add(line.trim());
    else listing = false;
  }
  return [...out];
}

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
        return { kind: 'moved', detail: 'a branch local recebeu commits durante o sync' };
      }
      const result =
        from === null
          ? await git(ctx, ['read-tree', '-m', '-u', to], { allowFailure: true })
          : await git(ctx, ['reset', '--keep', '--quiet', to], { allowFailure: true });
      if (result.exitCode !== 0) {
        await clearJournal(ctx.layout);
        if (/not uptodate|would be overwritten|Cannot merge|Could not reset index file/i.test(result.stderr)) {
          return {
            kind: 'refused',
            detail: result.stderr.trim().split('\n')[0] ?? '',
            paths: refusedPaths(result.stderr),
          };
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

interface TreeChange extends SyncChange {
  /** Blob (ou commit de submódulo) do lado de `to`; `null` quando o caminho sai. */
  readonly oid: string | null;
}

async function changesBetween(ctx: SyncContext, from: string | null, to: string): Promise<TreeChange[]> {
  if (from === null) {
    return (await listTree(ctx, to)).map((entry) => ({
      path: entry.path,
      change: 'added',
      origin: 'remote',
      oid: entry.oid,
    }));
  }
  const { stdout } = await git(ctx, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', from, to]);
  const tokens = stdout.split('\0');
  const out: TreeChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i] ?? '';
    const path = tokens[i + 1];
    if (!meta.startsWith(':') || path === undefined) continue;
    // ":<modo antigo> <modo novo> <sha antigo> <sha novo> <status>"
    const [, , , oid = '', status = ''] = meta.slice(1).split(' ');
    const kind = status.charAt(0);
    out.push({
      path,
      change: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified',
      origin: 'remote',
      oid: kind === 'D' ? null : oid,
    });
  }
  return out;
}

/**
 * Arquivos locais que a aplicação sobrescreveria sem perguntar: caminhos que o remoto passa a versionar e que aqui
 * existem com outro conteúdo SEM estar no git. O `reset --keep` (e o `read-tree -m -u`) recusa sobrescrever um
 * arquivo não rastreado comum, mas sobrescreve sem aviso um arquivo IGNORADO; e um arquivo em `.cabecao/` o sync
 * nunca commita. Esses vão em `blocking`. Os não rastreados comuns (criados depois do commit das edições) vão em
 * `fresh`: o próximo ciclo os commita e a integração preserva as duas versões.
 */
async function localFilesInTheWay(
  ctx: SyncContext,
  changes: readonly TreeChange[],
): Promise<{ blocking: string[]; fresh: string[] }> {
  const none = { blocking: [], fresh: [] };
  const existing: TreeChange[] = [];
  for (const change of changes) {
    if (change.change !== 'added' || change.oid === null) continue;
    try {
      const info = await lstat(join(ctx.root, ...change.path.split('/')));
      if (info.isFile() || info.isSymbolicLink()) existing.push(change);
    } catch {
      // não existe aqui: nada a sobrescrever
    }
  }
  if (existing.length === 0) return none;
  const hashed = await git(ctx, ['hash-object', '--stdin-paths'], {
    input: `${existing.map((change) => change.path).join('\n')}\n`,
    allowFailure: true,
  });
  const oids = hashed.exitCode === 0 ? hashed.stdout.split('\n') : [];
  const differing = existing.filter((change, i) => oids[i] !== change.oid).map((change) => change.path);
  if (differing.length === 0) return none;
  const checked = await git(ctx, ['check-ignore', '-z', '--stdin'], {
    input: `${differing.join('\0')}\0`,
    allowFailure: true,
  });
  const ignored = new Set(checked.stdout.split('\0').filter(Boolean));
  const blocking: string[] = [];
  const fresh: string[] = [];
  for (const path of differing) (ignored.has(path) || !isSyncablePath(path) ? blocking : fresh).push(path);
  return { blocking, fresh };
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${shown} e mais ${paths.length - 5}` : shown;
}

/** Por que um ciclo recomeçou, e o que o usuário faz se isso se repetir até o limite de tentativas. */
interface RetryCause {
  readonly cause: string;
  readonly action: string;
}

function editedDuringApply(paths: readonly string[]): RetryCause {
  const one = paths.length === 1;
  return {
    cause: `${listPaths(paths)} ${one ? 'foi alterado' : 'foram alterados'} nesta máquina enquanto o sync aplicava as mudanças do remoto, a cada tentativa`,
    action: `Feche (ou espere terminar) o programa que está gravando ${one ? 'nesse arquivo' : 'nesses arquivos'} e rode o sync de novo.`,
  };
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
  const index = result.index;
  if (index !== undefined) {
    if (index.received > 0) parts.push(plural(index.received, 'vetor recebido', 'vetores recebidos'));
    if (index.computed > 0) parts.push(plural(index.computed, 'vetor calculado', 'vetores calculados'));
    if (index.pushed > 0) parts.push(plural(index.pushed, 'vetor enviado', 'vetores enviados'));
  }
  const conflicts = result.conflicts.length;
  const tail =
    conflicts > 0
      ? ` ${plural(conflicts, 'conflito preservado', 'conflitos preservados')}: as duas versões ficaram no cérebro; resolva e apague a cópia .conflict-*.`
      : '';
  return parts.length === 0 && conflicts === 0 ? '' : `${parts.join(', ')}.${tail}`;
}

/** Geração corrente da branch de índice (local ou do remoto); `null` se não existe. */
async function indexGeneration(root: string): Promise<number | null> {
  const refs = await listIndexBranches(root);
  return refs.length === 0 ? null : Math.max(...refs.map((ref) => ref.generation));
}

/** Vetores que o envio de `pushed` leva: os do manifesto enviado menos os do que o remoto já tinha nessa geração. */
async function vectorsInPush(root: string, remote: string, pushed: IndexPushRef): Promise<number> {
  const generation = parseGenerationRef(pushed.ref);
  const sent = (await indexManifestAt(root, pushed.sha))?.vectors ?? 0;
  if (generation === null) return sent;
  const before = (await indexManifestAt(root, trackingRef(remote, generation)).catch(() => null))?.vectors ?? 0;
  return Math.max(0, sent - before);
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
    if (result.configProblem !== undefined && (await configValidNow(brainRoot))) {
      // a versão que chegou do remoto corrigiu o `.cabecao.json` daqui
      delete result.configProblem;
      result.message =
        `${result.message} O .cabecao.json desta pasta estava inválido; a versão recebida do remoto o corrigiu.`.trim();
    } else if (result.configProblem !== undefined) {
      result.message =
        `${result.message} Configuração inválida nesta pasta: ${result.configProblem} Corrija o .cabecao.json.`.trim();
    }
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

/** O `.cabecao.json` da pasta de trabalho vale agora. */
async function configValidNow(root: string): Promise<boolean> {
  try {
    await readBrainConfig(root);
    return true;
  } catch {
    return false;
  }
}

async function runSync(
  root: string,
  options: SyncOptions,
  result: SyncResult,
  state: SyncState,
  cache: CatalogCache,
): Promise<void> {
  const layout = syncLayout(root);
  // com o `.cabecao.json` daqui inválido, o sync roda com a última versão válida (é por ele que a correção chega)
  const loaded = await loadSyncConfig(root, LOCAL_TIMEOUT_MS);
  const config = loaded.config;
  if (loaded.problem !== undefined) result.configProblem = loaded.problem;
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
  /** Totais do índice somados entre os ciclos (um ciclo recomeça quando o envio é recusado). */
  const indexTotals = { received: 0, computed: 0, pushed: 0, graphWritten: false };
  const startHead = await revParse(ctx, 'HEAD^{commit}');
  const conflicts = new Map<string, SyncConflict>();
  let lastRetry: RetryCause | null = null;
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
      const { secrets, unscannable } = await scanPending(ctx, pending);
      if (unscannable.length > 0) {
        stop({
          status: 'blocked',
          reason: 'unscannable',
          message: `Não consegui ler ${plural(unscannable.length, 'arquivo', 'arquivos')} para procurar segredos (${unscannable
            .slice(0, 5)
            .map((item) => `${item.path}: ${item.reason}`)
            .join(
              '; ',
            )}${unscannable.length > 5 ? `; e mais ${unscannable.length - 5}` : ''}). Nada foi commitado nem enviado. Feche o programa que está usando o arquivo ou corrija a permissão dele (ou, se ele não deve ir para o remoto, ponha-o no .gitignore) e rode o sync de novo.`,
        });
      }
      if (secrets.length > 0) {
        stop({
          status: 'blocked',
          reason: 'secrets',
          secrets,
          message: `Possível segredo em ${plural(secrets.length, 'lugar', 'lugares')} (${describeSecrets(secrets)}). Nada foi commitado nem enviado. Remova o segredo, ou marque a linha com "cabecao:allow-secret" se não for um, e rode o sync de novo.`,
        });
      }
      const edit = await commitEdits(ctx, state, pending);
      if (edit !== null && 'retry' in edit) {
        lastRetry = {
          cause: `${edit.retry}, a cada tentativa`,
          action:
            'Se algum programa está gravando no cérebro sem parar (sincronizador de nuvem, editor com salvamento contínuo, outro cliente git), espere ele terminar ou feche-o e rode o sync de novo.',
        };
        continue;
      }
      if (edit !== null && 'sha' in edit) {
        result.committed++;
        cycle.push(...pending.map((file) => ({ path: file.path, change: file.change, origin: 'local' as const })));
      }
    }
    await ctx.fault('committed');

    // 2. Remoto: o conteúdo e, quando pedido, a branch de índice, numa listagem só.
    let up: string | null = null;
    let online = false;
    let indexFetchError: string | null = null;
    if (remote !== null) {
      try {
        const advertised =
          options.index === undefined
            ? undefined
            : await listRemoteRefs(ctx, remote, [`refs/heads/${remote.branch}`, INDEX_REF_PATTERN]);
        up = await fetchRemote(ctx, remote, advertised);
        online = true;
        delete result.remoteError;
        if (options.index !== undefined && advertised !== undefined) {
          await options.index.beforeFetch?.();
          const fetched = await fetchRemoteIndex(root, remote.name, {
            advertised,
            networkTimeoutMs: ctx.networkTimeoutMs,
            staleGitLockMs: ctx.staleGitLockMs,
          });
          if (!fetched.ok) {
            indexFetchError = `não consegui buscar a branch de índice (${fetched.category}: ${fetched.detail})`;
          }
        }
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
    if (target !== null && target !== head) {
      // o remoto foi atualizado por um Cabeção mais novo (`cabecao upgrade`): esta máquina não aplica nem envia nada
      const newer = await newerSchemaIn(ctx, target);
      if (newer !== null) {
        await flush(cycle);
        stop({
          status: 'blocked',
          reason: 'schema-too-new',
          message: `O cérebro no remoto foi atualizado para o esquema ${newer} por uma versão mais nova do Cabeção, e este Cabeção só entende até o ${SUPPORTED_SCHEMA_VERSION}. Nada do remoto foi aplicado e nada foi enviado; as mudanças desta máquina estão em commits locais. Atualize o Cabeção nesta máquina ("npm i -g cabecao@latest" ou "npx cabecao@latest") e rode o sync de novo.`,
        });
      }
      // um `.cabecao.json` inválido vindo do remoto não entra: fica o daqui, e o do remoto vira cópia de conflito
      const guarded = await keepValidConfig(ctx, head, target);
      if (guarded !== null) {
        target = guarded.commit;
        created++;
        integrated = [...integrated, guarded.conflict];
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
      const changes = await changesBetween(ctx, head, target);
      const inTheWay = await localFilesInTheWay(ctx, changes);
      if (inTheWay.blocking.length > 0) {
        await flush(cycle);
        stop({
          status: 'blocked',
          reason: 'local-file',
          message: `O remoto passou a versionar ${listPaths(inTheWay.blocking)}, que nesta máquina ${inTheWay.blocking.length === 1 ? 'existe' : 'existem'} com outro conteúdo fora do git (ignorado pelo .gitignore ou dentro de .cabecao/). Para não sobrescrever ${inTheWay.blocking.length === 1 ? 'esse arquivo' : 'esses arquivos'}, nada do remoto foi aplicado e nada foi enviado. Renomeie ou mova o arquivo local (ou apague-o, se for descartável) e rode o sync de novo.`,
        });
      }
      if (inTheWay.fresh.length > 0) {
        lastRetry = editedDuringApply(inTheWay.fresh);
        await flush(cycle);
        continue;
      }
      const applied = await applyTarget(ctx, branch, head, target);
      if (applied.kind === 'refused') {
        await flush(cycle);
        const stuck = applied.paths.filter((path) => !isSyncablePath(path));
        if (stuck.length > 0) {
          stop({
            status: 'blocked',
            reason: 'local-file',
            message: `O remoto mudou ${listPaths(stuck)}, que nesta máquina tem uma alteração que o sync não versiona (dentro de .cabecao/ ou .git/). Nada do remoto foi aplicado e nada foi enviado. Mova essa alteração para fora daí (ou desfaça-a) e rode o sync de novo.`,
          });
        }
        lastRetry =
          applied.paths.length > 0
            ? editedDuringApply(applied.paths)
            : {
                cause: `o git recusou atualizar a pasta de trabalho a cada tentativa (${applied.detail})`,
                action:
                  'Rode "git status" no cérebro para ver o arquivo em uso, feche o programa que o usa e rode o sync de novo.',
              };
        continue;
      }
      if (applied.kind === 'moved') {
        lastRetry = {
          cause: `${applied.detail}, a cada tentativa`,
          action:
            'Espere as escritas em andamento terminarem (agentes gravando, outro cliente git) e rode o sync de novo.',
        };
        await flush(cycle);
        continue;
      }
      cycle.push(...changes.map(({ path, change, origin }) => ({ path, change, origin })));
    }
    result.committed += created;
    if (integration !== 'none' && up !== null) {
      result.pulled = await countCommits(ctx, up, ...(startHead === null ? [] : ['--not', startHead]));
      if (INTEGRATION_RANK[integration] > INTEGRATION_RANK[result.integration]) result.integration = integration;
      for (const conflict of integrated) conflicts.set(`${conflict.path}\0${conflict.copy ?? ''}`, conflict);
      result.conflicts = [...conflicts.values()];
    }
    await flush(cycle);

    // 4b. Índice: junta a branch de índice com a do remoto, calcula os vetores que faltam e grava o grafo exportado.
    let indexReady = false;
    if (options.index !== undefined) {
      let update: Awaited<ReturnType<typeof options.index.update>>;
      try {
        update = await options.index.update({
          remote: remote?.name ?? null,
          online: online && indexFetchError === null,
          contentCommit: target,
        });
      } catch (error) {
        update = {
          participating: true,
          received: 0,
          computed: 0,
          pending: null,
          graphWritten: false,
          skipped: null,
          error: errorText(error),
        };
      }
      indexTotals.received += update.received;
      indexTotals.computed += update.computed;
      indexTotals.graphWritten ||= update.graphWritten;
      const index: SyncIndexResult = {
        ...update,
        received: indexTotals.received,
        computed: indexTotals.computed,
        graphWritten: indexTotals.graphWritten,
        pushed: indexTotals.pushed,
        error: update.error ?? indexFetchError,
        generation: update.participating ? await indexGeneration(root) : null,
      };
      result.index = index;
      indexReady = index.participating && indexFetchError === null && update.error === null;
    }

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
    const indexRef = local !== null && indexReady ? await indexPushRef(root, remote.name) : null;
    const contentOut = local !== null && local !== up;
    if (local === null || (!contentOut && indexRef === null)) {
      result.message = summary(result) || 'Nada a sincronizar: o cérebro já está igual ao remoto.';
      return;
    }
    let sending = 0;
    if (contentOut) {
      const outgoing = uniqueSecrets(await scanOutgoing(ctx, up, local));
      if (outgoing.length > 0) {
        stop({
          status: 'blocked',
          reason: 'secrets',
          secrets: outgoing,
          message: `Possível segredo em ${plural(outgoing.length, 'lugar', 'lugares')} de commits que seriam enviados (${describeSecrets(outgoing)}). Nada foi enviado. O segredo já está num commit local: tire-o do histórico (por exemplo desfazendo o commit) ou marque a linha com "cabecao:allow-secret" se não for um.`,
        });
      }
      sending = await countCommits(ctx, local, ...(up === null ? [] : ['--not', up]));
    }
    const indexVectors = indexRef === null ? 0 : await vectorsInPush(root, remote.name, indexRef);
    // conteúdo e índice no MESMO envio atômico (decisão 15); sem suporte a --atomic, o conteúdo vai por último
    const pushed = await pushRefs(ctx, remote.name, [
      ...(indexRef === null ? [] : [indexRef]),
      ...(contentOut ? [{ sha: local, ref: `refs/heads/${remote.branch}` }] : []),
    ]);
    if (pushed.ok) {
      await ctx.fault('pushed');
      if (contentOut) await git(ctx, ['update-ref', remote.trackingRef, local]);
      if (indexRef !== null) {
        await recordIndexPushed(root, remote.name, indexRef);
        indexTotals.pushed += indexVectors;
        if (result.index !== undefined) result.index.pushed = indexTotals.pushed;
      }
      result.pushed = sending;
      result.message = summary(result);
      return;
    }
    if (pushed.race) {
      lastRetry = {
        cause: 'outra máquina enviou antes desta, a cada tentativa',
        action: 'Rode o sync de novo daqui a pouco, quando a outra máquina terminar de enviar.',
      };
      continue;
    }
    result.remoteError = { category: pushed.error.category, detail: pushed.error.detail };
    stop({
      status: pushed.error.category === 'rejected' ? 'error' : 'offline',
      message: `O envio para ${remote.name} falhou: ${OFFLINE_HINT[pushed.error.category] ?? OFFLINE_HINT.unknown} (${pushed.error.detail}). As mudanças ficaram em commits locais.`,
    });
  }
  const last = lastRetry ?? {
    cause: 'o cérebro mudou a cada ciclo',
    action: 'Espere os programas que gravam no cérebro terminarem e rode o sync de novo.',
  };
  stop({
    status: 'error',
    message: `Desisti depois de ${plural(maxAttempts, 'tentativa', 'tentativas')}: ${last.cause}. Nada se perdeu: as edições daqui estão em commits locais. ${last.action}`,
  });
}
