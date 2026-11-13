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
import type { Approval, ConfirmationFields, ConfirmOptions } from './confirm.ts';
import {
  approvedLine,
  approvedTrailer,
  candidateApproval,
  confirmationRequest,
  tokenOf,
  verifyConfirmToken,
} from './confirm.ts';
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
 * operação). Com `op`: aquela operação. Com `session`: tudo que a sessão gravou e que ainda vale, num commit só.
 *
 * Quem pede importa (`actor` do cérebro):
 * - o usuário (CLI) desfaz qualquer operação e pode dar só o começo do ULID, com pelo menos
 *   `MIN_HUMAN_ID_PREFIX` caracteres e sem ambiguidade;
 * - um agente (MCP) desfaz sem confirmação as operações de agentes que ele identifica pelo ULID COMPLETO (o `op`
 *   devolvido pela escrita, o `session_handle` do `recall`). Desfazer uma operação do usuário (`Cabecao-Client: cli`)
 *   ou dar só o começo do ULID é elevado (decisão 37): a primeira chamada devolve o resumo e o `confirm_token`, e só
 *   a segunda, com o token, desfaz. Sem argumento, um agente desfaz a operação de agente mais recente que ainda vale.
 *
 * Em nenhum caso alcança o que não é operação do Cabeção (edições de fora, sync, conflito, init).
 */
export interface UndoInput {
  readonly op?: string;
  readonly session?: string;
  /** Sessão de quem está pedindo o undo, para o rodapé `Cabecao-Session` do commit de revert. */
  readonly session_handle?: string;
  /** O token da primeira chamada, quando o undo é elevado (operação do usuário, ou o começo do ULID). */
  readonly confirm_token?: string;
}

export interface UndoneOperation {
  readonly op: string;
  readonly commit: string;
  readonly changes: readonly string[];
}

export interface UndoOutput extends ConfirmationFields {
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

/** Clientes que não são agentes: o usuário na CLI e as edições feitas fora do Cabeção. */
const HUMAN_CLIENTS: ReadonlySet<string> = new Set(['cli', 'manual']);

/** Um agente só desfaz operações de agentes; o usuário desfaz qualquer uma. */
const mayUndo = (ctx: BrainContext, commit: LoggedCommit): boolean =>
  ctx.actor === 'human' || (commit.trailers.client !== undefined && !HUMAN_CLIENTS.has(commit.trailers.client));

/** Menor começo de ULID que a CLI aceita em `--op` e `--session` (um agente sempre dá o ULID inteiro). */
export const MIN_HUMAN_ID_PREFIX = 8;

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

/**
 * Identificador de operação ou de sessão. `prefix`: quantos caracteres, no mínimo, valem como começo do ULID; `null`
 * exige o ULID inteiro (26 caracteres).
 */
function identifier(value: unknown, name: string, prefix: number | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (prefix === null) {
    if (!isUlid(text)) {
      throw new BrainError(
        'invalid_argument',
        `"${name}" deveria ser o identificador completo (ULID de 26 caracteres), como foi devolvido`,
        {
          nextStep:
            name === 'op'
              ? 'Use o "op" devolvido pela escrita (remember, write_page, patch_page) ou pelo undo, inteiro.'
              : 'Use o "session_handle" devolvido pelo recall, inteiro.',
        },
      );
    }
    return text;
  }
  if (!new RegExp(`^[0-9A-Z]{${prefix},26}$`).test(text)) {
    throw new BrainError(
      'invalid_argument',
      `"${name}" deveria ser um ULID ou o começo dele, com pelo menos ${prefix} caracteres`,
    );
  }
  return text;
}

/** O identificador casa com `full`: igual, ou o começo dele (com pelo menos `MIN_HUMAN_ID_PREFIX` caracteres). */
const matchesId = (full: string | undefined, id: string): boolean => full?.startsWith(id) === true;

export async function listOperations(
  ctx: BrainContext,
  input: ListOperationsInput = {},
): Promise<ListOperationsOutput> {
  // só leitura, e só na CLI: aceita qualquer começo
  const session = identifier(input.session, 'session', 1);
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

/**
 * Troca o commit do revert por um igual (mesmos pais, mensagem e autor) com o `index.md` regenerado na árvore, sem
 * `commit --amend`. O `--amend` reescreve o que estiver no HEAD na hora: entre conferir o HEAD e reescrever, um
 * commit de outro programa poderia ser reescrito. Aqui o commit novo é montado só com objetos do git (um índice
 * temporário em `scratch`) e a branch avança com `update-ref HEAD <novo> <revert>`, que o git só aplica se o HEAD
 * ainda for o revert, numa operação atômica. Devolve o commit novo, ou `null` se o HEAD já era outro (nada mudou).
 */
async function replaceWithCatalog(ctx: BrainContext, revert: string, scratch: string): Promise<string | null> {
  const indexMd = ctx.config.indexMd;
  const env = { GIT_INDEX_FILE: join(scratch, 'catalog-index') };
  const text = async (args: string[], options: { env?: Record<string, string>; input?: string } = {}) =>
    (await runGit(args, { cwd: ctx.root, ...options })).stdout.trim();
  const blob = await text(['hash-object', '-w', '--', indexMd]);
  await text(['read-tree', `${revert}^{tree}`], { env });
  await text(['update-index', '--add', '--cacheinfo', `100644,${blob},${indexMd}`], { env });
  const tree = await text(['write-tree'], { env });
  const shown = (await runGit(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%P%x00%B', revert], { cwd: ctx.root }))
    .stdout;
  const [name = '', email = '', date = '', parents = '', ...rest] = shown.split('\0');
  const commit = await text(
    [
      'commit-tree',
      '--no-gpg-sign',
      tree,
      ...parents
        .split(' ')
        .filter((parent) => parent !== '')
        .flatMap((parent) => ['-p', parent]),
      '-F',
      '-',
    ],
    {
      input: `${rest.join('\0').trimEnd()}\n`,
      env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
    },
  );
  const moved = await runGit(['update-ref', '-m', 'cabecao undo: catálogo regenerado', 'HEAD', commit, revert], {
    cwd: ctx.root,
    allowFailure: true,
  });
  if (moved.exitCode !== 0) return null;
  // o índice do git passa a ter o mesmo index.md do commit (a pasta de trabalho já tem)
  await runGit(['--literal-pathspecs', 'add', '--', indexMd], { cwd: ctx.root });
  return commit;
}

export async function undo(
  ctx: BrainContext,
  input: UndoInput = {},
  options: ConfirmOptions = {},
): Promise<UndoOutput> {
  const op = identifier(input.op, 'op', MIN_HUMAN_ID_PREFIX);
  const session = identifier(input.session, 'session', MIN_HUMAN_ID_PREFIX);
  const token = tokenOf(input.confirm_token);
  const candidate = ctx.actor === 'agent' ? candidateApproval(ctx, token, options) : null;
  // um agente com o identificador inteiro desfaz as próprias operações sem confirmação; o resto é elevado
  const partial = (id: string | undefined): boolean => id !== undefined && !isUlid(id);
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

    const listHint =
      ctx.actor === 'human'
        ? 'Veja as operações que podem ser desfeitas com "cabecao undo --list".'
        : 'Use o "op" devolvido pela escrita, inteiro; o usuário vê todas as operações com "cabecao undo --list".';
    let targets: LoggedCommit[];
    const reasons: string[] = [];
    if (op !== undefined) {
      targets = commits.filter((commit) => matchesId(commit.trailers.op, op));
      const ops = new Set(targets.map((commit) => commit.trailers.op));
      if (targets.length === 0) {
        throw new BrainError('not_found', `nenhuma operação ${op} no histórico deste cérebro`, { nextStep: listHint });
      }
      if (ops.size > 1) {
        // só acontece com o começo de um ULID, que só o usuário pode dar
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
      if (!targets.every(isOperation)) {
        throw new BrainError(
          'not_found',
          `${op} não é uma operação do Cabeção que possa ser desfeita (edições feitas fora do Cabeção, sync, conflitos e o init não são desfeitos por aqui)`,
          { nextStep: listHint },
        );
      }
      if (!targets.every((commit) => mayUndo(ctx, commit))) {
        reasons.push(`a operação foi feita pelo usuário (${targets[0]?.trailers.client ?? '?'}), não por um agente`);
      }
      if (ctx.actor === 'agent' && partial(op)) reasons.push('a operação foi indicada só pelo começo do identificador');
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
      // pelo começo do identificador (elevado), todas as operações da sessão; pelo identificador inteiro, um agente
      // desfaz só as de agentes, sem confirmação
      const byPrefix = ctx.actor === 'agent' && partial(session);
      if (byPrefix) reasons.push('a sessão foi indicada só pelo começo do identificador');
      targets = commits.filter(
        (commit) =>
          isOperation(commit) &&
          !commit.undone &&
          matchesId(commit.trailers.session, session) &&
          (byPrefix || mayUndo(ctx, commit)),
      );
      if (byPrefix && !targets.every((commit) => mayUndo(ctx, commit))) {
        reasons.push('a sessão tem operações feitas pelo usuário, não por um agente');
      }
      if (targets.length === 0) {
        throw new BrainError('nothing_to_undo', `a sessão ${session} não tem operação que ainda valha`, {
          nextStep:
            ctx.actor === 'human'
              ? `Veja as operações da sessão com "cabecao undo --list --session ${session}".`
              : 'Confira se o session_handle é o devolvido pelo recall desta tarefa, inteiro.',
        });
      }
    } else {
      // o usuário desfaz a última operação, qualquer que seja; um agente, a última operação de agente que ainda vale
      const last =
        ctx.actor === 'human'
          ? commits.find(isOperation)
          : commits.find((commit) => isOperation(commit) && !commit.undone && mayUndo(ctx, commit));
      if (last === undefined) throw new BrainError('nothing_to_undo', 'não há operação do Cabeção para desfazer');
      targets = [last];
    }

    const reverted = [...new Set(targets.map((commit) => commit.trailers.op ?? ''))];
    // undo elevado (decisão 37): sem confirmação, nada é desfeito
    let approval: Approval | null = null;
    if (ctx.actor === 'agent' && reasons.length > 0) {
      const parts = ['undo', ...[...reverted].sort(), ...targets.map((target) => target.sha).sort()];
      const sessionKey = handle ?? '';
      if (candidate === null) {
        const request = await confirmationRequest(
          ctx,
          'undo',
          {
            reasons,
            summary: `Desfazer ${reverted.length === 1 ? 'a operação' : `${reverted.length} operações`} ${reverted.join(', ')} (${targets
              .map((target) => `${target.trailers.client ?? '?'}: ${target.changes.join('; ') || 'sem descrição'}`)
              .join(' | ')}), com um commit de revert. Por quê pede confirmação: ${reasons.join('; ')}`,
            parts,
          },
          sessionKey,
        );
        return {
          op: '',
          commit: null,
          undone: targets.map((target) => ({
            op: target.trailers.op ?? '',
            commit: target.sha,
            changes: target.changes,
          })),
          changed_paths: [],
          warnings: [],
          ...request,
        };
      }
      if (candidate.by === 'token' && token !== undefined) {
        await verifyConfirmToken(ctx, 'undo', parts, sessionKey, token, 'undo');
      }
      approval = candidate;
    }
    const undoOp = ulid();
    const commit = ctx.config.commit;
    const message = formatCommitMessage({
      ...(commit?.message === undefined ? {} : { subjectTemplate: commit.message }),
      ...(commit?.dateFormat === undefined ? {} : { dateFormat: commit.dateFormat }),
      date: ctx.now(),
      action: 'revert',
      body: [
        ...targets.flatMap((target) =>
          target.changes.length === 0 ? [`revert: operação ${target.trailers.op}`] : target.changes.map(revertLine),
        ),
        ...(approval === null ? [] : [approvedLine(approval)]),
      ],
      numFiles: 0,
      trailers: {
        op: undoOp,
        machine: await machineName(ctx),
        client: ctx.client,
        reverts: reverted,
        ...(handle === undefined ? {} : { session: handle }),
        ...(approval === null ? {} : { approved: approvedTrailer(approval) }),
      },
    });

    const scratch = await mkdtemp(join(tmpdir(), 'cabecao-undo-'));
    try {
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

      // O catálogo do commit de revert vem da mesclagem por união; o certo sai do banco e entra no lugar do commit do
      // revert SEM `commit --amend` (ver `replaceWithCatalog`): se outro programa (o Obsidian Git, por exemplo)
      // commitou depois do revert, nada é reescrito, e o próximo sync ou a próxima escrita leva o catálogo.
      const movedWarning: IssueOutput = {
        severity: 'warning',
        code: 'catalog_not_updated',
        field: null,
        message:
          'outro programa fez um commit logo depois do undo; o commit do undo não foi reescrito, e o index.md fica para o próximo sync',
      };
      const revert = sha;
      try {
        const catalog = await withFreshIndex(ctx, () => catalogFromIndex(ctx));
        await ctx.faultAt?.('reverted');
        if ((await headSha(ctx.root)) !== revert) {
          warnings.push(movedWarning);
        } else if (await writeIndexMd(ctx.root, ctx.config, catalog)) {
          await ctx.faultAt?.('cataloged');
          const replaced = await replaceWithCatalog(ctx, revert, scratch);
          if (replaced === null) {
            warnings.push(movedWarning);
            // o catálogo regenerado não entrou em commit nenhum: a pasta volta ao que está commitado
            await runGit(['--literal-pathspecs', 'checkout', 'HEAD', '--', ctx.config.indexMd], {
              cwd: ctx.root,
              allowFailure: true,
            });
          } else {
            sha = replaced;
          }
        }
      } catch (error) {
        // o undo valeu; só o catálogo ficou para o próximo sync regenerar
        await runGit(['--literal-pathspecs', 'checkout', revert, '--', ctx.config.indexMd], {
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

      const { stdout } = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha], {
        cwd: ctx.root,
      });
      return {
        op: undoOp,
        commit: sha,
        undone: targets.map((target) => ({
          op: target.trailers.op ?? '',
          commit: target.sha,
          changes: target.changes,
        })),
        changed_paths: stdout.split('\0').filter((path) => path !== ''),
        warnings,
        ...(approval === null ? {} : { confirmed_by: approval.by }),
        next_step: `Para refazer, desfaça este undo: undo({ op: "${undoOp}" }).`,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
