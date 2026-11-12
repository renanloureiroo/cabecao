// `undo` e `listOperations`: desfazer por `git revert`, sem reescrever histórico (doc 07, "Manutenção sem Pull
// Request"; doc 12, rodapés). As operações são achadas pelos rodapés `Cabecao-*`, nunca pelo texto do assunto.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommitChange, CommitTrailers } from '../git/index.ts';
import {
  COMMIT_ACTIONS,
  formatCommitMessage,
  GitError,
  GitStateError,
  headSha,
  parseCommitTrailers,
  revertCommits,
  runGit,
} from '../git/index.ts';
import { isUlid, ulid } from '../util/index.ts';
import { LOG_MD, readBrainConfig, writeIndexMd } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { machineName, rescan, withFreshIndex, withWriteLock } from './context.ts';
import type { IssueOutput } from './errors.ts';
import { BrainError, toBrainError } from './errors.ts';
import { catalogFromIndex, requireHead } from './write.ts';

/** Ações que contam como operação do Cabeção. `edit` (edição de fora), `sync`, `conflict` e `init` não contam. */
const OPERATION_ACTIONS: ReadonlySet<string> = new Set(
  COMMIT_ACTIONS.filter((action) => action !== 'edit' && action !== 'sync' && action !== 'conflict'),
);

export interface OperationInfo {
  /** ULID da operação (`Cabecao-Op`). */
  readonly op: string;
  /** SHA do commit. */
  readonly commit: string;
  /** Data do autor, ISO 8601. */
  readonly date: string;
  /** `add`, `update`, `revert`... (a primeira linha do corpo). */
  readonly action: string;
  /** Linhas do corpo: `add gotcha: título`. */
  readonly changes: readonly string[];
  readonly session: string | null;
  readonly client: string | null;
  readonly machine: string | null;
  /** Em commits de `undo`: as operações desfeitas. */
  readonly reverts: readonly string[];
  /** Já foi desfeita por um `undo` que continua valendo. */
  readonly undone: boolean;
  /** A operação de `undo` que a desfez. */
  readonly undone_by: string | null;
}

export interface ListOperationsInput {
  /** Padrão 20, máximo 200. */
  readonly limit?: number;
  /** Só as desta sessão (o identificador ou o começo dele). */
  readonly session?: string;
}

export interface ListOperationsOutput {
  /** Da mais nova para a mais antiga. */
  readonly operations: readonly OperationInfo[];
}

/**
 * Sem `op` nem `session`: desfaz a última operação do Cabeção (que pode ser um `undo`: desfazer um `undo` refaz a
 * operação). Com `op`: aquela operação (aceita o começo do ULID). Com `session`: tudo que a sessão gravou e que
 * ainda vale, num commit só.
 */
export interface UndoInput {
  readonly op?: string;
  readonly session?: string;
  /** Sessão de quem está pedindo o undo, para o rodapé `Cabecao-Session` do commit de revert. */
  readonly session_handle?: string;
}

export interface UndoneOperation {
  readonly op: string;
  readonly commit: string;
  readonly changes: readonly string[];
}

export interface UndoOutput {
  /** ULID da operação de undo (pode ser desfeita com outro `undo`). */
  readonly op: string;
  /** SHA do commit de revert; `null` quando desfazer não mudava nada. */
  readonly commit: string | null;
  readonly undone: readonly UndoneOperation[];
  /** Arquivos que o revert mudou. */
  readonly changed_paths: readonly string[];
  readonly warnings: readonly IssueOutput[];
  readonly next_step?: string;
}

interface LoggedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly date: string;
  readonly trailers: CommitTrailers;
  readonly changes: readonly string[];
  readonly action: string;
  undone: boolean;
  undoneBy: string | null;
}

const isOperation = (commit: LoggedCommit): boolean =>
  commit.parents.length <= 1 &&
  commit.trailers.op !== undefined &&
  commit.trailers.client !== 'manual' &&
  OPERATION_ACTIONS.has(commit.action);

/** Linhas do corpo: tudo entre o assunto e o parágrafo de rodapés. */
function bodyLines(message: string): string[] {
  const paragraphs = message
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/);
  if (paragraphs.length < 3) return [];
  return paragraphs
    .slice(1, -1)
    .flatMap((paragraph) => paragraph.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Commits com `Cabecao-Op` alcançáveis do HEAD, do mais novo para o mais antigo, já marcados como desfeitos ou não.
 * Um commit está desfeito quando um `undo` mais novo, que ele próprio não foi desfeito, o lista em `Cabecao-Reverts`.
 */
async function loadCommits(ctx: BrainContext): Promise<LoggedCommit[]> {
  const { stdout } = await runGit(
    ['log', '-z', '--fixed-strings', '--grep=Cabecao-Op:', '--format=%H%n%P%n%aI%n%B', 'HEAD'],
    { cwd: ctx.root },
  );
  const commits: LoggedCommit[] = [];
  const undoneBy = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    const [sha, parents, date, ...lines] = record.replace(/^\n+/, '').split('\n');
    if (!sha || parents === undefined || date === undefined) continue;
    const message = lines.join('\n');
    const trailers = parseCommitTrailers(message);
    if (trailers.op === undefined) continue;
    const changes = bodyLines(message);
    const commit: LoggedCommit = {
      sha,
      parents: parents.split(' ').filter((parent) => parent !== ''),
      date,
      trailers,
      changes,
      action: /^([a-z]+)/.exec(changes[0] ?? '')?.[1] ?? '',
      undone: false,
      undoneBy: null,
    };
    const by = undoneBy.get(trailers.op);
    if (by !== undefined) {
      commit.undone = true;
      commit.undoneBy = by;
    } else {
      for (const reverted of trailers.reverts) if (!undoneBy.has(reverted)) undoneBy.set(reverted, trailers.op);
    }
    commits.push(commit);
  }
  return commits;
}

function operationInfo(commit: LoggedCommit): OperationInfo {
  return {
    op: commit.trailers.op ?? '',
    commit: commit.sha,
    date: commit.date,
    action: commit.action,
    changes: commit.changes,
    session: commit.trailers.session ?? null,
    client: commit.trailers.client ?? null,
    machine: commit.trailers.machine ?? null,
    reverts: commit.trailers.reverts,
    undone: commit.undone,
    undone_by: commit.undoneBy,
  };
}

function identifier(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[0-9A-Za-z]{1,26}$/.test(value.trim())) {
    throw new BrainError('invalid_argument', `"${name}" deveria ser um ULID (ou o começo dele)`);
  }
  return value.trim().toUpperCase();
}

export async function listOperations(
  ctx: BrainContext,
  input: ListOperationsInput = {},
): Promise<ListOperationsOutput> {
  const session = identifier(input.session, 'session');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1)
    throw new BrainError('invalid_argument', '"limit" deveria ser um inteiro positivo');
  await requireHead(ctx);
  let commits: LoggedCommit[];
  try {
    commits = await loadCommits(ctx);
  } catch (error) {
    throw toBrainError(error);
  }
  const operations = commits
    .filter((commit) => isOperation(commit) && (session === undefined || commit.trailers.session?.startsWith(session)))
    .slice(0, Math.min(limit, 200))
    .map(operationInfo);
  return { operations };
}

/** Linha do corpo do commit de revert: `add gotcha: título` vira `revert gotcha: título`. */
function revertLine(change: string): string | CommitChange {
  const match = /^([a-z]+)(?: ([a-z_]+))?: (.+)$/.exec(change);
  if (match === null) return `revert: ${change}`;
  const [, , noteType, title = ''] = match;
  return noteType === undefined ? `revert: ${change}` : { action: 'revert', noteType, title };
}

/** Pattern de `.gitattributes` ancorado na raiz, entre aspas no estilo C quando precisa. */
function attributePattern(path: string): string {
  const anchored = `/${path}`;
  return /[\s"\\]/.test(anchored) ? `"${anchored.replace(/[\\"]/g, (char) => `\\${char}`)}"` : anchored;
}

/**
 * Ambiente para o `git revert`: um arquivo de atributos extra (`core.attributesFile`, por variável de ambiente, sem
 * tocar na configuração do usuário) que faz `index.md` e `log.md` usarem a mesclagem por união. São arquivos
 * derivados ou só de acréscimo: duas linhas vizinhas mudadas em operações diferentes não podem impedir o undo. O
 * `index.md` é regenerado logo depois, a partir do banco.
 */
async function revertEnv(dir: string, indexMd: string): Promise<Record<string, string>> {
  const file = join(dir, 'attributes');
  await writeFile(file, `${attributePattern(indexMd)} merge=union\n${attributePattern(LOG_MD)} merge=union\n`);
  const current = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '', 10);
  const n = Number.isInteger(current) && current > 0 ? current : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.attributesFile',
    [`GIT_CONFIG_VALUE_${n}`]: file,
  };
}

export async function undo(ctx: BrainContext, input: UndoInput = {}): Promise<UndoOutput> {
  const op = identifier(input.op, 'op');
  const session = identifier(input.session, 'session');
  if (op !== undefined && session !== undefined) {
    throw new BrainError('invalid_argument', 'informe "op" ou "session", não os dois');
  }
  const handle = input.session_handle;
  if (handle !== undefined && !isUlid(handle)) {
    throw new BrainError(
      'invalid_argument',
      '"session_handle" deveria ser o identificador devolvido pelo recall (ULID)',
    );
  }

  return withWriteLock(ctx, async () => {
    try {
      ctx.config = await readBrainConfig(ctx.root);
    } catch (error) {
      throw toBrainError(error);
    }
    await requireHead(ctx);
    let commits: LoggedCommit[];
    try {
      commits = await loadCommits(ctx);
    } catch (error) {
      throw toBrainError(error);
    }

    let targets: LoggedCommit[];
    if (op !== undefined) {
      targets = commits.filter((commit) => commit.trailers.op?.startsWith(op));
      const ops = new Set(targets.map((commit) => commit.trailers.op));
      if (targets.length === 0) {
        throw new BrainError('not_found', `nenhuma operação ${op} no histórico deste cérebro`, {
          nextStep: 'Veja as operações que podem ser desfeitas com listOperations (cabecao undo --list).',
        });
      }
      if (ops.size > 1) {
        throw new BrainError(
          'invalid_argument',
          `"${op}" é o começo de ${ops.size} operações; informe mais caracteres`,
          {
            details: { ops: [...ops].filter((value): value is string => value !== undefined) },
          },
        );
      }
      if (targets.some((commit) => commit.parents.length > 1)) {
        throw new BrainError('conflict', `a operação ${op} é um merge do sync; ela não é desfeita por revert`);
      }
      const undone = targets.find((commit) => commit.undone);
      if (undone !== undefined) {
        throw new BrainError(
          'already_undone',
          `a operação ${undone.trailers.op} já foi desfeita por ${undone.undoneBy}`,
          {
            details: { ops: [undone.trailers.op ?? '', undone.undoneBy ?? ''] },
            nextStep: `Para refazê-la, desfaça o undo: undo({ op: "${undone.undoneBy}" }).`,
          },
        );
      }
    } else if (session !== undefined) {
      targets = commits.filter(
        (commit) => isOperation(commit) && !commit.undone && commit.trailers.session?.startsWith(session),
      );
      if (targets.length === 0) {
        throw new BrainError('nothing_to_undo', `a sessão ${session} não tem operação que ainda valha`, {
          nextStep: 'Veja as operações com listOperations({ session }).',
        });
      }
    } else {
      const last = commits.find(isOperation);
      if (last === undefined) throw new BrainError('nothing_to_undo', 'não há operação do Cabeção para desfazer');
      targets = [last];
    }

    const reverted = [...new Set(targets.map((commit) => commit.trailers.op ?? ''))];
    const undoOp = ulid();
    const commit = ctx.config.commit;
    const message = formatCommitMessage({
      ...(commit?.message === undefined ? {} : { subjectTemplate: commit.message }),
      ...(commit?.dateFormat === undefined ? {} : { dateFormat: commit.dateFormat }),
      date: ctx.now(),
      action: 'revert',
      body: targets.flatMap((target) =>
        target.changes.length === 0 ? [`revert: operação ${target.trailers.op}`] : target.changes.map(revertLine),
      ),
      numFiles: 0,
      trailers: {
        op: undoOp,
        machine: await machineName(ctx),
        client: ctx.client,
        reverts: reverted,
        ...(handle === undefined ? {} : { session: handle }),
      },
    });

    const scratch = await mkdtemp(join(tmpdir(), 'cabecao-undo-'));
    let sha: string | null;
    try {
      sha = await revertCommits(
        ctx.root,
        targets.map((target) => target.sha),
        message,
        { env: await revertEnv(scratch, ctx.config.indexMd) },
      );
    } catch (error) {
      if (error instanceof GitError || error instanceof GitStateError) {
        const staged = error instanceof GitStateError;
        throw new BrainError(
          'conflict',
          staged
            ? `não dá para desfazer agora: ${error.message}`
            : 'não dá para desfazer sem conflito: as notas mudaram depois da operação (ou há edição sem commit nelas). Nada foi alterado.',
          {
            details: { ops: reverted },
            nextStep: staged
              ? 'Resolva o que está preparado no índice do git e tente de novo.'
              : 'Rode sync (que commita as edições de fora) e tente de novo, ou corrija a nota à mão com patch_page.',
            cause: error,
          },
        );
      }
      throw toBrainError(error);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }

    const warnings: IssueOutput[] = [];
    if (sha === null) {
      await rescan(ctx);
      return {
        op: undoOp,
        commit: null,
        undone: [],
        changed_paths: [],
        warnings,
        next_step: 'Desfazer não mudava nada: o conteúdo já estava como antes da operação.',
      };
    }

    // O catálogo do commit de revert vem da mesclagem por união; o certo sai do banco, no mesmo commit.
    try {
      const catalog = await withFreshIndex(ctx, () => catalogFromIndex(ctx));
      if (await writeIndexMd(ctx.root, ctx.config, catalog)) {
        await runGit(
          [
            '--literal-pathspecs',
            'commit',
            '--amend',
            '--no-edit',
            '--no-verify',
            '--no-gpg-sign',
            '--only',
            '--',
            ctx.config.indexMd,
          ],
          { cwd: ctx.root },
        );
        sha = (await headSha(ctx.root)) ?? sha;
      }
    } catch (error) {
      // o undo valeu; só o catálogo ficou para o próximo sync regenerar
      await runGit(['--literal-pathspecs', 'checkout', sha, '--', ctx.config.indexMd], {
        cwd: ctx.root,
        allowFailure: true,
      }).catch(() => undefined);
      await rescan(ctx).catch(() => undefined);
      warnings.push({
        severity: 'warning',
        code: 'catalog_not_updated',
        field: null,
        message: `o index.md não pôde ser regenerado (${error instanceof Error ? error.message : String(error)}); o próximo sync corrige`,
      });
    }

    const { stdout } = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha], { cwd: ctx.root });
    return {
      op: undoOp,
      commit: sha,
      undone: targets.map((target) => ({ op: target.trailers.op ?? '', commit: target.sha, changes: target.changes })),
      changed_paths: stdout.split('\0').filter((path) => path !== ''),
      warnings,
      next_step: `Para refazer, desfaça este undo: undo({ op: "${undoOp}" }).`,
    };
  });
}
