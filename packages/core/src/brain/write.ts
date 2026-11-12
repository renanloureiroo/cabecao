// Operações de escrita: `remember`, `write_page` e `patch_page`, com o fluxo do doc 02 ("Escrita"):
//
//   1. valida o esquema → 2. scanner de segredos → 3. grava de forma atômica (vault) → 4. atualiza o banco local
//   → 5. um commit local no padrão do doc 12, com `index.md` e `log.md` no mesmo commit.
//
// Tudo sob a trava da pasta de trabalho (a mesma do sync). Uma falha depois da gravação desfaz o que foi feito
// (arquivo, catálogo, diário, índice do git e banco voltam ao estado anterior) e o erro é relatado.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { listNotes } from '../db/index.ts';
import type { CommitChange } from '../git/index.ts';
import {
  commitPaths,
  formatCommitMessage,
  GitError,
  headSha,
  isRepo,
  parseCommitTrailers,
  runGit,
  statusPorcelain,
} from '../git/index.ts';
import { scanSecrets } from '../security/index.ts';
import { fileStamp, isUlid, ulid, writeFileAtomic } from '../util/index.ts';
import type { BrainConfig, NoteIssue, NoteRead, NoteType, WriteResult } from '../vault/index.ts';
import {
  appendLogLine,
  assertNotePath,
  createNote,
  diskCasePath,
  hasErrors,
  isBrainControlFile,
  isInNoteDirs,
  isNoteType,
  isValidScope,
  isWikilinkText,
  LOG_MD,
  linkListFields,
  localDate,
  NOTE_TYPE_DIRS,
  patchNote,
  RAW_DIR,
  readBrainConfig,
  readNote,
  renderIndexMd,
  resolveVaultPath,
  serializeFrontmatter,
  toCommitChange,
  updateNote,
  validateNote,
  writeIndexMd,
} from '../vault/index.ts';
import type { BrainContext, WriteStep } from './context.ts';
import { machineName, rescan, withFreshIndex, withWriteLock } from './context.ts';
import type { IssueOutput, SecretHit } from './errors.ts';
import { BrainError, issueOutput, toBrainError } from './errors.ts';

// ---------------------------------------------------------------------------------------------------------------
// Tipos públicos

/** Resultado de toda escrita. */
export interface WriteOutput {
  /** ULID da operação (rodapé `Cabecao-Op`); é o que se passa ao `undo`. */
  readonly op: string;
  readonly path: string;
  readonly id: string | null;
  readonly action: 'add' | 'update';
  /** `false` quando a nota já estava como pedido: nada foi gravado nem commitado. */
  readonly changed: boolean;
  /** SHA do commit da operação; `null` quando nada mudou. */
  readonly commit: string | null;
  /** Avisos do esquema e da operação (campo ignorado, confiança rebaixada...). */
  readonly warnings: readonly IssueOutput[];
  readonly next_step?: string;
}

/** Relações tipadas: `{ uses: ["SQS"], part_of: ["[[Projeto Atlas]]"] }`. O alvo vira wikilink se ainda não for. */
export type RelationsInput = Readonly<Record<string, readonly string[]>>;

export interface RememberInput {
  /** Corpo da nota, em Markdown. */
  readonly content: string;
  readonly type: string;
  /** Obrigatório só na prática: sem ele, sai da primeira linha de `content`. Fatos podem não ter. */
  readonly title?: string;
  /** `global` (padrão) ou `project:<slug>`. */
  readonly scope?: string;
  readonly tags?: readonly string[];
  readonly relations?: RelationsInput;
  /** Só em `type: fact`. */
  readonly subject?: string;
  readonly predicate?: string;
  readonly object?: string;
  readonly valid_from?: string;
  readonly valid_until?: string;
  readonly expires_at?: string;
  /** Fontes (notas em `raw/`, por exemplo); viram wikilinks. */
  readonly sources?: readonly string[];
  /** O `session_handle` do `recall`; vai para o rodapé `Cabecao-Session`. */
  readonly session_handle?: string;
}

/**
 * Modos do `write_page`:
 * - `create`: a nota não pode existir. `frontmatter.type` é obrigatório; `id`, `created`, `updated` e `origin` são
 *   do Cabeção (ignorados se vierem).
 * - `overwrite`: a nota tem de existir. O corpo é trocado por `content`. Com `frontmatter`, os campos passam a ser
 *   exatamente os enviados, exceto os do Cabeção (`id`, `type`, `created`, `updated`, `origin`, e `trust` quando
 *   não enviado), que são mantidos; sem `frontmatter`, o frontmatter fica como está.
 * - `append`: a nota tem de existir. `content` é acrescentado ao fim do corpo, separado por uma linha em branco;
 *   os campos de `frontmatter`, se vierem, são mesclados (os demais ficam como estão).
 */
export type WriteMode = 'create' | 'overwrite' | 'append';
export const WRITE_MODES: readonly WriteMode[] = ['create', 'overwrite', 'append'];

export interface WritePageInput {
  readonly path: string;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly mode: WriteMode;
  readonly session_handle?: string;
}

export interface PatchPageInput {
  readonly path: string;
  /** Trecho exato do corpo, que precisa aparecer uma única vez. */
  readonly old: string;
  readonly new: string;
  readonly session_handle?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Apoio

function invalid(message: string, nextStep?: string): BrainError {
  return new BrainError('invalid_argument', message, nextStep === undefined ? {} : { nextStep });
}

function invalidNote(path: string, issues: readonly NoteIssue[]): BrainError {
  const errors = issues.filter((issue) => issue.severity === 'error');
  return new BrainError('invalid_note', `nota inválida (${path}): ${errors.map((issue) => issue.message).join('; ')}`, {
    details: { path, issues: issues.map(issueOutput) },
    nextStep: 'Corrija os campos apontados em details.issues e tente de novo.',
  });
}

function warning(code: string, field: string | null, message: string): IssueOutput {
  return { severity: 'warning', code, field, message };
}

function ruleRefused(): BrainError {
  return new BrainError(
    'rule_requires_human',
    'regras (type: rule) só o usuário cria e altera; um agente não pode gravá-las',
    {
      nextStep:
        'Grave como preferência (type: preference) ou proponha a regra ao usuário; ele a cria com a CLI ou no Obsidian.',
    },
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Campos que o Cabeção preenche; o que vier do chamador nesses campos é ignorado. */
const MANAGED_ON_CREATE = ['id', 'created', 'updated', 'origin', 'edited_by'] as const;
/** Campos que o Cabeção preenche numa alteração; o que vier do chamador nesses campos é ignorado. */
const MANAGED_ON_UPDATE: ReadonlySet<string> = new Set(['origin', 'created', 'updated', 'edited_by']);
/** Campos mantidos num `overwrite` mesmo quando o frontmatter enviado não os traz. */
const KEPT_ON_OVERWRITE = new Set(['id', 'type', 'created', 'updated', 'origin', 'trust', 'edited_by']);

/** `type: rule`, com qualquer caixa e espaço em volta (o banco guarda o tipo sem os espaços). */
const isRuleType = (value: unknown): boolean => typeof value === 'string' && value.trim().toLowerCase() === 'rule';
/** Texto de um campo para comparar: sem espaços em volta e em minúsculas. */
const fieldKey = (value: unknown): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

const RULES_DIR_PREFIX = `${NOTE_TYPE_DIRS.rule.toLowerCase()}/`;
const RAW_DIR_PREFIX = `${RAW_DIR.toLowerCase()}/`;

/**
 * O que um agente nunca grava, qualquer que seja a tool ou o modo (o usuário, pela CLI, não passa por aqui):
 *
 * - os arquivos de controle do cérebro (`AGENTS.md`, `CLAUDE.md`, catálogo, diário...), mesmo com `noteDirs: ["."]`;
 * - nada em `memory/rules/`: regras só o usuário cria;
 * - numa alteração (`overwrite`, `append`, `patch_page`), nada em `raw/`, onde ficam as fontes imutáveis.
 *
 * `path` já vem canônico, com a grafia do disco.
 */
function assertAgentMayWrite(ctx: BrainContext, path: string, kind: 'create' | 'update'): void {
  if (ctx.actor === 'human') return;
  if (isBrainControlFile(path, ctx.config)) {
    throw new BrainError(
      'invalid_path',
      `${path} é um arquivo de controle do cérebro (instruções dos agentes, catálogo ou diário), não uma nota; um agente não grava nele`,
      {
        details: { path },
        nextStep: 'Grave o conteúdo numa nota (em wiki/ ou memory/). As instruções do cérebro só o usuário altera.',
      },
    );
  }
  const key = path.toLowerCase();
  if (key.startsWith(RULES_DIR_PREFIX)) throw ruleRefused();
  if (kind === 'update' && key.startsWith(RAW_DIR_PREFIX)) {
    throw new BrainError(
      'invalid_path',
      `${path} fica em ${RAW_DIR}/, a pasta das fontes imutáveis: um agente só cria arquivos ali, nunca altera os que existem`,
      {
        details: { path },
        nextStep:
          'Para registrar algo sobre essa fonte, crie uma nota nova (por exemplo em wiki/sources/) com "sources" apontando para ela.',
      },
    );
  }
}

/**
 * Proveniência de uma nota do usuário (`origin: human` ou `trust: high`) que um agente vai alterar: `trust` cai para
 * `medium` (se era `high`, ou se não havia e a origem é humana) e `edited_by` registra o agente. Sem isso, o texto
 * escrito pelo agente seria servido com a autoridade do usuário. `null` quando não se aplica.
 */
function agentEditProvenance(
  ctx: BrainContext,
  before: Readonly<Record<string, unknown>>,
): { fields: Record<string, unknown>; warning: IssueOutput } | null {
  if (ctx.actor === 'human') return null;
  const trust = fieldKey(before.trust);
  const origin = fieldKey(before.origin);
  if (trust !== 'high' && origin !== 'human') return null;
  const lower = trust === 'high' || ((trust === undefined || trust === null || trust === '') && origin === 'human');
  const editedBy = `agent:${ctx.client}`;
  const fields: Record<string, unknown> = { ...(lower ? { trust: 'medium' } : {}), edited_by: editedBy };
  return {
    fields,
    warning: warning(
      'provenance_changed',
      'trust',
      `a nota era do usuário (${origin === 'human' ? 'origin: human' : 'trust: high'}); como um agente alterou o conteúdo, ela foi gravada com ${lower ? '"trust: medium" e ' : ''}"edited_by: ${editedBy}"`,
    ),
  };
}

/** `Nota`, `pasta/Nota` ou `[[Nota]]` → `[[Nota]]`; o que não serve de nome de nota (uma URL) fica como veio. */
function toLink(value: string): string {
  const text = value.trim();
  // `isWikilinkText` estreita o tipo; aplicado a uma cópia, não transforma `text` em `never` no ramo falso
  if (isWikilinkText(`${text}`)) return text;
  return /^[^[\]\n|#]+$/.test(text) && !text.includes('://') ? `[[${text}]]` : text;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw invalid(`"${name}" deveria ser uma lista de textos`);
  }
  return value.map((item: string) => item.trim());
}

function sessionOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isUlid(value)) {
    throw invalid(
      '"session_handle" deveria ser o identificador devolvido pelo recall (ULID)',
      'Chame recall e use o session_handle dele.',
    );
  }
  return value;
}

/** Título a partir da primeira linha com texto do conteúdo, sem marcação de Markdown e com até 80 caracteres. */
function titleFromContent(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((text) =>
      text
        .replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)*/, '')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .find((text) => text !== '');
  if (line === undefined) return '';
  if (line.length <= 80) return line;
  const cutAt = line.lastIndexOf(' ', 80);
  return `${line.slice(0, cutAt > 40 ? cutAt : 80).trimEnd()}…`;
}

/** Ocorrências de `needle` em `text`, contando as sobrepostas (mesma regra do `patchNote`). */
function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
  return count;
}

/** Erros que a mudança INTRODUZ (um problema que a nota já tinha não trava a escrita, como no vault). */
function introducedErrors(before: readonly NoteIssue[], after: readonly NoteIssue[]): NoteIssue[] {
  const known = new Set(before.map((issue) => `${issue.code}\0${issue.field}`));
  return after.filter((issue) => issue.severity === 'error' && !known.has(`${issue.code}\0${issue.field}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Scanner de segredos

interface ScanTarget {
  readonly where: 'content' | 'frontmatter' | 'path';
  readonly field: string | null;
  readonly text: string;
}

const linesOf = (text: string): string[] => text.split('\n').map((line) => line.replace(/\r$/, ''));

/**
 * Possíveis segredos NOVOS em `text`: uma linha que já está na versão commitada do arquivo (`previous`) não é
 * acusada, porque já está no histórico (é o mesmo critério do sync antes de enviar) e porque assim dá para editar
 * uma nota que já tinha uma linha liberada com `cabecao:allow-secret`.
 *
 * `honorAllowMarker`: o marcador `cabecao:allow-secret` só vale no texto do USUÁRIO. Num texto enviado por um
 * agente ele é ignorado: senão, bastaria o agente (ou o conteúdo que o manipula) escrever o marcador ao lado do
 * segredo. Uma linha marcada que o usuário já gravou continua passando, por estar em `previous`.
 */
function newSecrets(
  text: string,
  previous: ReadonlySet<string>,
  where: SecretHit['where'],
  field: string | null,
  honorAllowMarker: boolean,
): SecretHit[] {
  const lines = linesOf(text);
  return scanSecrets(text, { honorAllowMarker })
    .filter((finding) => !previous.has(lines[finding.line - 1] ?? ''))
    .map((finding) => ({
      where,
      field,
      line: finding.line,
      column: finding.column,
      rule: finding.rule,
      description: finding.description,
    }));
}

function frontmatterTargets(fields: Readonly<Record<string, unknown>>, config: BrainConfig): ScanTarget[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      where: 'frontmatter' as const,
      field: key,
      text: serializeFrontmatter({ [key]: value }, config),
    }));
}

function secretError(hits: readonly SecretHit[]): BrainError {
  const where = hits
    .slice(0, 5)
    .map((hit) => {
      const place =
        hit.where === 'content'
          ? `conteúdo, linha ${hit.line}`
          : hit.where === 'frontmatter'
            ? `campo "${hit.field}"`
            : hit.where === 'path'
              ? 'caminho da nota'
              : `${hit.field}, linha ${hit.line} (edição feita fora do Cabeção)`;
      return `${place}: regra ${hit.rule} (${hit.description})`;
    })
    .join('; ');
  const more = hits.length > 5 ? `; e mais ${hits.length - 5}` : '';
  return new BrainError('secret_detected', `possível segredo encontrado, nada foi gravado: ${where}${more}`, {
    details: { secrets: hits },
    nextStep:
      'Tire o segredo do texto e do caminho (nunca grave senhas, tokens ou chaves) e tente de novo. Se não for um segredo, só o usuário pode gravar a linha, pelo Obsidian, com o marcador "cabecao:allow-secret" (o marcador não vale em texto enviado por um agente).',
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Git

async function git(ctx: BrainContext, args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
  return runGit(args, { cwd: ctx.root, allowFailure: true });
}

/** HEAD do cérebro; lança `not_a_repository` se a pasta não é um repositório com pelo menos um commit. */
export async function requireHead(ctx: BrainContext): Promise<string> {
  try {
    const sha = (await isRepo(ctx.root)) ? await headSha(ctx.root) : null;
    if (sha !== null) return sha;
  } catch (error) {
    throw toBrainError(error);
  }
  if (await gitMissing(ctx)) {
    throw new BrainError('git_failed', 'o programa git não foi encontrado nesta máquina; o Cabeção precisa dele', {
      nextStep: 'Instale o git (https://git-scm.com/downloads), confira com "git --version" e tente de novo.',
    });
  }
  throw new BrainError('not_a_repository', `a pasta ${ctx.root} não é um repositório git com commits`, {
    nextStep: 'Rode "cabecao init" nesta pasta para preparar o repositório do cérebro.',
  });
}

/** O `isRepo` responde "não" também quando o git nem existe; aqui se separa um caso do outro. */
async function gitMissing(ctx: BrainContext): Promise<boolean> {
  try {
    await runGit(['--version'], { cwd: ctx.root, allowFailure: true });
    return false;
  } catch (error) {
    return (
      error instanceof GitError &&
      error.exitCode === null &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    );
  }
}

/** Linhas de um arquivo na versão commitada (`HEAD`); vazio se o arquivo não existe lá. */
async function committedLines(ctx: BrainContext, head: string, path: string): Promise<Set<string>> {
  const shown = await git(ctx, ['show', `${head}:${path}`]);
  return new Set(shown.exitCode === 0 ? linesOf(shown.stdout) : []);
}

async function commitMessage(
  ctx: BrainContext,
  input: {
    op: string;
    session: string | undefined;
    client: string;
    body: readonly (string | CommitChange)[];
    numFiles: number;
  },
): Promise<string> {
  const commit = ctx.config.commit;
  return formatCommitMessage({
    ...(commit?.message === undefined ? {} : { subjectTemplate: commit.message }),
    ...(commit?.dateFormat === undefined ? {} : { dateFormat: commit.dateFormat }),
    date: ctx.now(),
    body: input.body,
    numFiles: input.numFiles,
    trailers: {
      op: input.op,
      machine: await machineName(ctx),
      client: input.client,
      ...(input.session === undefined ? {} : { session: input.session }),
    },
  });
}

/**
 * Edições feitas fora do Cabeção (Obsidian) ainda sem commit nos arquivos que a operação vai tocar: entram antes,
 * num commit `edit` próprio (o mesmo que o sync faria), para o commit da operação, e o `undo` dela, conter só o que
 * a operação fez.
 */
async function pendingEdits(ctx: BrainContext, paths: readonly string[]): Promise<string[]> {
  const wanted = new Set(paths);
  const out: string[] = [];
  for (const entry of await statusPorcelain(ctx.root)) {
    if (wanted.has(entry.path) && !out.includes(entry.path)) out.push(entry.path);
  }
  return out;
}

async function commitPendingEdits(ctx: BrainContext, paths: readonly string[]): Promise<void> {
  const notes = paths.filter((path) => path !== LOG_MD);
  const n = paths.length;
  const message = await commitMessage(ctx, {
    op: ulid(),
    session: undefined,
    client: 'manual',
    numFiles: n,
    body: [
      `edit: ${n} ${notes.length === n ? (n === 1 ? 'nota alterada' : 'notas alteradas') : n === 1 ? 'arquivo alterado' : 'arquivos alterados'} fora do Cabeção`,
      ...[...paths].sort().map((path) => `- ${path}`),
    ],
  });
  await commitPaths(ctx.root, paths, message);
}

// ---------------------------------------------------------------------------------------------------------------
// Fluxo de escrita

interface Prepared {
  /** Nota existente que será alterada (caminho canônico e caminho no disco); `null` numa criação. */
  readonly target: { readonly path: string; readonly diskPath: string } | null;
  /** O que passa pelo scanner de segredos. */
  readonly checks: readonly ScanTarget[];
  readonly warnings: readonly IssueOutput[];
  /** Grava pelo vault (passo 3). */
  apply(): Promise<WriteResult>;
}

type Snapshot = Map<string, Buffer | null>;

async function takeSnapshot(ctx: BrainContext, paths: readonly string[]): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  for (const path of paths) {
    if (snapshot.has(path)) continue;
    const absolute = await resolveVaultPath(ctx.root, path);
    try {
      snapshot.set(path, await readFile(absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      snapshot.set(path, null);
    }
  }
  return snapshot;
}

/** Devolve arquivos, índice do git e banco ao estado de antes da gravação. Nunca lança. */
async function rollback(ctx: BrainContext, snapshot: Snapshot): Promise<void> {
  for (const [path, data] of snapshot) {
    try {
      const absolute = join(ctx.root, ...path.split('/'));
      if (data === null) await rm(absolute, { force: true });
      else await writeFileAtomic(absolute, data);
    } catch {
      // melhor esforço: o próximo sync ainda veria a diferença e a commitaria
    }
    await git(ctx, ['--literal-pathspecs', 'reset', '--quiet', '--', path]).catch(() => undefined);
  }
  await rescan(ctx).catch(() => undefined);
}

async function fault(ctx: BrainContext, step: WriteStep): Promise<void> {
  await ctx.faultAt?.(step);
}

/** Conteúdo do `index.md` a partir do banco, com a mesma regra que o sync usa (grupos na ordem de `noteDirs`). */
export function catalogFromIndex(ctx: BrainContext): string {
  const entries = listNotes(ctx.index, { includeArchived: true, orderBy: 'path' }).map((note) => ({
    path: note.path,
    type: note.type,
    validUntil: note.validUntil,
  }));
  return renderIndexMd(entries, { groupOrder: ctx.config.noteDirs });
}

async function executeWrite(
  ctx: BrainContext,
  sessionHandle: unknown,
  prepare: (config: BrainConfig) => Promise<Prepared>,
): Promise<WriteOutput> {
  const session = sessionOf(sessionHandle);
  const op = ulid();
  return withWriteLock(ctx, async () => {
    try {
      ctx.config = await readBrainConfig(ctx.root);
    } catch (error) {
      throw toBrainError(error);
    }
    const head = await requireHead(ctx);

    // 1. Validação (argumentos, caminho, esquema).
    let prepared: Prepared;
    try {
      prepared = await prepare(ctx.config);
    } catch (error) {
      throw toBrainError(error);
    }

    // 2. Scanner de segredos: no conteúdo, nos campos, no caminho e nas edições de fora que iriam junto. As edições
    // de fora são do usuário (o marcador vale nelas); o texto da operação vale pelo `actor`.
    const target = prepared.target?.diskPath ?? null;
    const previous = target === null ? new Set<string>() : await committedLines(ctx, head, target);
    const secrets: SecretHit[] = [];
    const pending = await pendingEdits(ctx, [...(target === null ? [] : [target]), LOG_MD]);
    for (const path of pending) {
      const data = await readFile(join(ctx.root, ...path.split('/')), 'utf8').catch(() => null); // apagado: nada a ler
      if (data === null) continue;
      secrets.push(...newSecrets(data, await committedLines(ctx, head, path), 'pending', path, true));
      // a edição do usuário entra num commit `edit` antes da operação: as linhas dela já não são "novas"
      if (path === target) for (const line of linesOf(data)) previous.add(line);
    }
    const honorAllowMarker = ctx.actor === 'human';
    for (const check of prepared.checks) {
      secrets.push(...newSecrets(check.text, previous, check.where, check.field, honorAllowMarker));
    }
    if (secrets.length > 0) throw secretError(secrets);
    if (pending.length > 0) {
      try {
        await commitPendingEdits(ctx, pending);
      } catch (error) {
        throw toBrainError(error);
      }
    }

    // 3. Gravação atômica pelo vault.
    const indexMd = ctx.config.indexMd;
    const snapshot = await takeSnapshot(ctx, [
      ...(prepared.target === null ? [] : [prepared.target.diskPath]),
      indexMd,
      LOG_MD,
    ]);
    let result: WriteResult;
    try {
      result = await prepared.apply();
    } catch (error) {
      throw toBrainError(error); // o vault não grava nada quando recusa
    }
    const warnings = [...prepared.warnings, ...result.warnings.map(issueOutput)];
    const notePath = prepared.target?.diskPath ?? result.path;
    if (!snapshot.has(notePath)) snapshot.set(notePath, null);
    if (!result.changed) {
      return {
        op,
        path: result.path,
        id: result.id,
        action: result.action === 'add' ? 'add' : 'update',
        changed: false,
        commit: null,
        warnings,
        next_step: 'A nota já estava assim; nada foi gravado.',
      };
    }

    const before = await headSha(ctx.root).catch(() => head);
    try {
      await fault(ctx, 'written');
      // 4. Banco local, e o catálogo calculado dele na mesma passada.
      const catalog = await withFreshIndex(ctx, () => catalogFromIndex(ctx));
      await fault(ctx, 'indexed');
      await writeIndexMd(ctx.root, ctx.config, catalog);
      await appendLogLine(ctx.root, { action: result.action, type: result.type, title: result.title, date: ctx.now() });
      await fault(ctx, 'cataloged');
      // 5. Um commit com a nota, o catálogo e o diário.
      const message = await commitMessage(ctx, {
        op,
        session,
        client: ctx.client,
        body: [toCommitChange(result)],
        numFiles: 3,
      });
      const commit = await commitPaths(ctx.root, [notePath, indexMd, LOG_MD], message);
      return {
        op,
        path: result.path,
        id: result.id,
        action: result.action === 'add' ? 'add' : 'update',
        changed: true,
        commit,
        warnings,
      };
    } catch (error) {
      // o commit pode ter saído e a falha ter vindo depois (ao ler o HEAD): aí a operação valeu
      const now = await headSha(ctx.root).catch(() => before);
      if (now !== null && now !== before) {
        const shown = await git(ctx, ['log', '-1', '--format=%B', now]);
        if (parseCommitTrailers(shown.stdout).op === op) {
          return {
            op,
            path: result.path,
            id: result.id,
            action: result.action === 'add' ? 'add' : 'update',
            changed: true,
            commit: now,
            warnings,
          };
        }
      }
      await rollback(ctx, snapshot);
      throw toBrainError(error);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// remember

export async function remember(ctx: BrainContext, input: RememberInput): Promise<WriteOutput> {
  if (!isRecord(input)) throw invalid('remember precisa de um objeto com content e type');
  if (!isNoteType(input.type)) {
    throw invalid(
      `"type" deveria ser um tipo de nota (preference, gotcha, decision, fact...); veio ${JSON.stringify(input.type)}`,
    );
  }
  const type: NoteType = input.type;
  if (type === 'rule' && ctx.actor !== 'human') throw ruleRefused();
  if (typeof input.content !== 'string') throw invalid('"content" deveria ser um texto');
  return executeWrite(ctx, input.session_handle, async (config) => {
    const now = ctx.now();
    const day = localDate(now);
    const origin = ctx.actor === 'human' ? 'human' : `agent:${ctx.client}`;
    const fields: Record<string, unknown> = {};
    let title = typeof input.title === 'string' ? input.title.trim() : undefined;
    if (input.title !== undefined && typeof input.title !== 'string') throw invalid('"title" deveria ser um texto');
    if ((title === undefined || title === '') && type !== 'fact') title = titleFromContent(input.content);
    if (title !== undefined && title !== '') fields.title = title;
    else if (type !== 'fact') throw invalid('informe "title": o conteúdo está vazio');
    if (input.scope !== undefined) {
      if (!isValidScope(input.scope)) throw invalid('"scope" deveria ser "global" ou "project:<slug>"');
      fields.scope = input.scope;
    }
    if (input.tags !== undefined) fields.tags = stringList(input.tags, 'tags');
    if (input.sources !== undefined) fields.sources = stringList(input.sources, 'sources').map(toLink);
    for (const key of ['valid_from', 'valid_until', 'expires_at'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw invalid(`"${key}" deveria ser uma data AAAA-MM-DD`);
      fields[key] = value;
    }
    if (type === 'fact') {
      if (input.subject !== undefined) fields.subject = toLink(String(input.subject));
      if (input.predicate !== undefined) fields.predicate = input.predicate;
      if (input.object !== undefined) fields.object = input.object;
    } else if (input.subject !== undefined || input.predicate !== undefined || input.object !== undefined) {
      throw invalid('"subject", "predicate" e "object" só valem em type: fact');
    }
    if (input.relations !== undefined) {
      if (!isRecord(input.relations)) throw invalid('"relations" deveria ser um objeto { relação: [alvos] }');
      const allowed = linkListFields(config);
      for (const [relation, targets] of Object.entries(input.relations)) {
        if (!allowed.includes(relation)) {
          throw invalid(`relação desconhecida: ${JSON.stringify(relation)}; as relações são: ${allowed.join(', ')}`);
        }
        fields[relation] = stringList(targets, `relations.${relation}`).map(toLink);
      }
    }

    const frontmatter: Record<string, unknown> = {
      id: ulid(now.getTime()),
      type,
      ...fields,
      trust: ctx.actor === 'human' ? 'high' : 'medium',
      origin,
      created: day,
      updated: day,
    };
    if (type !== 'fact') {
      frontmatter.scope ??= 'global';
      frontmatter.tags ??= [];
      frontmatter.sources ??= [];
    } else {
      frontmatter.valid_from ??= day;
    }
    const issues = validateNote({ frontmatter }, config);
    if (hasErrors(issues)) throw invalidNote(`nova nota do tipo ${type}`, issues);
    return {
      target: null,
      checks: [{ where: 'content', field: null, text: input.content }, ...frontmatterTargets(fields, config)],
      warnings: [],
      apply: () => createNote(ctx.root, config, { type, origin, body: input.content, frontmatter, now }),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// write_page

/** `trust` enviado por um agente: nunca `high` (isso é do usuário). Devolve o valor a gravar e o aviso, se houver. */
function agentTrust(ctx: BrainContext, value: unknown): { trust: unknown; warning: IssueOutput | null } {
  if (ctx.actor === 'agent' && value === 'high') {
    return {
      trust: 'medium',
      warning: warning('trust_lowered', 'trust', '"trust: high" é só do usuário; a nota foi gravada com "medium"'),
    };
  }
  return { trust: value, warning: null };
}

async function existingNote(ctx: BrainContext, path: string): Promise<NoteRead> {
  // a grafia do disco (`wiki/entities/sqs.md` → `SQS.md`): é o nome que o git conhece, e é com ele que as
  // conferências abaixo (raw/, memory/rules/, arquivos de controle) não são contornadas por outra caixa
  const canonical = (await diskCasePath(ctx.root, assertNotePath(path))).path;
  if (!isInNoteDirs(canonical, ctx.config)) {
    throw new BrainError(
      'invalid_path',
      `${canonical} fica fora das pastas de notas do cérebro (${ctx.config.noteDirs.join(', ')})`,
      {
        details: { path: canonical },
      },
    );
  }
  assertAgentMayWrite(ctx, canonical, 'update');
  const read = await readNote(ctx.root, canonical);
  if (ctx.actor !== 'human' && isRuleType(read.note.frontmatter.type)) throw ruleRefused();
  return read;
}

/** Valida o resultado de uma alteração: só os erros que ela introduz contam (como no vault). */
function checkUpdate(
  read: NoteRead,
  set: Readonly<Record<string, unknown>>,
  remove: readonly string[],
  day: string,
  config: BrainConfig,
): void {
  const before = read.note.frontmatter;
  if ('type' in set && set.type !== before.type && before.type !== undefined) {
    throw new BrainError('invalid_note', `não dá para trocar "type" de uma nota existente (${read.path})`, {
      details: { path: read.path },
    });
  }
  if ('id' in set && set.id !== before.id && before.id !== undefined) {
    throw new BrainError('invalid_note', `não dá para trocar "id" de uma nota existente (${read.path})`, {
      details: { path: read.path },
    });
  }
  const after: Record<string, unknown> = { ...before, ...set };
  for (const key of remove) delete after[key];
  if (after.id !== undefined && !('updated' in set)) after.updated = day;
  const beforeIssues = validateNote(
    { frontmatter: before, frontmatterError: read.note.frontmatterError, path: read.path },
    config,
  );
  const afterIssues = validateNote(
    { frontmatter: after, frontmatterError: read.note.frontmatterError, path: read.path },
    config,
  );
  const introduced = introducedErrors(beforeIssues, afterIssues);
  if (introduced.length > 0) throw invalidNote(read.path, introduced);
}

export async function writePage(ctx: BrainContext, input: WritePageInput): Promise<WriteOutput> {
  if (!isRecord(input)) throw invalid('write_page precisa de um objeto com path, content e mode');
  if (!WRITE_MODES.includes(input.mode)) throw invalid('"mode" deveria ser "create", "overwrite" ou "append"');
  if (typeof input.path !== 'string' || input.path === '') throw invalid('"path" deveria ser o caminho da nota');
  if (typeof input.content !== 'string') throw invalid('"content" deveria ser um texto');
  if (input.frontmatter !== undefined && !isRecord(input.frontmatter))
    throw invalid('"frontmatter" deveria ser um objeto');
  const given: Readonly<Record<string, unknown>> = input.frontmatter ?? {};

  return executeWrite(ctx, input.session_handle, async (config) => {
    const now = ctx.now();
    const day = localDate(now);
    const warnings: IssueOutput[] = [];

    if (input.mode === 'create') {
      const path = (await diskCasePath(ctx.root, assertNotePath(input.path))).path;
      if (!isInNoteDirs(path, config)) {
        throw new BrainError(
          'invalid_path',
          `${path} fica fora das pastas de notas do cérebro (${config.noteDirs.join(', ')})`,
          {
            details: { path },
          },
        );
      }
      const type = given.type;
      if (!isNoteType(type)) {
        throw new BrainError(
          'invalid_note',
          `"frontmatter.type" deveria ser um tipo de nota; veio ${JSON.stringify(type)}`,
          {
            details: { path },
            nextStep: 'Informe frontmatter.type (concept, entity, decision, preference, gotcha...).',
          },
        );
      }
      if (type === 'rule' && ctx.actor !== 'human') throw ruleRefused();
      assertAgentMayWrite(ctx, path, 'create');
      if ((await fileStamp(await resolveVaultPath(ctx.root, path))) !== null) {
        throw new BrainError('already_exists', `já existe uma nota em ${path}`, {
          details: { path },
          nextStep: 'Use mode "overwrite" ou "append", ou escolha outro caminho.',
        });
      }
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(given)) {
        if ((MANAGED_ON_CREATE as readonly string[]).includes(key)) {
          warnings.push(
            warning('ignored_field', key, `"${key}" é preenchido pelo Cabeção; o valor enviado foi ignorado`),
          );
        } else if (value !== undefined) {
          fields[key] = value;
        }
      }
      const { trust, warning: lowered } = agentTrust(ctx, fields.trust);
      if (lowered !== null) warnings.push(lowered);
      const origin = ctx.actor === 'human' ? 'human' : `agent:${ctx.client}`;
      const frontmatter: Record<string, unknown> = {
        ...fields,
        id: ulid(now.getTime()),
        origin,
        ...(trust === undefined ? {} : { trust }),
        created: day,
        updated: day,
      };
      const issues = validateNote({ frontmatter, path }, config);
      if (hasErrors(issues)) throw invalidNote(path, issues);
      const { type: _type, ...scanned } = fields;
      return {
        target: null,
        // o caminho também: ele vai para o nome do arquivo, para o commit e para o index.md
        checks: [
          { where: 'content', field: null, text: input.content },
          { where: 'path', field: 'path', text: path },
          ...frontmatterTargets(scanned, config),
        ],
        warnings,
        apply: () => createNote(ctx.root, config, { type, origin, path, body: input.content, frontmatter, now }),
      };
    }

    // regra só o usuário cria: nem trocando o tipo, nem dando tipo a uma nota que não tinha
    if (ctx.actor !== 'human' && isRuleType(given.type)) throw ruleRefused();
    const read = await existingNote(ctx, input.path);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(given)) {
      if (value === undefined) continue;
      if (MANAGED_ON_UPDATE.has(key)) {
        if (value !== read.note.frontmatter[key]) {
          warnings.push(
            warning('ignored_field', key, `"${key}" é preenchido pelo Cabeção; o valor enviado foi ignorado`),
          );
        }
        continue;
      }
      set[key] = value;
    }
    if ('trust' in set) {
      const { trust, warning: lowered } = agentTrust(ctx, set.trust);
      set.trust = trust;
      if (lowered !== null) warnings.push(lowered);
    }
    const remove =
      input.mode === 'overwrite' && input.frontmatter !== undefined
        ? Object.keys(read.note.frontmatter).filter((key) => !KEPT_ON_OVERWRITE.has(key) && !(key in set))
        : [];
    let body = input.content;
    if (input.mode === 'append') {
      const current = read.note.body;
      const eol = current.includes('\r\n') ? '\r\n' : '\n';
      const base = current === '' || current.endsWith('\n') ? current : `${current}${eol}`;
      const gap = base === '' || /\r?\n\r?\n$/.test(base) || base.trim() === '' ? '' : eol;
      body = `${base}${gap}${input.content}`;
    }
    const before = read.note.frontmatter;
    const sameText = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
    const changes =
      !sameText(body, read.note.body) ||
      Object.entries(set).some(([key, value]) => !isDeepStrictEqual(value, before[key])) ||
      remove.some((key) => key in before);
    const provenance = changes ? agentEditProvenance(ctx, before) : null;
    if (provenance !== null) {
      Object.assign(set, provenance.fields);
      warnings.push(provenance.warning);
    }
    checkUpdate(read, set, remove, day, config);
    return {
      target: { path: read.path, diskPath: read.diskPath },
      // todos os campos enviados (um que não mudou já está commitado e não é acusado)
      checks: [{ where: 'content', field: null, text: body }, ...frontmatterTargets(set, config)],
      warnings,
      apply: () =>
        updateNote(
          ctx.root,
          read.diskPath,
          { frontmatter: set, remove, body },
          { config, now, ifUnchangedSince: read.stamp },
        ),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// patch_page

export async function patchPage(ctx: BrainContext, input: PatchPageInput): Promise<WriteOutput> {
  if (!isRecord(input)) throw invalid('patch_page precisa de um objeto com path, old e new');
  if (typeof input.path !== 'string' || input.path === '') throw invalid('"path" deveria ser o caminho da nota');
  if (typeof input.old !== 'string' || input.old === '') throw invalid('"old" deveria ser o trecho exato a substituir');
  if (typeof input.new !== 'string') throw invalid('"new" deveria ser um texto');
  return executeWrite(ctx, input.session_handle, async (config) => {
    const read = await existingNote(ctx, input.path);
    const body = read.note.body;
    let [from, to] = [input.old, input.new];
    let count = occurrences(body, from);
    if (count === 0 && body.includes('\r\n') && !from.includes('\r')) {
      [from, to] = [from.replaceAll('\n', '\r\n'), to.replace(/\r?\n/g, '\r\n')];
      count = occurrences(body, from);
    }
    if (count === 0) {
      throw new BrainError('patch_not_found', `o trecho a substituir não aparece no corpo de ${read.path}`, {
        details: { path: read.path },
        nextStep: 'Leia a nota de novo com read e copie o trecho exato que quer substituir.',
      });
    }
    if (count > 1) {
      throw new BrainError(
        'ambiguous_patch',
        `o trecho a substituir aparece ${count} vezes no corpo de ${read.path}; ele precisa ser único`,
        {
          details: { path: read.path, occurrences: count },
          nextStep: 'Inclua mais contexto em old (linhas vizinhas) para o trecho aparecer uma vez só.',
        },
      );
    }
    const at = body.indexOf(from);
    const patched = body.slice(0, at) + to + body.slice(at + from.length);
    const provenance = patched === body ? null : agentEditProvenance(ctx, read.note.frontmatter);
    return {
      target: { path: read.path, diskPath: read.diskPath },
      checks: [{ where: 'content', field: null, text: patched }],
      warnings: provenance === null ? [] : [provenance.warning],
      apply: () =>
        patchNote(ctx.root, read.diskPath, input.old, input.new, {
          config,
          now: ctx.now(),
          ifUnchangedSince: read.stamp,
          ...(provenance === null ? {} : { frontmatter: provenance.fields }),
        }),
    };
  });
}
