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
  formatChangeLine,
  formatCommitMessage,
  GitError,
  headSha,
  isRepo,
  parseCommitTrailers,
  runGit,
  statusPorcelain,
} from '../git/index.ts';
import { scanFrontmatterSecrets, scanSecrets } from '../security/index.ts';
import { isConflictCopyPath } from '../sync/conflict-name.ts';
import { fileStamp, isUlid, ulid, writeFileAtomic } from '../util/index.ts';
import type { BrainConfig, NoteIssue, NoteRead, NoteType, WriteResult } from '../vault/index.ts';
import {
  appendLogLine,
  assertNotePath,
  createNote,
  diskCasePath,
  hasErrors,
  isBrainControlFile,
  isClientInstructionFile,
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
import type { Approval, ConfirmationFields, ConfirmOptions, Elevation } from './confirm.ts';
import {
  approvalFields,
  approvedLine,
  approvedTrailer,
  ConfirmationNeeded,
  candidateApproval,
  confirmationRequest,
  digestOf,
  gatesElevation,
  sourcesNotice,
  tokenOf,
  verifyConfirmToken,
} from './confirm.ts';
import type { BrainContext, WriteStep } from './context.ts';
import { machineName, rescan, withFreshIndex, withWriteLock } from './context.ts';
import { controlTarget, patchControl, writeControl } from './control.ts';
import type { IssueOutput, SecretHit } from './errors.ts';
import { BrainError, issueOutput, toBrainError } from './errors.ts';

// ---------------------------------------------------------------------------------------------------------------
// Tipos públicos

/**
 * Resultado de toda escrita. Numa ação elevada sem confirmação (`status: "confirmation_required"`), nada foi feito:
 * `op` vem vazio, `changed` é `false` e `summary`, `confirm_token` e `next_step` dizem o que fazer.
 */
export interface WriteOutput extends ConfirmationFields {
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
  /** Outros nomes da nota (`aliases`): também servem para achar menções sem link a ela. */
  readonly aliases?: readonly string[];
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
  /**
   * Resposta a um `remember` que voltou com `decision: needs_resolution` (ou para pular a procura de duplicatas):
   * `create`, `skip`, `update:<id>` ou `supersede:<id>`, com o id de uma das candidatas.
   */
  readonly resolution?: string;
  /** O token da primeira chamada de uma ação elevada (uma regra): só com pedido explícito do usuário. */
  readonly confirm_token?: string;
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
  /** O token da primeira chamada de uma ação elevada: só com pedido explícito do usuário. */
  readonly confirm_token?: string;
}

export interface PatchPageInput {
  readonly path: string;
  /** Trecho exato do corpo, que precisa aparecer uma única vez. */
  readonly old: string;
  readonly new: string;
  readonly session_handle?: string;
  /** O token da primeira chamada de uma ação elevada: só com pedido explícito do usuário. */
  readonly confirm_token?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Apoio

export function invalid(message: string, nextStep?: string): BrainError {
  return new BrainError('invalid_argument', message, nextStep === undefined ? {} : { nextStep });
}

export function invalidNote(path: string, issues: readonly NoteIssue[]): BrainError {
  const errors = issues.filter((issue) => issue.severity === 'error');
  return new BrainError('invalid_note', `nota inválida (${path}): ${errors.map((issue) => issue.message).join('; ')}`, {
    details: { path, issues: issues.map(issueOutput) },
    nextStep: 'Corrija os campos apontados em details.issues e tente de novo.',
  });
}

export function warning(code: string, field: string | null, message: string): IssueOutput {
  return { severity: 'warning', code, field, message };
}

export function ruleRefused(): BrainError {
  return new BrainError(
    'rule_requires_human',
    'regras (type: rule) vindas de um agente só com pedido explícito do usuário, pelo fluxo de confirmação',
    {
      nextStep:
        'Use remember ou write_page: a primeira chamada devolve o resumo e o confirm_token; só repita com o token se o usuário pedir. Sem pedido, grave como preferência (type: preference).',
    },
  );
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Campos que o Cabeção preenche; o que vier do chamador nesses campos é ignorado. */
const MANAGED_ON_CREATE = ['id', 'created', 'updated', 'origin', 'edited_by', 'approved_by', 'approved_at'] as const;
/** Campos que o Cabeção preenche numa alteração; o que vier do chamador nesses campos é ignorado. */
const MANAGED_ON_UPDATE: ReadonlySet<string> = new Set([
  'origin',
  'created',
  'updated',
  'edited_by',
  'approved_by',
  'approved_at',
]);
/** Campos mantidos num `overwrite` mesmo quando o frontmatter enviado não os traz. */
const KEPT_ON_OVERWRITE = new Set([
  'id',
  'type',
  'created',
  'updated',
  'origin',
  'trust',
  'edited_by',
  'approved_by',
  'approved_at',
]);

/** `type: rule`, com qualquer caixa e espaço em volta (o banco guarda o tipo sem os espaços). */
export const isRuleType = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().toLowerCase() === 'rule';
/** Texto de um campo para comparar: sem espaços em volta e em minúsculas. */
const fieldKey = (value: unknown): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

const RULES_DIR_PREFIX = `${NOTE_TYPE_DIRS.rule.toLowerCase()}/`;
const RAW_DIR_PREFIX = `${RAW_DIR.toLowerCase()}/`;

/**
 * Cópia de conflito do sync: um agente nunca cria nem altera uma (proteção técnica: só o sync as cria), com ou sem
 * confirmação. `path` já vem canônico.
 */
export function assertNotConflictCopy(ctx: BrainContext, path: string): void {
  if (ctx.actor === 'human') return;
  if (isConflictCopyPath(path) || isConflictCopyPath(path.toLowerCase())) {
    throw new BrainError(
      'invalid_path',
      `${path} tem o formato de uma cópia de conflito do sync (nota.conflict-<máquina>-<data>.md); só o sync cria essas cópias, e um agente não cria nem altera uma`,
      {
        details: { path },
        nextStep:
          'Para resolver um conflito, leia a cópia e junte o que importa na nota original (o caminho sem ".conflict-..."); apagar a cópia é com o usuário. Para uma nota nova, escolha outro nome.',
      },
    );
  }
}

/** O que torna elevada a escrita numa nota (decisão 37): os motivos, para o resumo da confirmação. */
export interface NoteElevationInput {
  readonly path: string;
  readonly kind: 'create' | 'update';
  /** `type` enviado (frontmatter da criação ou da alteração). */
  readonly givenType?: unknown;
  /** Frontmatter atual da nota, numa alteração. */
  readonly before?: Readonly<Record<string, unknown>>;
  /** O chamador pediu `trust: high` (e a nota ainda não tinha). */
  readonly trustHigh?: boolean;
}

/**
 * Motivos que tornam elevada uma escrita numa nota. Vazio quando a escrita é comum, ou quando quem escreve é o usuário
 * sem a confirmação ligada (`confirmElevated`). Para o usuário só contam regra, `raw/` e arquivo de instrução; para um
 * agente também `trust: high` e uma nota que o usuário aprovou.
 */
export function noteElevationReasons(ctx: BrainContext, input: NoteElevationInput): string[] {
  if (!gatesElevation(ctx)) return [];
  const reasons: string[] = [];
  const key = input.path.toLowerCase();
  if (isRuleType(input.givenType) || isRuleType(input.before?.type) || key.startsWith(RULES_DIR_PREFIX)) {
    reasons.push('regra (type: rule ou memory/rules/): vira instrução para os agentes nos próximos recall');
  }
  if (isBrainControlFile(input.path, ctx.config) || isClientInstructionFile(input.path)) {
    reasons.push(
      'arquivo com nome de instrução de cliente de IA: clientes como Claude Code, Codex e Gemini CLI o carregam como instrução',
    );
  }
  if (input.kind === 'update' && key.startsWith(RAW_DIR_PREFIX)) {
    reasons.push(`fonte imutável de ${RAW_DIR}/: alterar muda o registro do que foi ingerido`);
  }
  if (ctx.actor === 'agent') {
    if (input.trustHigh === true) reasons.push('"trust: high": a confiança que é do usuário');
    const approved = input.before?.approved_by;
    if (typeof approved === 'string' && approved.trim() !== '' && !reasons.some((r) => r.startsWith('regra'))) {
      reasons.push('nota aprovada pelo usuário (approved_by): alterar exige a mesma aprovação');
    }
  }
  return reasons;
}

/** Resumo de uma escrita em nota, para a confirmação. */
export function noteSummary(
  action: string,
  path: string,
  reasons: readonly string[],
  content: string,
  extra = '',
): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const start = flat.length <= 280 ? flat : `${flat.slice(0, 280)}…`;
  return `${action} ${path}${extra === '' ? '' : ` (${extra})`}. Por quê pede confirmação: ${reasons.join('; ')}. Conteúdo: ${content.length.toLocaleString('pt-BR')} caracteres, começando com "${start}"`;
}

/**
 * O que um agente nunca grava SEM CONFIRMAÇÃO, nos caminhos que não têm o fluxo de confirmação (a ingestão, que só
 * cria fontes em `raw/`). As escritas com confirmação (`write_page`, `patch_page`, `remember`, `relate`) usam
 * `noteElevationReasons`. O usuário, pela CLI, não passa por aqui:
 *
 * - os arquivos de controle do cérebro (`AGENTS.md`, `CLAUDE.md`, catálogo, diário...), mesmo com `noteDirs: ["."]`;
 * - em QUALQUER pasta, um arquivo com nome de instrução de cliente de IA (`CLIENT_INSTRUCTION_FILES` do vault:
 *   `wiki/CLAUDE.md`, `memory/gemini.md`...);
 * - um caminho no formato de cópia de conflito do sync (`nota.conflict-<máquina>-<data>.md`): só o sync as cria;
 * - nada em `memory/rules/`: regras só o usuário cria;
 * - numa alteração (`overwrite`, `append`, `patch_page`), nada em `raw/`, onde ficam as fontes imutáveis.
 *
 * `path` já vem canônico, com a grafia do disco.
 */
export function assertAgentMayWrite(ctx: BrainContext, path: string, kind: 'create' | 'update'): void {
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
  if (isClientInstructionFile(path)) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    throw new BrainError(
      'invalid_path',
      `${path} tem o nome de um arquivo de instrução de cliente de IA (${name}); clientes como Claude Code, Codex e Gemini CLI o carregariam como instrução, então um agente não cria nem altera arquivo com esse nome em nenhuma pasta do cérebro`,
      {
        details: { path },
        nextStep: `Grave o conteúdo numa nota com outro nome (por exemplo "${name.replace(/\.md$/i, '')} (notas).md"). Instruções para agentes só o usuário escreve.`,
      },
    );
  }
  const key = path.toLowerCase();
  if (isConflictCopyPath(path) || isConflictCopyPath(key)) {
    throw new BrainError(
      'invalid_path',
      `${path} tem o formato de uma cópia de conflito do sync (nota.conflict-<máquina>-<data>.md); só o sync cria essas cópias, e um agente não cria nem altera uma`,
      {
        details: { path },
        nextStep:
          'Para resolver um conflito, leia a cópia e junte o que importa na nota original (o caminho sem ".conflict-..."); apagar a cópia é com o usuário. Para uma nota nova, escolha outro nome.',
      },
    );
  }
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
 * Proveniência de uma nota que NÃO foi criada por um agente (sem `origin`, `origin: human` ou `ingest:<fonte>`, como
 * as notas de um vault adotado), ou que o usuário marcou com `trust: high`, quando um agente vai alterá-la:
 * `edited_by` registra o agente, e `trust` cai para `medium` se era `high` (ou se não havia e a origem é humana). Sem
 * isso, o texto escrito pelo agente seria servido com a autoridade do usuário. `null` quando não se aplica (nota de
 * agente sem `trust: high`).
 */
export function agentEditProvenance(
  ctx: BrainContext,
  before: Readonly<Record<string, unknown>>,
  approval: Approval | null = null,
): { fields: Record<string, unknown>; warning: IssueOutput } | null {
  if (ctx.actor === 'human') return null;
  const trust = fieldKey(before.trust);
  const origin = fieldKey(before.origin);
  const byAgent = typeof origin === 'string' && origin.startsWith('agent:');
  if (approval !== null) {
    // alteração confirmada pelo usuário: a confiança fica como está, e a nota registra o agente e a aprovação
    const fields: Record<string, unknown> = {
      ...(byAgent ? {} : { edited_by: `agent:${ctx.client}` }),
      ...approvalFields(ctx, approval),
    };
    return {
      fields,
      warning: warning(
        'approved',
        'approved_by',
        `alteração feita por um agente com confirmação do usuário: gravada com "approved_by: user"${byAgent ? '' : ` e "edited_by: agent:${ctx.client}"`}`,
      ),
    };
  }
  if (byAgent && trust !== 'high') return null;
  const lower = trust === 'high' || ((trust === undefined || trust === null || trust === '') && origin === 'human');
  const editedBy = `agent:${ctx.client}`;
  const fields: Record<string, unknown> = { ...(lower ? { trust: 'medium' } : {}), edited_by: editedBy };
  const whose =
    trust === 'high'
      ? 'trust: high'
      : typeof origin === 'string' && origin !== ''
        ? `origin: ${String(before.origin).trim()}`
        : 'sem origin, escrita fora do Cabeção';
  return {
    fields,
    warning: warning(
      'provenance_changed',
      lower ? 'trust' : 'edited_by',
      `a nota não foi criada por um agente (${whose}); como um agente alterou o conteúdo, ela foi gravada com ${lower ? '"trust: medium" e ' : ''}"edited_by: ${editedBy}"`,
    ),
  };
}

/** `Nota`, `pasta/Nota` ou `[[Nota]]` → `[[Nota]]`; o que não serve de nome de nota (uma URL) fica como veio. */
export function toLink(value: string): string {
  const text = value.trim();
  // `isWikilinkText` estreita o tipo; aplicado a uma cópia, não transforma `text` em `never` no ramo falso
  if (isWikilinkText(`${text}`)) return text;
  return /^[^[\]\n|#]+$/.test(text) && !text.includes('://') ? `[[${text}]]` : text;
}

export function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw invalid(`"${name}" deveria ser uma lista de textos`);
  }
  return value.map((item: string) => item.trim());
}

export function sessionOf(value: unknown): string | undefined {
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
export function titleFromContent(content: string): string {
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

export interface ScanTarget {
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

/** Todos os textos de um valor do frontmatter: ele mesmo, os itens das listas e as chaves e valores dos mapas. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsIn(item, out);
    }
  }
  return out;
}

/**
 * O que passa pelo scanner de cada campo do frontmatter: o YAML serializado (o que vai para o arquivo) e, para um
 * campo novo ou alterado (diferente de `before`), a chave e cada texto do valor, crus. O YAML serializado sozinho não
 * basta: o serializador escreve um caractere de controle como escape (`"\x01ghp_..."`, `"\aghp_..."`), e a letra do
 * escape colada no token derruba a fronteira das regras.
 */
/**
 * Possíveis segredos NOVOS nos valores já decodificados do frontmatter de uma edição feita fora do Cabeção (o
 * texto cru já passou por `newSecrets`; um achado na mesma linha e regra não se repete). O marcador vale (é texto do
 * usuário), na linha do YAML.
 */
function newFrontmatterSecrets(
  text: string,
  previous: ReadonlySet<string>,
  path: string,
  already: readonly SecretHit[],
): SecretHit[] {
  const seen = new Set(already.map((hit) => `${hit.line}\0${hit.rule}`));
  const out: SecretHit[] = [];
  for (const finding of scanFrontmatterSecrets(text, { honorAllowMarker: true })) {
    const key = `${finding.line}\0${finding.rule}`;
    if (seen.has(key) || previous.has(finding.source)) continue;
    seen.add(key);
    out.push({
      where: 'pending',
      field: path,
      line: finding.line,
      column: finding.column,
      rule: finding.rule,
      description: finding.description,
    });
  }
  return out;
}

export function frontmatterTargets(
  fields: Readonly<Record<string, unknown>>,
  config: BrainConfig,
  before: Readonly<Record<string, unknown>> = {},
): ScanTarget[] {
  const targets: ScanTarget[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    targets.push({ where: 'frontmatter', field: key, text: serializeFrontmatter({ [key]: value }, config) });
    if (isDeepStrictEqual(value, before[key])) continue;
    for (const text of [key, ...stringsIn(value)]) targets.push({ where: 'frontmatter', field: key, text });
  }
  return targets;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const CONTROL_IN_VALUE_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const CONTROL_IN_NAME_RE = /[\u0000-\u001F\u007F-\u009F]/;
/**
 * Caracteres invisíveis de formatação num caminho: espaço de largura zero, marcas e embutidos de direção, BOM, hífen
 * suave. Fazem um nome parecer outro (`AGENTS\u200B.md` aparece como `AGENTS.md`). O U+200D (que junta emojis)
 * continua aceito.
 */
const INVISIBLE_IN_PATH_RE = /[\u00AD\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
/** Metade de um par substituto do UTF-16 sem a outra metade: não vira UTF-8 válido. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Recusa, em texto vindo de agente, caractere de controle (C0, DEL e C1) e metade solta de par substituto; no caminho,
 * também os invisíveis de formatação. Num valor do frontmatter, `\n` e `\t` são aceitos (texto em várias linhas); no
 * título, nas chaves e no caminho, nenhum. Esses caracteres
 * não têm uso numa nota e, no YAML, viram escapes que escondem o que vem colado a eles.
 */
export function assertAgentText(ctx: BrainContext, text: string, where: string, kind: 'value' | 'name' | 'path'): void {
  if (ctx.actor === 'human') return;
  const invisible = kind === 'path' ? INVISIBLE_IN_PATH_RE.exec(text) : null;
  if (invisible !== null) {
    const code = (invisible[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    throw invalid(
      `${where} tem um caractere invisível (U+${code}) que faz o nome parecer outro`,
      'Use um caminho só com caracteres visíveis e tente de novo.',
    );
  }
  const control = (kind === 'value' ? CONTROL_IN_VALUE_RE : CONTROL_IN_NAME_RE).exec(text);
  const lone = control === null ? LONE_SURROGATE_RE.exec(text) : null;
  const bad = control ?? lone;
  if (bad === null) return;
  const code = (bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
  throw invalid(
    `${where} tem um caractere que não pode ir para o cérebro (U+${code}, ${control === null ? 'metade de um par substituto' : 'caractere de controle'})`,
    kind === 'value'
      ? 'Tire os caracteres de controle do texto (só quebra de linha e tabulação são aceitas) e tente de novo.'
      : 'Tire os caracteres de controle (inclusive quebras de linha e tabulações) e tente de novo.',
  );
}

/** Confere, recursivamente, as chaves e os textos dos campos do frontmatter enviados por um agente. */
export function assertAgentFields(ctx: BrainContext, fields: Readonly<Record<string, unknown>>): void {
  if (ctx.actor === 'human') return;
  for (const [key, value] of Object.entries(fields)) {
    assertAgentText(ctx, key, `o nome do campo ${JSON.stringify(key)}`, 'name');
    // o título vira nome de arquivo, assunto de commit e linha do catálogo: nem quebra de linha
    const kind = key === 'title' ? 'name' : 'value';
    for (const text of stringsIn(value)) assertAgentText(ctx, text, `o campo "${key}"`, kind);
  }
}

/**
 * Um corpo de agente que começa com BOM (U+FEFF) é recusado: o parser descarta o BOM antes de procurar o frontmatter,
 * e um `---` logo depois dele viraria frontmatter numa nota que não tinha (a camada do vault ainda confere o texto
 * relido, de qualquer jeito).
 */
export function assertNoLeadingBom(ctx: BrainContext, body: string, before = ''): void {
  // um corpo que já começava com o caractere (nota editada à mão) não trava a escrita: só o que o agente introduz
  if (ctx.actor === 'human' || body.charCodeAt(0) !== 0xfeff || before.charCodeAt(0) === 0xfeff) return;
  throw invalid(
    'o conteúdo começa com o caractere invisível BOM (U+FEFF), que faria o começo do texto ser lido como frontmatter',
    'Tire o BOM do começo do conteúdo e mande os campos em "frontmatter".',
  );
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

export async function git(ctx: BrainContext, args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
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

export async function commitMessage(
  ctx: BrainContext,
  input: {
    op: string;
    session: string | undefined;
    client: string;
    body: readonly (string | CommitChange)[];
    numFiles: number;
    /** Rodapé `Cabecao-Approved` de uma ação confirmada pelo usuário. */
    approved?: string;
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
      ...(input.approved === undefined ? {} : { approved: input.approved }),
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

/** Um passo de uma escrita: uma nota criada, alterada ou movida. */
export interface Prepared {
  /** Nota existente que será alterada (caminho canônico e caminho no disco); `null` numa criação. */
  readonly target: { readonly path: string; readonly diskPath: string } | null;
  /** O que passa pelo scanner de segredos. */
  readonly checks: readonly ScanTarget[];
  readonly warnings: readonly IssueOutput[];
  /** Grava pelo vault (passo 3). Recebe o resultado dos passos anteriores da mesma operação. */
  apply(previous: readonly WriteResult[]): Promise<WriteResult>;
  /** Linha do corpo do commit; padrão: `toCommitChange(result)` (`add gotcha: título`). */
  change?(result: WriteResult): CommitChange;
  /** A escrita é elevada (decisão 37): só com confirmação. Ausente ou sem motivos: escrita comum. */
  readonly elevation?: Elevation;
}

/** Confirmação de uma escrita: a tool (para o token e as mensagens), o token enviado e as opções de quem chama. */
export interface WriteConfirm {
  readonly tool: string;
  readonly token?: string | undefined;
  readonly options?: ConfirmOptions | undefined;
  /** Já conferida por quem chama (o `remember` confere antes da procura de duplicatas). */
  readonly approved?: Approval | null;
}

/** Monta a função `prepare` recebe a configuração e a aprovação candidata (que só vale se a escrita for elevada). */
export type PrepareBatch = (config: BrainConfig, approval: Approval | null) => Promise<PreparedBatch>;

/**
 * Uma operação que grava várias notas num commit só (doc 12: "uma operação que toca várias notas é um commit, com
 * uma linha por nota no corpo"): substituição de uma memória, handoff com episódio, ingestão, arquivamento.
 */
export interface PreparedBatch {
  readonly steps: readonly Prepared[];
  /** Primeira linha do corpo do commit (`consolidate: semana 46`); sem ela, a primeira linha é a do primeiro passo. */
  readonly header?: string;
}

/** Resultado de uma escrita de vários passos. */
export interface BatchOutput {
  readonly op: string;
  /** SHA do commit; `null` quando nada mudou. */
  readonly commit: string | null;
  /** Um por passo, na ordem. */
  readonly results: readonly WriteResult[];
  readonly changed: boolean;
  readonly warnings: readonly IssueOutput[];
  /** Linhas do corpo do commit (sem o cabeçalho), uma por nota alterada. */
  readonly changes: readonly string[];
  /** A aprovação que valeu, numa escrita elevada; `null` numa escrita comum. */
  readonly approval: Approval | null;
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

/** Releitura do `.cabecao.json` e do HEAD, comum a toda escrita (já sob a trava). Devolve o HEAD. */
export async function refreshForWrite(ctx: BrainContext): Promise<string> {
  try {
    ctx.config = await readBrainConfig(ctx.root);
  } catch (error) {
    throw toBrainError(error);
  }
  return requireHead(ctx);
}

export async function executeWrite(
  ctx: BrainContext,
  sessionHandle: unknown,
  prepare: (config: BrainConfig, approval: Approval | null) => Promise<Prepared>,
  confirm?: WriteConfirm,
): Promise<WriteOutput> {
  let out: BatchOutput;
  try {
    out = await executeBatch(
      ctx,
      sessionHandle,
      async (config, approval) => ({ steps: [await prepare(config, approval)] }),
      confirm,
    );
  } catch (error) {
    if (!(error instanceof ConfirmationNeeded)) throw error;
    return {
      op: '',
      path: error.path,
      id: null,
      action: error.action,
      changed: false,
      commit: null,
      warnings: [],
      ...error.request,
    };
  }
  const result = out.results[0];
  if (result === undefined) throw new BrainError('invalid_argument', 'a escrita não montou nenhuma nota');
  return {
    op: out.op,
    path: result.path,
    id: result.id,
    action: result.action === 'add' ? 'add' : 'update',
    changed: out.changed,
    commit: out.commit,
    warnings: out.warnings,
    ...(out.approval === null ? {} : { confirmed_by: out.approval.by }),
    ...(out.changed ? {} : { next_step: 'A nota já estava assim; nada foi gravado.' }),
  };
}

/**
 * O fluxo de escrita inteiro (validação, scanner de segredos, gravação atômica, banco, catálogo, diário e UM commit)
 * para uma operação de um ou mais passos, sob a trava da pasta de trabalho. `prepare` valida e monta os passos, que
 * gravam em ordem; uma falha em qualquer passo desfaz todos.
 */
export async function executeBatch(
  ctx: BrainContext,
  sessionHandle: unknown,
  prepare: PrepareBatch,
  confirm?: WriteConfirm,
): Promise<BatchOutput> {
  const session = sessionOf(sessionHandle);
  return withWriteLock(ctx, () => executeBatchLocked(ctx, session, prepare, confirm));
}

/** Junta as elevações dos passos de uma operação; `null` quando nenhum passo é elevado. */
function mergedElevation(steps: readonly Prepared[]): Elevation | null {
  const elevated = steps.flatMap((step) =>
    step.elevation === undefined || step.elevation.reasons.length === 0 ? [] : [step.elevation],
  );
  if (elevated.length === 0) return null;
  return {
    reasons: [...new Set(elevated.flatMap((item) => item.reasons))],
    summary: elevated.map((item) => item.summary).join(' Também: '),
    parts: [digestOf(elevated.map((item) => item.parts))],
  };
}

/** `executeBatch` para quem já segura a trava de escrita. */
export async function executeBatchLocked(
  ctx: BrainContext,
  session: string | undefined,
  prepare: PrepareBatch,
  confirm?: WriteConfirm,
): Promise<BatchOutput> {
  const op = ulid();
  const head = await refreshForWrite(ctx);
  const token = tokenOf(confirm?.token);
  const candidate =
    confirm?.approved !== undefined && confirm.approved !== null
      ? confirm.approved
      : candidateApproval(ctx, token, confirm?.options);

  // 1. Validação (argumentos, caminho, esquema).
  let batch: PreparedBatch;
  try {
    batch = await prepare(ctx.config, gatesElevation(ctx) ? candidate : null);
  } catch (error) {
    throw toBrainError(error);
  }
  if (batch.steps.length === 0) throw new BrainError('invalid_argument', 'a operação não tem nada a gravar');
  const elevation = gatesElevation(ctx) ? mergedElevation(batch.steps) : null;

  // 2. Scanner de segredos: no conteúdo, nos campos, no caminho e nas edições de fora que iriam junto. As edições
  // de fora são do usuário (o marcador vale nelas); o texto da operação vale pelo `actor`.
  const targets = batch.steps.flatMap((step) => (step.target === null ? [] : [step.target.diskPath]));
  const previousOf = new Map<string, Set<string>>();
  for (const target of targets) {
    if (!previousOf.has(target)) previousOf.set(target, await committedLines(ctx, head, target));
  }
  const secrets: SecretHit[] = [];
  const pending = await pendingEdits(ctx, [...targets, LOG_MD]);
  for (const path of pending) {
    const data = await readFile(join(ctx.root, ...path.split('/')), 'utf8').catch(() => null); // apagado: nada a ler
    if (data === null) continue;
    const committed = await committedLines(ctx, head, path);
    const raw = newSecrets(data, committed, 'pending', path, true);
    secrets.push(...raw);
    if (/\.md$/i.test(path)) secrets.push(...newFrontmatterSecrets(data, committed, path, raw));
    // a edição do usuário entra num commit `edit` antes da operação: as linhas dela já não são "novas"
    const previous = previousOf.get(path);
    if (previous !== undefined) for (const line of linesOf(data)) previous.add(line);
  }
  const honorAllowMarker = ctx.actor === 'human';
  for (const step of batch.steps) {
    const previous = (step.target === null ? undefined : previousOf.get(step.target.diskPath)) ?? new Set<string>();
    for (const check of step.checks) {
      secrets.push(...newSecrets(check.text, previous, check.where, check.field, honorAllowMarker));
    }
  }
  if (secrets.length > 0) throw secretError(secrets);

  // 2b. Ação elevada (decisão 37): sem confirmação, nada é gravado e volta o resumo com o token. Uma aprovação já
  // conferida por quem chama (o `remember`) vale para a operação inteira.
  let approval: Approval | null = confirm?.approved ?? null;
  if (elevation !== null && approval === null) {
    const tool = confirm?.tool ?? 'write_page';
    if (candidate === null) {
      const first = batch.steps.find((step) => (step.elevation?.reasons.length ?? 0) > 0);
      throw new ConfirmationNeeded(await confirmationRequest(ctx, tool, elevation, session ?? ''), {
        path: first?.elevation?.path ?? first?.target?.path ?? '',
        action: first?.target === null || first?.target === undefined ? 'add' : 'update',
      });
    } else {
      if (candidate.by === 'token' && token !== undefined) {
        await verifyConfirmToken(ctx, tool, elevation.parts, session ?? '', token, tool);
      }
      approval = candidate;
    }
  }

  if (pending.length > 0) {
    try {
      await commitPendingEdits(ctx, pending);
    } catch (error) {
      throw toBrainError(error);
    }
  }

  // 3. Gravação atômica pelo vault, passo a passo.
  const indexMd = ctx.config.indexMd;
  const snapshot = await takeSnapshot(ctx, [...targets, indexMd, LOG_MD]);
  const results: WriteResult[] = [];
  const warnings: IssueOutput[] = [];
  try {
    for (const step of batch.steps) {
      const result = await step.apply(results);
      results.push(result);
      warnings.push(...step.warnings, ...result.warnings.map(issueOutput));
      for (const path of [result.path, ...(result.from === undefined ? [] : [result.from])]) {
        if (!snapshot.has(path)) snapshot.set(path, null);
      }
    }
  } catch (error) {
    // o vault não grava nada quando recusa; o que os passos anteriores gravaram volta
    if (results.some((result) => result.changed)) await rollback(ctx, snapshot);
    throw toBrainError(error);
  }
  const lines = batch.steps.map((step, i) => {
    const result = results[i];
    return result === undefined || !result.changed ? null : (step.change?.(result) ?? toCommitChange(result));
  });
  const changes = lines.filter((line): line is CommitChange => line !== null).map(formatChangeLine);
  if (changes.length === 0) return { op, commit: null, results, changed: false, warnings, changes, approval };

  const before = await headSha(ctx.root).catch(() => head);
  try {
    await fault(ctx, 'written');
    // 4. Banco local, e o catálogo calculado dele na mesma passada.
    const catalog = await withFreshIndex(ctx, () => catalogFromIndex(ctx));
    await fault(ctx, 'indexed');
    await writeIndexMd(ctx.root, ctx.config, catalog);
    for (const line of lines) {
      if (line === null) continue;
      await appendLogLine(ctx.root, {
        action: line.action,
        type: line.noteType ?? null,
        title: line.title,
        date: ctx.now(),
      });
    }
    await fault(ctx, 'cataloged');
    // 5. Um commit com as notas, o catálogo e o diário.
    const paths = [
      ...new Set([
        ...results.flatMap((result) =>
          result.changed ? [result.path, ...(result.from === undefined ? [] : [result.from])] : [],
        ),
        indexMd,
        LOG_MD,
      ]),
    ];
    const header = batch.header?.trim();
    const body: (string | CommitChange)[] =
      header === undefined || header === ''
        ? lines.filter((line): line is CommitChange => line !== null)
        : [header, ...changes.map((line) => `- ${line}`)];
    if (approval !== null && ctx.actor === 'agent') body.push(approvedLine(approval));
    const message = await commitMessage(ctx, {
      op,
      session,
      client: ctx.client,
      body,
      numFiles: paths.length,
      ...(approval !== null && ctx.actor === 'agent' ? { approved: approvedTrailer(approval) } : {}),
    });
    const commit = await commitPaths(ctx.root, paths, message);
    return { op, commit, results, changed: true, warnings, changes, approval };
  } catch (error) {
    // o commit pode ter saído e a falha ter vindo depois (ao ler o HEAD): aí a operação valeu
    const now = await headSha(ctx.root).catch(() => before);
    if (now !== null && now !== before) {
      const shown = await git(ctx, ['log', '-1', '--format=%B', now]);
      if (parseCommitTrailers(shown.stdout).op === op) {
        return { op, commit: now, results, changed: true, warnings, changes, approval };
      }
    }
    await rollback(ctx, snapshot);
    throw toBrainError(error);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// remember

/**
 * Confere o que não depende da configuração: o objeto, o tipo e o conteúdo. Devolve o tipo. Uma regra vinda de agente
 * só passa com `approval` (a confirmação é conferida antes, por quem chama).
 */
export function checkMemoryInput(ctx: BrainContext, input: RememberInput, approval: Approval | null = null): NoteType {
  if (!isRecord(input)) throw invalid('remember precisa de um objeto com content e type');
  if (!isNoteType(input.type)) {
    throw invalid(
      `"type" deveria ser um tipo de nota (preference, gotcha, decision, fact...); veio ${JSON.stringify(input.type)}`,
    );
  }
  const type: NoteType = input.type;
  if (type === 'rule' && ctx.actor !== 'human' && approval === null) throw ruleRefused();
  if (typeof input.content !== 'string') throw invalid('"content" deveria ser um texto');
  assertNoLeadingBom(ctx, input.content);
  return type;
}

/** Uma memória nova pronta para gravar: o passo do fluxo de escrita e o frontmatter montado. */
export interface PreparedMemory extends Prepared {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly type: NoteType;
}

/**
 * Valida e monta a nota de uma memória nova (o passo `create` do `remember`). `extra` são campos que o Cabeção
 * acrescenta (o `supersedes` de uma substituição), já validados por quem chama. `approval`: a regra foi confirmada
 * pelo usuário (vai para `approved_by` e `approved_at`).
 */
export function prepareMemory(
  ctx: BrainContext,
  input: RememberInput,
  config: BrainConfig,
  extra: Readonly<Record<string, unknown>> = {},
  approval: Approval | null = null,
): PreparedMemory {
  const type = checkMemoryInput(ctx, input, approval);
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
  if (input.aliases !== undefined) fields.aliases = stringList(input.aliases, 'aliases');
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

  assertAgentFields(ctx, fields);
  const approved = type === 'rule' ? approvalFields(ctx, approval) : {};
  const frontmatter: Record<string, unknown> = {
    id: ulid(now.getTime()),
    type,
    ...fields,
    ...extra,
    trust: ctx.actor === 'human' ? 'high' : 'medium',
    origin,
    ...approved,
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
    type,
    frontmatter,
    target: null,
    checks: [{ where: 'content', field: null, text: input.content }, ...frontmatterTargets(fields, config)],
    warnings: [],
    apply: () => createNote(ctx.root, config, { type, origin, body: input.content, frontmatter, now }),
  };
}

/** Cria uma memória, sem procurar duplicatas (o `remember` com duplicatas e contradições mora em `remember.ts`). */
export async function createMemory(ctx: BrainContext, input: RememberInput): Promise<WriteOutput> {
  checkMemoryInput(ctx, input);
  return executeWrite(ctx, input.session_handle, async (config) => prepareMemory(ctx, input, config));
}

// ---------------------------------------------------------------------------------------------------------------
// write_page

/** `trust: high` enviado por um agente: é elevado (só com confirmação). */
const asksTrustHigh = (ctx: BrainContext, value: unknown): boolean =>
  ctx.actor === 'agent' && typeof value === 'string' && value.trim().toLowerCase() === 'high';

/**
 * Lê uma nota existente para alterá-la: caminho canônico (com a grafia do disco), dentro das pastas de notas e que
 * não é cópia de conflito (para um agente). As restrições de AUTORIDADE (regra, `raw/`...) não moram aqui: quem altera
 * calcula a elevação com `noteElevationReasons` e passa pelo fluxo de confirmação.
 */
export async function existingNote(ctx: BrainContext, path: string): Promise<NoteRead> {
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
  assertNotConflictCopy(ctx, canonical);
  return readNote(ctx.root, canonical);
}

/**
 * `existingNote` para quem confirma ANTES (o `remember`): recusa a nota elevada sem aprovação, com a explicação de
 * como fazer.
 */
export async function existingNoteApproved(
  ctx: BrainContext,
  path: string,
  approval: Approval | null,
): Promise<NoteRead> {
  const read = await existingNote(ctx, path);
  const reasons = noteElevationReasons(ctx, { path: read.path, kind: 'update', before: read.note.frontmatter });
  if (reasons.length > 0 && approval === null) {
    if (reasons.some((reason) => reason.startsWith('regra'))) throw ruleRefused();
    throw new BrainError(
      'invalid_path',
      `${read.path} só se altera com confirmação do usuário: ${reasons.join('; ')}`,
      {
        details: { path: read.path },
        nextStep: 'Use write_page ou patch_page nessa nota: a primeira chamada devolve o resumo e o confirm_token.',
      },
    );
  }
  return read;
}

/** Valida o resultado de uma alteração: só os erros que ela introduz contam (como no vault). */
export function checkUpdate(
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

/** As partes que o token amarra numa escrita em nota: o que será gravado e o conteúdo atual do alvo. */
export function noteParts(action: string, path: string, payload: unknown, current: string | null): string[] {
  return [action, path, digestOf(payload), digestOf(current ?? '\u0000none')];
}

export async function writePage(
  ctx: BrainContext,
  input: WritePageInput,
  options: ConfirmOptions = {},
): Promise<WriteOutput> {
  if (!isRecord(input)) throw invalid('write_page precisa de um objeto com path, content e mode');
  if (!WRITE_MODES.includes(input.mode)) throw invalid('"mode" deveria ser "create", "overwrite" ou "append"');
  if (typeof input.path !== 'string' || input.path === '') throw invalid('"path" deveria ser o caminho da nota');
  if (typeof input.content !== 'string') throw invalid('"content" deveria ser um texto');
  if (input.frontmatter !== undefined && !isRecord(input.frontmatter))
    throw invalid('"frontmatter" deveria ser um objeto');
  const token = tokenOf(input.confirm_token);
  assertAgentText(ctx, input.path, 'o caminho', 'path');
  // arquivo de controle (AGENTS.md, CLAUDE.md, .cabecao.json...): texto puro, sempre elevado para um agente
  const control = controlTarget(input.path, ctx.config);
  if (control !== null) return writeControl(ctx, control, input, token, options);
  const given: Readonly<Record<string, unknown>> = input.frontmatter ?? {};
  assertAgentFields(ctx, given);
  const confirm: WriteConfirm = { tool: 'write_page', token, options };

  return executeWrite(
    ctx,
    input.session_handle,
    async (config, approval) => {
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
        assertNotConflictCopy(ctx, path);
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
        const reasons = noteElevationReasons(ctx, {
          path,
          kind: 'create',
          givenType: type,
          trustHigh: asksTrustHigh(ctx, fields.trust),
        });
        const approved = reasons.length > 0 ? approval : null;
        const origin = ctx.actor === 'human' ? 'human' : `agent:${ctx.client}`;
        const frontmatter: Record<string, unknown> = {
          ...fields,
          id: ulid(now.getTime()),
          origin,
          ...approvalFields(ctx, approved),
          created: day,
          updated: day,
        };
        // na primeira chamada (sem aprovação), a nota elevada é validada como ficaria aprovada: o que se confere aqui
        // é o resto dela, para o usuário não confirmar algo que depois seria recusado
        const probe =
          reasons.length > 0 && approved === null
            ? { ...frontmatter, ...approvalFields(ctx, { by: 'token', day }) }
            : frontmatter;
        const issues = validateNote({ frontmatter: probe, path }, config);
        if (hasErrors(issues)) throw invalidNote(path, issues);
        assertNoLeadingBom(ctx, input.content);
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
          ...(reasons.length === 0
            ? {}
            : {
                elevation: {
                  reasons,
                  path,
                  summary: `${noteSummary('Criar a nota', path, reasons, input.content, `type: ${type}`)}.${sourcesNotice(fields.sources)}`,
                  parts: noteParts('create', path, { fields, content: input.content }, null),
                },
              }),
          apply: () => createNote(ctx.root, config, { type, origin, path, body: input.content, frontmatter, now }),
        };
      }

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
      const before = read.note.frontmatter;
      const reasons = noteElevationReasons(ctx, {
        path: read.path,
        kind: 'update',
        givenType: given.type,
        before,
        trustHigh: asksTrustHigh(ctx, set.trust) && fieldKey(before.trust) !== 'high',
      });
      const approved = reasons.length > 0 ? approval : null;
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
      const sameText = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
      const changes =
        !sameText(body, read.note.body) ||
        Object.entries(set).some(([key, value]) => !isDeepStrictEqual(value, before[key])) ||
        remove.some((key) => key in before);
      const provenance = changes ? agentEditProvenance(ctx, before, approved) : null;
      if (provenance !== null) {
        Object.assign(set, provenance.fields);
        warnings.push(provenance.warning);
      }
      checkUpdate(read, set, remove, day, config);
      assertNoLeadingBom(ctx, body, input.mode === 'append' ? read.note.body : '');
      return {
        target: { path: read.path, diskPath: read.diskPath },
        // todos os campos enviados (um que não mudou já está commitado e não é acusado)
        checks: [{ where: 'content', field: null, text: body }, ...frontmatterTargets(set, config, before)],
        warnings,
        ...(reasons.length === 0 || !changes
          ? {}
          : {
              elevation: {
                reasons,
                path: read.path,
                summary: noteSummary(
                  input.mode === 'append' ? 'Acrescentar ao fim da nota' : 'Substituir o conteúdo da nota',
                  read.path,
                  reasons,
                  input.content,
                  `${String(before.type ?? 'sem tipo')}, origin ${String(before.origin ?? 'sem origin')}`,
                ),
                parts: noteParts(input.mode, read.path, { given, content: input.content }, read.text),
              },
            }),
        apply: () =>
          updateNote(
            ctx.root,
            read.diskPath,
            { frontmatter: set, remove, body },
            { config, now, ifUnchangedSince: read.stamp },
          ),
      };
    },
    confirm,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// patch_page

export async function patchPage(
  ctx: BrainContext,
  input: PatchPageInput,
  options: ConfirmOptions = {},
): Promise<WriteOutput> {
  if (!isRecord(input)) throw invalid('patch_page precisa de um objeto com path, old e new');
  if (typeof input.path !== 'string' || input.path === '') throw invalid('"path" deveria ser o caminho da nota');
  if (typeof input.old !== 'string' || input.old === '') throw invalid('"old" deveria ser o trecho exato a substituir');
  if (typeof input.new !== 'string') throw invalid('"new" deveria ser um texto');
  const token = tokenOf(input.confirm_token);
  assertAgentText(ctx, input.path, 'o caminho', 'path');
  const control = controlTarget(input.path, ctx.config);
  if (control !== null) return patchControl(ctx, control, input, token, options);
  return executeWrite(
    ctx,
    input.session_handle,
    async (config, approval) => {
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
      assertNoLeadingBom(ctx, patched, body);
      const before = read.note.frontmatter;
      const reasons = patched === body ? [] : noteElevationReasons(ctx, { path: read.path, kind: 'update', before });
      const approved = reasons.length > 0 ? approval : null;
      const provenance = patched === body ? null : agentEditProvenance(ctx, before, approved);
      return {
        target: { path: read.path, diskPath: read.diskPath },
        checks: [{ where: 'content', field: null, text: patched }],
        warnings: provenance === null ? [] : [provenance.warning],
        ...(reasons.length === 0
          ? {}
          : {
              elevation: {
                reasons,
                path: read.path,
                summary: `Substituir um trecho de ${read.path} (${String(before.type ?? 'sem tipo')}, origin ${String(before.origin ?? 'sem origin')}). Por quê pede confirmação: ${reasons.join('; ')}. Trecho antigo: "${input.old.slice(0, 200)}"; novo: "${input.new.slice(0, 200)}"`,
                parts: noteParts('patch', read.path, { old: input.old, new: input.new }, read.text),
              },
            }),
        apply: () =>
          patchNote(ctx.root, read.diskPath, input.old, input.new, {
            config,
            now: ctx.now(),
            ifUnchangedSince: read.stamp,
            ...(provenance === null ? {} : { frontmatter: provenance.fields }),
          }),
      };
    },
    { tool: 'patch_page', token, options },
  );
}
