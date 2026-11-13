// Esquema das notas (docs/03-modelo-de-dados.md): tipos, pastas, campos e relações tipadas.
import type { FrontmatterError } from '../markdown/index.ts';
import { isUlid, normalizeNfc, toPosixPath } from '../util/index.ts';

/** Os 12 tipos de nota, na ordem do doc 03: primeiro os da wiki, depois os da memória. */
export const NOTE_TYPES = [
  'source',
  'concept',
  'entity',
  'decision',
  'synthesis',
  'rule',
  'preference',
  'gotcha',
  'procedure',
  'fact',
  'episode',
  'handoff',
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export function isNoteType(value: unknown): value is NoteType {
  return typeof value === 'string' && (NOTE_TYPES as readonly string[]).includes(value);
}

/** Pasta de cada tipo. `episode` ainda ganha `AAAA/MM` (ver `noteDirForType`). */
export const NOTE_TYPE_DIRS: Readonly<Record<NoteType, string>> = {
  source: 'wiki/sources',
  concept: 'wiki/concepts',
  entity: 'wiki/entities',
  decision: 'wiki/decisions',
  synthesis: 'wiki/syntheses',
  rule: 'memory/rules',
  preference: 'memory/preferences',
  gotcha: 'memory/gotchas',
  procedure: 'memory/procedures',
  fact: 'memory/facts',
  episode: 'memory/episodes',
  handoff: 'memory/handoffs',
};

/** Memórias esquecidas (`forget`) vão para cá. */
export const ARCHIVE_DIR = 'memory/_archive';
/** Fontes brutas e imutáveis: não seguem o esquema e são aceitas como estão. */
export const RAW_DIR = 'raw';

/**
 * Pasta padrão (relativa à raiz, com `/`) de uma nota nova. Para `episode`, `date` (`AAAA-MM-DD`, normalmente o
 * `created`) define `memory/episodes/AAAA/MM`.
 */
export function noteDirForType(type: NoteType, date?: string): string {
  const base = NOTE_TYPE_DIRS[type];
  if (type !== 'episode') return base;
  const match = /^(\d{4})-(\d{2})/.exec(date ?? '');
  if (match === null) throw new RangeError(`noteDirForType: episode precisa de uma data AAAA-MM-DD (${date})`);
  return `${base}/${match[1]}/${match[2]}`;
}

/** Verdadeiro para caminhos dentro de `memory/_archive/`. */
export function isArchivedPath(relPath: string): boolean {
  return toPosixPath(relPath).startsWith(`${ARCHIVE_DIR}/`);
}

/** Verdadeiro para caminhos dentro de `raw/`. */
export function isRawPath(relPath: string): boolean {
  return toPosixPath(relPath).startsWith(`${RAW_DIR}/`);
}

/** Relações tipadas fixas (decisão 27): uma propriedade de lista de wikilinks por relação. */
export const FIXED_RELATIONS = ['uses', 'part_of', 'depends_on', 'decided_by', 'works_on', 'related_to'] as const;
/** Encadeamento de versões: também são listas de wikilinks e também viram arestas. */
export const SUPERSEDE_FIELDS = ['supersedes', 'superseded_by'] as const;

/**
 * O que o esquema precisa da configuração: só as relações extras. Um `BrainConfig` serve; sem ele, valem só as fixas.
 */
export interface RelationsConfig {
  readonly relations?: readonly string[] | undefined;
}

/**
 * Relações tipadas do cérebro: as fixas e as do `.cabecao.json`, nessa ordem, sem repetição. Não inclui
 * `supersedes` nem `superseded_by` (ver `linkListFields`), mesmo que o `.cabecao.json` as repita.
 */
export function relationTypes(config?: RelationsConfig): string[] {
  const names: string[] = [...FIXED_RELATIONS];
  for (const name of config?.relations ?? []) {
    if (!names.includes(name) && !(SUPERSEDE_FIELDS as readonly string[]).includes(name)) names.push(name);
  }
  return names;
}

/** Todo campo que guarda uma lista de wikilinks para outras notas: relações, `supersedes` e `superseded_by`. */
export function linkListFields(config?: RelationsConfig): string[] {
  return [...SUPERSEDE_FIELDS, ...relationTypes(config)];
}

export const TRUST_LEVELS = ['high', 'medium', 'low'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const DATE_FIELDS = ['created', 'updated', 'confirmed', 'valid_from', 'valid_until', 'expires_at'] as const;

/** Campos conhecidos na ordem canônica de gravação, sem as relações (que vêm logo depois, ver `fieldOrder`). */
export const CANONICAL_FIELDS = [
  'id',
  'type',
  'title',
  'aliases',
  'subject',
  'predicate',
  'object',
  'scope',
  'tags',
  'sources',
  'trust',
  'origin',
  'edited_by',
  'created',
  'updated',
  'confirmed',
  'valid_from',
  'valid_until',
  'supersedes',
  'superseded_by',
  'expires_at',
] as const;

/** Ordem canônica completa: campos conhecidos e, em seguida, as relações tipadas. */
export function fieldOrder(config?: RelationsConfig): string[] {
  return [...CANONICAL_FIELDS, ...relationTypes(config)];
}

/**
 * Campos por tipo. `required` faltando é ERRO; `recommended` faltando é AVISO (o Cabeção sempre grava, mas uma
 * nota escrita à mão no Obsidian sem eles continua utilizável); `optional` são os demais campos conhecidos.
 * As relações tipadas são opcionais em todos os tipos.
 */
export interface NoteTypeFields {
  readonly required: readonly string[];
  readonly recommended: readonly string[];
  readonly optional: readonly string[];
}

const COMMON_RECOMMENDED = ['trust', 'origin', 'created', 'updated'] as const;
const PAGE_FIELDS: NoteTypeFields = {
  required: ['id', 'type', 'title'],
  recommended: ['scope', ...COMMON_RECOMMENDED],
  optional: [
    'aliases',
    'tags',
    'sources',
    'edited_by',
    'confirmed',
    'valid_from',
    'valid_until',
    'supersedes',
    'superseded_by',
    'expires_at',
  ],
};
const FACT_FIELDS: NoteTypeFields = {
  required: ['id', 'type', 'subject', 'predicate', 'object'],
  recommended: ['valid_from', ...COMMON_RECOMMENDED],
  optional: [
    'title',
    'aliases',
    'scope',
    'tags',
    'sources',
    'edited_by',
    'confirmed',
    'valid_until',
    'supersedes',
    'superseded_by',
    'expires_at',
  ],
};

export function fieldsForType(type: NoteType): NoteTypeFields {
  return type === 'fact' ? FACT_FIELDS : PAGE_FIELDS;
}

export type NoteIssueSeverity = 'error' | 'warning';

export type NoteIssueCode =
  | 'invalid_frontmatter'
  /** Nota sem `id` nem `type`: não é gerenciada pelo Cabeção (vault adotado, anotação solta). */
  | 'unmanaged'
  | 'missing_required'
  | 'missing_recommended'
  | 'invalid_id'
  | 'unknown_type'
  | 'invalid_title'
  | 'invalid_scope'
  | 'invalid_trust'
  | 'invalid_origin'
  /** `edited_by` não é `agent:<cliente>`. */
  | 'invalid_edited_by'
  | 'invalid_date'
  | 'invalid_date_range'
  | 'invalid_list'
  | 'invalid_wikilink'
  | 'invalid_fact'
  | 'rule_origin_not_human'
  | 'legacy_relations';

export interface NoteIssue {
  readonly severity: NoteIssueSeverity;
  readonly code: NoteIssueCode;
  /** Campo do frontmatter a que o problema se refere, ou `null` quando é da nota inteira. */
  readonly field: string | null;
  readonly message: string;
}

/** O que `validateNote` precisa de uma nota; um `ParsedNote` serve. */
export interface ValidateNoteInput {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly frontmatterError?: FrontmatterError | null;
  /** Caminho relativo ao cérebro. Com ele, fontes brutas em `raw/` sem `id` são aceitas como estão. */
  readonly path?: string;
}

const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SCOPE_RE = /^(?:global|project:[\w-]+)$/;
const ORIGIN_RE = /^(?:human|agent:[\w.-]+|ingest:[\w.-]+)$/;
/** `edited_by`: o último agente que alterou uma nota do usuário (`agent:<cliente>`). */
const EDITED_BY_RE = /^agent:[\w.-]+$/;
const PREDICATE_RE = /^[a-z][a-z0-9_]*$/;
/** O valor inteiro é UM wikilink: `[[alvo]]`, `[[alvo#seção]]` ou `[[alvo|apelido]]`. */
const SINGLE_WIKILINK_RE = /^\[\[[^[\]\n|#]+(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]$/;

/** Data ISO 8601: `AAAA-MM-DD`, com hora opcional. Confere também se o dia existe no calendário. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_RE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  return Number(match[4] ?? 0) < 24 && Number(match[5] ?? 0) < 60 && Number(match[6] ?? 0) < 61;
}

export function isWikilinkText(value: unknown): value is string {
  return typeof value === 'string' && SINGLE_WIKILINK_RE.test(value.trim());
}

export function isValidScope(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_RE.test(value);
}

export function isValidOrigin(value: unknown): value is string {
  return typeof value === 'string' && ORIGIN_RE.test(value);
}

/** Confiança padrão de quem escreve: você (`high`), um agente (`medium`), conteúdo de fora (`low`). */
export function defaultTrustForOrigin(origin: string): TrustLevel {
  if (origin === 'human') return 'high';
  return origin.startsWith('agent:') ? 'medium' : 'low';
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/**
 * Confere uma nota contra o esquema e devolve TODOS os problemas, erros e avisos. Nunca lança.
 *
 * - Fonte bruta em `raw/` sem `id`: aceita como está (lista vazia).
 * - Nota sem `id` nem `type` fora de `raw/`: um único aviso `unmanaged`.
 * - Campos desconhecidos são ignorados: o usuário pode ter as próprias propriedades no Obsidian.
 */
export function validateNote(note: ValidateNoteInput, config?: RelationsConfig): NoteIssue[] {
  const issues: NoteIssue[] = [];
  const add = (severity: NoteIssueSeverity, code: NoteIssueCode, field: string | null, message: string): void => {
    issues.push({ severity, code, field, message });
  };
  const fm = note.frontmatter;
  const path = note.path === undefined ? null : normalizeNfc(toPosixPath(note.path));
  const raw = path !== null && isRawPath(path) && !present(fm.id);

  if (note.frontmatterError != null) {
    if (raw) return issues;
    const where = note.frontmatterError.line === null ? '' : ` (linha ${note.frontmatterError.line})`;
    add(
      'error',
      'invalid_frontmatter',
      null,
      `o frontmatter não pôde ser lido${where}: ${note.frontmatterError.message}`,
    );
    return issues;
  }
  if (raw) return issues;
  if (!present(fm.id) && !present(fm.type)) {
    add('warning', 'unmanaged', null, 'nota sem "id" nem "type": não é gerenciada pelo Cabeção');
    return issues;
  }

  if (present(fm.id) && !isUlid(fm.id)) {
    add('error', 'invalid_id', 'id', '"id" deveria ser um ULID (26 caracteres, em maiúsculas)');
  }
  const type = isNoteType(fm.type) ? fm.type : null;
  if (present(fm.type) && type === null) {
    add(
      'error',
      'unknown_type',
      'type',
      `"type" desconhecido (${JSON.stringify(fm.type)}); os tipos são: ${NOTE_TYPES.join(', ')}`,
    );
  }

  const fields = type === null ? { required: ['id', 'type'], recommended: [], optional: [] } : fieldsForType(type);
  for (const field of fields.required) {
    if (!present(fm[field])) add('error', 'missing_required', field, `falta o campo obrigatório "${field}"`);
  }
  for (const field of fields.recommended) {
    if (!present(fm[field])) add('warning', 'missing_recommended', field, `falta o campo "${field}"`);
  }

  if (present(fm.title) && typeof fm.title !== 'string' && typeof fm.title !== 'number') {
    add('error', 'invalid_title', 'title', '"title" deveria ser um texto');
  } else if (typeof fm.title === 'string' && fm.title.trim() === '') {
    add('error', 'invalid_title', 'title', '"title" está em branco');
  }
  if (present(fm.scope) && !isValidScope(fm.scope)) {
    add('error', 'invalid_scope', 'scope', '"scope" deveria ser "global" ou "project:<slug>"');
  }
  if (present(fm.trust) && !(TRUST_LEVELS as readonly unknown[]).includes(fm.trust)) {
    add('error', 'invalid_trust', 'trust', '"trust" deveria ser "high", "medium" ou "low"');
  }
  if (present(fm.origin) && !isValidOrigin(fm.origin)) {
    add('error', 'invalid_origin', 'origin', '"origin" deveria ser "human", "agent:<cliente>" ou "ingest:<fonte>"');
  } else if (type === 'rule' && present(fm.origin) && fm.origin !== 'human') {
    add(
      'error',
      'rule_origin_not_human',
      'origin',
      'regras (type: rule) só o usuário cria: "origin" deveria ser "human"',
    );
  }

  if (present(fm.edited_by) && !(typeof fm.edited_by === 'string' && EDITED_BY_RE.test(fm.edited_by))) {
    add('warning', 'invalid_edited_by', 'edited_by', '"edited_by" deveria ser "agent:<cliente>"');
  }

  for (const field of DATE_FIELDS) {
    if (present(fm[field]) && !isIsoDate(fm[field])) {
      add('error', 'invalid_date', field, `"${field}" deveria ser uma data ISO (AAAA-MM-DD)`);
    }
  }
  const ordered = (earlier: string, later: string): boolean => {
    const [a, b] = [fm[earlier], fm[later]];
    return !isIsoDate(a) || !isIsoDate(b) || a.slice(0, 10) <= b.slice(0, 10);
  };
  if (!ordered('valid_from', 'valid_until')) {
    add('error', 'invalid_date_range', 'valid_until', '"valid_until" vem antes de "valid_from"');
  }
  if (!ordered('created', 'updated')) {
    add('warning', 'invalid_date_range', 'updated', '"updated" vem antes de "created"');
  }

  if (present(fm.tags)) {
    const tags = fm.tags;
    if (!Array.isArray(tags)) {
      add('warning', 'invalid_list', 'tags', '"tags" deveria ser uma lista');
    } else if (!tags.every((tag) => (typeof tag === 'string' && tag.trim() !== '') || typeof tag === 'number')) {
      add('error', 'invalid_list', 'tags', '"tags" deveria ser uma lista de textos');
    }
  }
  if (present(fm.aliases)) {
    // como no Obsidian: uma lista de textos (ou um texto só); servem de nome alternativo da nota nas menções
    const aliases = fm.aliases;
    const ok = (item: unknown): boolean => (typeof item === 'string' && item.trim() !== '') || typeof item === 'number';
    if (!(Array.isArray(aliases) ? aliases.every(ok) : ok(aliases))) {
      add('warning', 'invalid_list', 'aliases', '"aliases" deveria ser uma lista de textos');
    }
  }
  if (present(fm.sources)) {
    const sources = fm.sources;
    if (!Array.isArray(sources) || !sources.every((item) => typeof item === 'string' && item.trim() !== '')) {
      add('error', 'invalid_list', 'sources', '"sources" deveria ser uma lista de wikilinks');
    } else if (!sources.every(isWikilinkText)) {
      add('warning', 'invalid_wikilink', 'sources', '"sources" tem um item que não é um wikilink');
    }
  }
  for (const field of linkListFields(config)) {
    const value = fm[field];
    if (!present(value)) continue;
    if (!Array.isArray(value)) {
      add('error', 'invalid_list', field, `"${field}" deveria ser uma lista de wikilinks, como ["[[Nota]]"]`);
    } else if (!value.every(isWikilinkText)) {
      add('error', 'invalid_wikilink', field, `"${field}" tem um item que não é um wikilink, como "[[Nota]]"`);
    }
  }

  if (type === 'fact') {
    if (present(fm.subject) && typeof fm.subject !== 'string') {
      add('error', 'invalid_fact', 'subject', '"subject" deveria ser um wikilink, como "[[Projeto Atlas]]"');
    } else if (present(fm.subject) && !isWikilinkText(fm.subject)) {
      add('warning', 'invalid_fact', 'subject', '"subject" deveria ser um wikilink, como "[[Projeto Atlas]]"');
    }
    if (present(fm.predicate) && (typeof fm.predicate !== 'string' || !PREDICATE_RE.test(fm.predicate))) {
      add(
        'error',
        'invalid_fact',
        'predicate',
        '"predicate" deveria ser um identificador em minúsculas, como "uses_queue"',
      );
    }
    if (present(fm.object) && !['string', 'number', 'boolean'].includes(typeof fm.object)) {
      add('error', 'invalid_fact', 'object', '"object" deveria ser um wikilink ou um valor simples');
    }
  }

  if ('relations' in fm) {
    add(
      'warning',
      'legacy_relations',
      'relations',
      '"relations" não é usado: cada relação é uma propriedade própria (uses, part_of...)',
    );
  }
  return issues;
}

export function hasErrors(issues: readonly NoteIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/** `aliases` do frontmatter como lista de textos, sem vazios: um texto só vira lista de um (como no Obsidian). */
export function aliasesOf(frontmatter: Readonly<Record<string, unknown>>): string[] {
  const value = frontmatter.aliases;
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter((item) => item !== '');
}

const WIKILINK_PARTS_RE = /^\[\[([^[\]\n|#]*)(?:#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]$/;

/** Texto legível de um valor que pode ser um wikilink: `[[a/Nota|Apelido]]` vira `Apelido`; `[[a/Nota]]` vira `Nota`. */
export function plainLinkText(value: unknown): string {
  const text = String(value ?? '').trim();
  const match = WIKILINK_PARTS_RE.exec(text);
  if (match === null) return text;
  const alias = match[2]?.trim();
  if (alias) return alias;
  const target = (match[1] ?? '').trim();
  return target.slice(target.lastIndexOf('/') + 1);
}

/**
 * Título para mostrar (commits, diário, catálogo): `title`; num fato sem título, `sujeito predicado objeto`;
 * senão, o nome do arquivo sem `.md`.
 */
export function displayTitle(frontmatter: Readonly<Record<string, unknown>>, relPath?: string): string {
  const title = frontmatter.title;
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  if (typeof title === 'number') return String(title);
  if (frontmatter.type === 'fact' && present(frontmatter.subject) && present(frontmatter.predicate)) {
    return [plainLinkText(frontmatter.subject), String(frontmatter.predicate), plainLinkText(frontmatter.object)]
      .filter((part) => part !== '')
      .join(' ');
  }
  if (relPath === undefined) return '';
  const name = toPosixPath(relPath);
  return name.slice(name.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}
