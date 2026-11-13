// `cabecao upgrade`: aplica as migrações do esquema pendentes (doc 08, "Atualizar"; doc 03, "Versionamento do esquema").
//
// Ordem: recusa cérebro de esquema mais novo; exige a pasta de trabalho limpa e nada a enviar ou a receber do remoto
// (o que o git já sabe, sem rede); trava o sync e as escritas; cria o ponto de restauração (`cabecao/restore/...`);
// aplica cada migração em ordem, com UM commit por migração (ação `migrate`, todas com o mesmo `Cabecao-Session`, de
// modo que `cabecao undo --session <id>` desfaz a atualização inteira). Rodar de novo, já atualizado, não faz nada.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  commitPaths,
  createRestorePoint,
  formatCommitMessage,
  type RestorePoint,
  restorePointName,
  runGit,
} from '../git/index.ts';
import { syncLayout } from '../sync/layout.ts';
import {
  acquireLock,
  defaultMachineName,
  isSafeRelativePath,
  isValidMachineName,
  type LockHandle,
  LockTimeoutError,
  readMachineConfig,
  sanitizeMachineName,
  ulid,
  writeFileAtomic,
} from '../util/index.ts';
import { BRAIN_CONFIG_FILE, SUPPORTED_SCHEMA_VERSION } from '../vault/index.ts';
import { MIGRATIONS, type Migration, type MigrationChange, type MigrationTree } from './migrations.ts';

export type MigrationErrorCode =
  | 'not_a_brain'
  | 'invalid_config'
  | 'schema_too_new'
  | 'not_a_repo'
  | 'dirty'
  | 'unsynced'
  | 'busy'
  | 'broken_chain'
  | 'unsafe_change'
  | 'migration_failed';

/** Recusa ou falha do `upgrade`, com o que fazer. `code` é estável (vai para `--json`). */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly hint: string | undefined;

  constructor(code: MigrationErrorCode, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
    this.code = code;
    this.hint = hint;
  }
}

const UPDATE_HINT =
  'Atualize o Cabeção nesta máquina e rode de novo ("cabecao doctor" mostra o comando para a sua instalação).';

/** `schemaVersion` cru do `.cabecao.json`, sem a validação completa (que recusaria um esquema mais novo). */
export async function readSchemaVersion(root: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(root, BRAIN_CONFIG_FILE), 'utf8');
  } catch {
    throw new MigrationError('not_a_brain', `não achei ${BRAIN_CONFIG_FILE} em ${root}: a pasta não é um cérebro`);
  }
  return schemaVersionOf(text);
}

function schemaVersionOf(text: string): number {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new MigrationError(
      'invalid_config',
      `${BRAIN_CONFIG_FILE} não é JSON válido`,
      'Corrija o arquivo e rode de novo.',
    );
  }
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MigrationError(
      'invalid_config',
      `${BRAIN_CONFIG_FILE}: "schemaVersion" deveria ser um inteiro a partir de 1`,
    );
  }
  return version;
}

/**
 * Migrações que levam `from` até `supported`, em ordem. Lança `broken_chain` se a lista tiver buraco ou salto (um
 * defeito do próprio Cabeção, pego pelos testes).
 */
export function pendingMigrations(
  from: number,
  migrations: readonly Migration[] = MIGRATIONS,
  supported: number = SUPPORTED_SCHEMA_VERSION,
): Migration[] {
  const chain: Migration[] = [];
  let at = from;
  while (at < supported) {
    const next = migrations.find((migration) => migration.from === at);
    if (next === undefined || next.to !== at + 1) {
      throw new MigrationError('broken_chain', `não há migração do esquema ${at} para o ${at + 1}`);
    }
    chain.push(next);
    at = next.to;
  }
  return chain;
}

/** O `.cabecao.json` com o `schemaVersion` novo; as outras chaves ficam como estavam, na mesma ordem. */
export function withSchemaVersion(text: string, version: number): string {
  const value = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
  value.schemaVersion = version;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertSafeChange(change: MigrationChange, migration: Migration): void {
  const path: unknown = change?.path;
  const first = typeof path === 'string' ? (path.split('/')[0] ?? '') : '';
  if (
    typeof path !== 'string' ||
    !isSafeRelativePath(path) ||
    path.includes('\\') ||
    first === '.git' ||
    first === '.cabecao' ||
    (change.content !== null && typeof change.content !== 'string')
  ) {
    throw new MigrationError(
      'unsafe_change',
      `a migração ${migration.from}→${migration.to} quis mexer num caminho que não pode: ${JSON.stringify(path)}`,
    );
  }
}

/** Aplica uma migração à árvore em memória (função pura): devolve a árvore nova e as mudanças efetivas. */
export function applyMigration(
  tree: MigrationTree,
  migration: Migration,
): { tree: Map<string, string>; changes: MigrationChange[] } {
  const next = new Map(tree);
  const changes: MigrationChange[] = [];
  for (const change of migration.migrate(tree)) {
    assertSafeChange(change, migration);
    const before = next.get(change.path);
    if (change.content === null ? before === undefined : before === change.content) continue;
    if (change.content === null) next.delete(change.path);
    else next.set(change.path, change.content);
    changes.push({ path: change.path, content: change.content });
  }
  const config = next.get(BRAIN_CONFIG_FILE);
  if (config !== undefined) next.set(BRAIN_CONFIG_FILE, withSchemaVersion(config, migration.to));
  return { tree: next, changes };
}

/** Arquivos de texto versionados (o que o git rastreia; binários e arquivos acima de 8 MB ficam de fora). */
export async function readMigrationTree(root: string): Promise<Map<string, string>> {
  const listed = await runGit(['ls-files', '-z'], { cwd: root });
  const tree = new Map<string, string>();
  for (const path of listed.stdout.split('\0').filter(Boolean)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, ...path.split('/')));
    } catch {
      continue;
    }
    if (bytes.length > 8 * 1024 * 1024 || bytes.includes(0)) continue;
    tree.set(path, bytes.toString('utf8'));
  }
  return tree;
}

export interface UpgradeOptions {
  /** Só calcula: não trava, não grava, não commita. */
  readonly dryRun?: boolean;
  /** Lista de migrações (testes). Padrão: `MIGRATIONS`. */
  readonly migrations?: readonly Migration[];
  /** Esquema deste Cabeção (testes). Padrão: `SUPPORTED_SCHEMA_VERSION`. */
  readonly supported?: number;
  readonly machine?: string;
  readonly client?: string;
  readonly now?: () => Date;
}

export interface UpgradeStep {
  readonly from: number;
  readonly to: number;
  readonly description: string;
  /** Arquivos mudados, sem contar o `.cabecao.json` (que sempre muda: é o `schemaVersion`). */
  readonly changes: ReadonlyArray<{ readonly path: string; readonly change: 'write' | 'delete' }>;
  readonly op: string | null;
  readonly commit: string | null;
}

export interface UpgradeResult {
  readonly status: 'up_to_date' | 'planned' | 'upgraded';
  readonly from: number;
  readonly to: number;
  readonly supported: number;
  readonly steps: readonly UpgradeStep[];
  readonly restorePoint: RestorePoint | null;
  /** Sessão comum a todos os commits: `cabecao undo --session <id>` desfaz a atualização inteira. */
  readonly session: string | null;
  /** Avisos que não impedem (por exemplo, o remoto não foi consultado). */
  readonly notes: readonly string[];
}

/** Recusa esquema mais novo que o deste Cabeção. */
export function assertNotTooNew(version: number, supported: number = SUPPORTED_SCHEMA_VERSION): void {
  if (version > supported) {
    throw new MigrationError(
      'schema_too_new',
      `este cérebro está no esquema ${version}, e este Cabeção só entende até o ${supported}`,
      UPDATE_HINT,
    );
  }
}

async function gitCount(root: string, range: string): Promise<number | null> {
  const result = await runGit(['rev-list', '--count', range], { cwd: root, allowFailure: true });
  return result.exitCode === 0 ? Number(result.stdout.trim()) : null;
}

/** Pasta limpa e sem nada a enviar ou receber (pelo que o git já sabe). Devolve as observações. */
async function assertCleanAndSynced(root: string): Promise<string[]> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: root, allowFailure: true });
  if (inside.exitCode !== 0) throw new MigrationError('not_a_repo', `${root} não é um repositório git`);
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
  const dirty = status.stdout.split('\0').filter((entry) => entry.length > 3);
  if (dirty.length > 0) {
    const sample = dirty
      .slice(0, 5)
      .map((entry) => entry.slice(3))
      .join(', ');
    throw new MigrationError(
      'dirty',
      `o cérebro tem ${dirty.length} ${dirty.length === 1 ? 'mudança' : 'mudanças'} fora de commit (${sample}${dirty.length > 5 ? ', ...' : ''})`,
      'Rode "cabecao sync" (que põe as mudanças num commit e sincroniza) e depois "cabecao upgrade" de novo.',
    );
  }
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: root,
    allowFailure: true,
  });
  if (upstream.exitCode !== 0) return ['sem remoto configurado: a atualização fica só nesta máquina'];
  const ahead = await gitCount(root, '@{upstream}..HEAD');
  const behind = await gitCount(root, 'HEAD..@{upstream}');
  if ((ahead ?? 0) > 0 || (behind ?? 0) > 0) {
    throw new MigrationError(
      'unsynced',
      `o cérebro não está sincronizado (${ahead ?? '?'} commit(s) a enviar, ${behind ?? '?'} a receber)`,
      'Rode "cabecao sync" e depois "cabecao upgrade" de novo: a migração tem de partir da versão mais nova de todas as máquinas.',
    );
  }
  return [`o remoto não foi consultado agora; o último "cabecao sync" é a referência (${upstream.stdout.trim()})`];
}

export async function upgradeMachineName(option: string | undefined): Promise<string> {
  if (option !== undefined) return isValidMachineName(option) ? option : sanitizeMachineName(option);
  try {
    return (await readMachineConfig())?.machine ?? defaultMachineName();
  } catch {
    return defaultMachineName();
  }
}

/** Modelo do assunto dos commits configurado no cérebro (`commit.message`/`commit.dateFormat`), se houver. */
export function commitTemplate(configText: string): { subjectTemplate?: string; dateFormat?: string } {
  try {
    const commit = (JSON.parse(configText.replace(/^﻿/, '')) as { commit?: Record<string, unknown> }).commit;
    return {
      ...(typeof commit?.message === 'string' && commit.message.trim() !== ''
        ? { subjectTemplate: commit.message }
        : {}),
      ...(typeof commit?.dateFormat === 'string' && commit.dateFormat.trim() !== ''
        ? { dateFormat: commit.dateFormat }
        : {}),
    };
  } catch {
    return {};
  }
}

const stepOf = (
  migration: Migration,
  changes: readonly MigrationChange[],
  op: string | null,
  commit: string | null,
): UpgradeStep => ({
  from: migration.from,
  to: migration.to,
  description: migration.description,
  changes: changes
    .filter((change) => change.path !== BRAIN_CONFIG_FILE)
    .map((change) => ({ path: change.path, change: change.content === null ? 'delete' : 'write' }) as const),
  op,
  commit,
});

/**
 * Aplica as migrações pendentes de `root`. Lança `MigrationError` nas recusas (esquema mais novo, pasta suja, cérebro
 * fora de sincronia, sync em andamento) e quando uma migração falha: as anteriores ficam commitadas, e o ponto de
 * restauração volta tudo.
 */
export async function upgradeBrain(root: string, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const supported = options.supported ?? SUPPORTED_SCHEMA_VERSION;
  const from = await readSchemaVersion(root);
  assertNotTooNew(from, supported);
  const chain = pendingMigrations(from, options.migrations ?? MIGRATIONS, supported);
  if (chain.length === 0) {
    return { status: 'up_to_date', from, to: from, supported, steps: [], restorePoint: null, session: null, notes: [] };
  }

  if (options.dryRun === true) {
    let tree: Map<string, string> = await readMigrationTree(root);
    const steps: UpgradeStep[] = [];
    for (const migration of chain) {
      const applied = applyMigration(tree, migration);
      tree = applied.tree;
      steps.push(stepOf(migration, applied.changes, null, null));
    }
    return { status: 'planned', from, to: supported, supported, steps, restorePoint: null, session: null, notes: [] };
  }

  const layout = syncLayout(root);
  const locks: LockHandle[] = [];
  try {
    for (const path of [layout.syncLock, layout.worktreeLock]) {
      try {
        locks.push(await acquireLock(path, { timeoutMs: 5000 }));
      } catch (error) {
        if (error instanceof LockTimeoutError) {
          throw new MigrationError(
            'busy',
            'um sync ou uma escrita está em andamento neste cérebro',
            'Espere terminar e rode "cabecao upgrade" de novo.',
            { cause: error },
          );
        }
        throw error;
      }
    }
    const notes = await assertCleanAndSynced(root);
    const now = options.now ?? (() => new Date());
    const session = ulid();
    const machine = await upgradeMachineName(options.machine);
    const client = options.client ?? 'cli';
    const restorePoint = await createRestorePoint(root, `${restorePointName(now())}-upgrade`);
    let tree: Map<string, string> = await readMigrationTree(root);
    const steps: UpgradeStep[] = [];
    for (const migration of chain) {
      let applied: { tree: Map<string, string>; changes: MigrationChange[] };
      try {
        applied = applyMigration(tree, migration);
      } catch (error) {
        if (error instanceof MigrationError) throw error;
        throw new MigrationError(
          'migration_failed',
          `a migração ${migration.from}→${migration.to} falhou: ${error instanceof Error ? error.message : String(error)}${steps.length > 0 ? `; as anteriores ficaram commitadas` : ''}`,
          `Nada desta migração foi gravado. Para voltar ao estado de antes da atualização: "git reset --hard ${restorePoint.tag}" no cérebro.`,
          { cause: error },
        );
      }
      for (const change of applied.changes) {
        const path = join(root, ...change.path.split('/'));
        if (change.content === null) await rm(path, { force: true });
        else await writeFileAtomic(path, change.content);
      }
      const configText = applied.tree.get(BRAIN_CONFIG_FILE);
      if (configText !== undefined) await writeFileAtomic(join(root, BRAIN_CONFIG_FILE), configText);
      const op = ulid();
      const paths = [...new Set([...applied.changes.map((change) => change.path), BRAIN_CONFIG_FILE])];
      const message = formatCommitMessage({
        ...commitTemplate(configText ?? ''),
        date: now(),
        action: 'migrate',
        numFiles: paths.length,
        body: [
          `migrate: ${migration.description} (esquema ${migration.from} → ${migration.to})`,
          ...applied.changes
            .filter((change) => change.path !== BRAIN_CONFIG_FILE)
            .slice(0, 50)
            .map((change) => `${change.content === null ? 'delete' : 'edit'}: ${change.path}`),
        ],
        trailers: { op, session, machine, client },
      });
      const commit = await commitPaths(root, paths, message);
      steps.push(stepOf(migration, applied.changes, op, commit));
      tree = applied.tree;
    }
    return { status: 'upgraded', from, to: supported, supported, steps, restorePoint, session, notes };
  } finally {
    for (const lock of locks.reverse()) await lock.release();
  }
}

/** Esquema e migrações pendentes de um cérebro, para o `status` e o `doctor`. Não lança: `null` se não deu para ler. */
export async function schemaState(
  root: string,
  supported: number = SUPPORTED_SCHEMA_VERSION,
): Promise<{ version: number; supported: number; pending: number; tooNew: boolean } | null> {
  try {
    const version = await readSchemaVersion(root);
    return { version, supported, pending: Math.max(0, supported - version), tooNew: version > supported };
  } catch {
    return null;
  }
}
