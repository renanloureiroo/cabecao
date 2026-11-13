// Coleta do `doctor`: lê disco, git e (sem `--offline`) o remoto, sempre pelas funções do núcleo, e devolve os fatos
// que as verificações puras de `checks.ts` julgam. Nada aqui altera o cérebro; a única escrita possível é a criação
// do banco local quando o arquivo existe e é de outra versão (o núcleo refaz o banco ao abrir).
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type BrainConfig,
  checkRemoteVisibility,
  configFilePath,
  currentBranch,
  embeddingInputs,
  GitError,
  gitVersion,
  indexDbPath,
  indexStatus,
  isGitVersionSupported,
  isInvalidConfigError,
  LOCAL_DIR,
  listConflicts,
  MIN_GIT_VERSION,
  mergeGitattributes,
  mergeGitignore,
  openIndex,
  openIndexStore,
  probeRemote,
  REQUIRED_GITATTRIBUTES_LINES,
  REQUIRED_GITIGNORE_LINES,
  readBrainConfig,
  readLocalEmbeddingState,
  readMachineConfig,
  redactCredentials,
  remoteFailureMessage,
  runGit,
  SUPPORTED_SCHEMA_VERSION,
  syncLayout,
  syncStatus,
} from '@cabecao/core';
import { modelCacheStatus, runtimeStatus } from '@cabecao/embeddings';
import { homeDir, machineConfigDir, toCliError } from '../brain.ts';
import { embeddingProvider, embeddingsCacheDir, fakeEmbedderOn, specOf } from '../embeddings.ts';
import { CliError } from '../errors.ts';
import type { Location } from '../install-client/clients.ts';
import { resolveLaunch } from '../install-client/launch.ts';
import { detectClients, readRegistrations } from '../install-client/register.ts';
import type { CliIo } from '../types.ts';
import type { DoctorFacts, EmbeddingsFact, IndexFact, LockFact } from './checks.ts';

export type DoctorIo = Pick<CliIo, 'env' | 'platform' | 'homedir' | 'execPath' | 'binPath' | 'exec' | 'stderr'>;

export interface GatherOptions {
  /** A pasta do cérebro, ou o erro de não ter achado uma. */
  brain: { root: string } | { error: unknown };
  /** Não consulta o remoto (nem a verificação de repositório público). */
  offline: boolean;
  /** Não lê os arquivos dos clientes de IA. */
  skipClients?: boolean;
  /** `process.versions.node`. */
  nodeVersion: string;
  /** Tempo limite da consulta ao remoto. Padrão: 10 s. */
  probeTimeoutMs?: number;
  /** Nome desta máquina e teste de processo vivo, para as travas (trocados nos testes). */
  hostname?: string;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
}

export const DOCTOR_PROBE_TIMEOUT_MS = 10_000;

function messageOf(error: unknown): { message: string; hint?: string } {
  const converted = toCliError(error);
  const message = converted instanceof Error ? converted.message : String(converted);
  return converted instanceof CliError && converted.hint !== undefined
    ? { message, hint: converted.hint }
    : { message };
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function git(root: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runGit(args, { cwd: root, allowFailure: true });
  return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function repoFact(root: string): Promise<NonNullable<DoctorFacts['repo']>> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return { kind: 'error', message: `${root} não é um repositório git` };
  const head = await git(root, ['log', '-1', '--format=%ct', 'HEAD']);
  if (!head.ok) return { kind: 'error', message: `o repositório em ${root} ainda não tem nenhum commit` };
  const time = Number(head.stdout);
  return { kind: 'ok', branch: await currentBranch(root), headTime: Number.isFinite(time) ? time : null };
}

async function indexFact(root: string): Promise<IndexFact> {
  if (!existsSync(indexDbPath(root))) return { kind: 'missing' };
  try {
    const index = await openIndex(root);
    try {
      const status = indexStatus(index);
      return {
        kind: 'present',
        rebuilt: index.rebuilt,
        schemaVersion: status.schemaVersion,
        expectedSchemaVersion: status.expectedSchemaVersion,
        notes: status.notes,
        lastScanAt: status.lastScanAt,
      };
    } finally {
      index.close();
    }
  } catch (error) {
    return { kind: 'error', message: `não consegui abrir o banco local: ${messageOf(error).message}` };
  }
}

/** Busca por significado: configuração, estado desta máquina, runtime, modelo no cache e trechos sem vetor. */
async function embeddingsFact(io: DoctorIo, root: string, config: BrainConfig): Promise<EmbeddingsFact> {
  const embedding = config.embedding;
  if (embedding === undefined) return { kind: 'off' };
  const local = await readLocalEmbeddingState(root);
  const base = {
    model: embedding.model,
    variant: embedding.variant,
    revision: typeof embedding.revision === 'string' ? embedding.revision : null,
    enabledHere: !local.disabled,
    fake: fakeEmbedderOn(io),
  };
  let spec: ReturnType<typeof specOf>;
  let resolved: ReturnType<ReturnType<typeof embeddingProvider>['resolve']>;
  try {
    spec = specOf(embedding);
    resolved = embeddingProvider(io).resolve(embedding);
  } catch (error) {
    return { kind: 'invalid', ...base, message: messageOf(error).message };
  }
  const cache = embeddingsCacheDir(io);
  let runtime: Extract<EmbeddingsFact, { kind: 'configured' }>['runtime'] = null;
  let modelCached: boolean | null = null;
  if (!base.fake) {
    try {
      const status = await runtimeStatus({ cacheDir: cache });
      runtime = {
        installed: status.installed,
        upToDate: status.upToDate,
        backend: status.backend ?? null,
        problem: status.problem ?? null,
        dir: status.dir,
      };
      modelCached = (await modelCacheStatus(spec, { cacheDir: cache })).cached;
    } catch {
      runtime = null;
    }
  }
  let chunks: number | null = null;
  let pending: number | null = null;
  if (existsSync(indexDbPath(root))) {
    try {
      const index = await openIndex(root);
      let keys: string[];
      try {
        keys = embeddingInputs(index).map((input) => input.key);
      } finally {
        index.close();
      }
      const store = await openIndexStore(
        root,
        { model: resolved.model, variant: resolved.variant, recipe: resolved.recipe },
        { dims: resolved.dims },
      );
      const known = await store.listKeys();
      chunks = keys.length;
      pending = keys.filter((key) => !known.has(key)).length;
    } catch {
      pending = null;
    }
  }
  return { kind: 'configured', ...base, modelDir: resolved.modelDir, runtime, modelCached, chunks, pending };
}

async function lockFacts(root: string, options: GatherOptions): Promise<LockFact[]> {
  const dir = join(root, LOCAL_DIR, 'locks');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.lock'));
  } catch {
    return [];
  }
  const host = options.hostname ?? osHostname();
  const now = options.now?.() ?? Date.now();
  const alive = options.pidAlive ?? defaultPidAlive;
  const locks: LockFact[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue; // soltou enquanto líamos
    }
    let owner: LockFact['owner'] = null;
    try {
      const value = JSON.parse((await readOptional(path)) ?? '') as { pid?: unknown; host?: unknown };
      if (typeof value.pid === 'number' && typeof value.host === 'string') owner = { pid: value.pid, host: value.host };
    } catch {
      // trava vazia ou cortada: o dono morreu entre criar e escrever
    }
    locks.push({
      path,
      owner,
      ageMs: Math.max(0, now - mtime),
      alive: owner === null ? (now - mtime > 2_000 ? false : null) : owner.host === host ? alive(owner.pid) : null,
    });
  }
  return locks;
}

const GIT_OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

async function gitStateFacts(
  root: string,
  now: number,
): Promise<{ operation: string | null; indexLock: { path: string; ageMs: number } | null }> {
  const names = [...GIT_OPERATIONS.map(([name]) => name), 'index.lock'];
  const result = await git(root, ['rev-parse', ...names.flatMap((name) => ['--git-path', name])]);
  if (!result.ok) return { operation: null, indexLock: null };
  const paths = result.stdout.split('\n').map((line) => resolve(root, line.trim()));
  let operation: string | null = null;
  GIT_OPERATIONS.forEach(([, label], i) => {
    const path = paths[i];
    if (operation === null && path !== undefined && existsSync(path)) operation = label;
  });
  const lockPath = paths[GIT_OPERATIONS.length];
  let indexLock: { path: string; ageMs: number } | null = null;
  if (lockPath !== undefined) {
    try {
      indexLock = { path: lockPath, ageMs: Math.max(0, now - (await stat(lockPath)).mtimeMs) };
    } catch {
      indexLock = null;
    }
  }
  return { operation, indexLock };
}

async function identityFact(root: string): Promise<NonNullable<DoctorFacts['identity']>> {
  let ident = '';
  for (const name of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = await git(root, ['var', name]);
    if (!result.ok)
      return { kind: 'error', message: result.stderr.split('\n').slice(-2).join(' ') || 'sem nome ou e-mail' };
    // "Nome <email> 1700000000 -0300": a data não interessa
    ident ||= result.stdout.replace(/\s+\d+\s+[+-]\d{4}$/, '');
  }
  return { kind: 'ok', ident };
}

async function clientFacts(io: DoctorIo, root: string): Promise<NonNullable<DoctorFacts['clients']>> {
  const location: Location = { platform: io.platform, env: io.env, home: homeDir(io) };
  const detected = await detectClients(io, location);
  const launches = [await resolveLaunch(io, root, false), await resolveLaunch(io, root, true)];
  return { kind: 'read', detected, registrations: await readRegistrations(detected, location, launches) };
}

/** Coleta os fatos de um diagnóstico completo. Não lança: o que falhar vira um fato de erro. */
export async function gatherFacts(io: DoctorIo, options: GatherOptions): Promise<DoctorFacts> {
  const now = options.now?.() ?? Date.now();
  let gitFact: DoctorFacts['git'];
  try {
    const version = await gitVersion();
    gitFact = {
      kind: 'ok',
      version: `${version.major}.${version.minor}.${version.patch}`,
      supported: isGitVersionSupported(version),
      minimum: `${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}`,
    };
  } catch (error) {
    gitFact = { kind: 'error', message: messageOf(error).message };
  }
  const facts: DoctorFacts = {
    platform: io.platform,
    nodeVersion: options.nodeVersion,
    git: gitFact,
    brain:
      'root' in options.brain
        ? { kind: 'resolved', root: options.brain.root }
        : { kind: 'unresolved', ...messageOf(options.brain.error) },
  };
  if (facts.brain.kind !== 'resolved') return facts;
  const root = facts.brain.root;

  const configDir = machineConfigDir(io);
  try {
    const machine = await readMachineConfig(configDir);
    facts.machine = { kind: 'ok', name: machine?.machine ?? null, configPath: configFilePath(configDir) };
  } catch (error) {
    facts.machine = { kind: 'error', message: messageOf(error).message };
  }

  let brainConfig: BrainConfig;
  try {
    brainConfig = await readBrainConfig(root);
    facts.config = { kind: 'ok', schemaVersion: brainConfig.schemaVersion, supported: SUPPORTED_SCHEMA_VERSION };
  } catch (error) {
    const { message, hint } = messageOf(error);
    facts.config = {
      kind: 'error',
      // um `.cabecao.json` quebrado chega também pelo sync, commitado por outro cliente git: a mensagem diz o que é
      message: isInvalidConfigError(error)
        ? `a configuração do cérebro (.cabecao.json) está inválida: ${message}`
        : message,
      ...(hint === undefined ? {} : { hint }),
    };
    return facts;
  }
  if (gitFact.kind === 'error') return facts;
  facts.repo = await repoFact(root);
  if (facts.repo.kind === 'error') return facts;

  const [gitignore, gitattributes] = await Promise.all([
    readOptional(join(root, '.gitignore')),
    readOptional(join(root, '.gitattributes')),
  ]);
  facts.gitignore = {
    exists: gitignore !== null,
    missing: mergeGitignore(gitignore ?? '', REQUIRED_GITIGNORE_LINES).added,
  };
  facts.gitattributes = {
    exists: gitattributes !== null,
    missing: mergeGitattributes(gitattributes ?? '', REQUIRED_GITATTRIBUTES_LINES).added,
  };

  try {
    const status = await syncStatus(root);
    facts.remote = status.remote;
    facts.lastSync = status.lastSync;
    facts.syncRunning = status.running;
    facts.conflicts = await listConflicts(root);
  } catch (error) {
    io.stderr.write(`cabecao: doctor: não consegui ler o estado do sync: ${messageOf(error).message}\n`);
  }

  const remote = facts.remote;
  if (options.offline || remote === undefined || remote === null) {
    facts.probe = { kind: 'skipped' };
    facts.visibility = { kind: 'skipped' };
  } else {
    try {
      const probe = await probeRemote(remote.name, {
        cwd: root,
        timeoutMs: options.probeTimeoutMs ?? DOCTOR_PROBE_TIMEOUT_MS,
      });
      facts.probe = { kind: 'ok', branches: probe.branches };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      facts.probe = {
        kind: 'failed',
        category: error.category,
        message: remoteFailureMessage(error.category, remote.url),
        detail: redactCredentials(error.stderr.trim()).split('\n').slice(-4).join('\n'),
      };
    }
    try {
      const check = await checkRemoteVisibility(remote.url);
      facts.visibility = { kind: 'checked', ...check, url: remote.url };
    } catch {
      facts.visibility = { kind: 'checked', visibility: 'unknown', provider: null, url: remote.url };
    }
  }

  facts.index = await indexFact(root);
  facts.embeddings = await embeddingsFact(io, root, brainConfig);
  facts.locks = await lockFacts(root, options);
  const state = await gitStateFacts(root, now);
  facts.gitOperation = state.operation;
  facts.gitIndexLock = state.indexLock;
  facts.syncJournal = existsSync(syncLayout(root).journal);
  facts.gpgSign = (await git(root, ['config', '--type=bool', '--get', 'commit.gpgsign'])).stdout === 'true';
  facts.identity = await identityFact(root);
  facts.clients = options.skipClients === true ? { kind: 'skipped' } : await clientFacts(io, root);
  return facts;
}
