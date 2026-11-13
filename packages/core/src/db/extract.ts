// De uma nota lida (`readNote`) para as linhas do banco: colunas da nota, trechos, arestas e fato.
// Não toca no banco: é uma função pura, fácil de testar.
import type { Chunk } from '../markdown/index.ts';
import { normalizeLinkTarget } from '../markdown/index.ts';
import { toPosixPath } from '../util/index.ts';
import type { NoteRead, RelationsConfig } from '../vault/index.ts';
import { displayTitle, isArchivedPath, linkListFields, plainLinkText, relationTypes } from '../vault/index.ts';

/**
 * Como a aresta nasceu (doc 06, "De onde vêm as arestas").
 * - `wikilink`: `[[Nota]]` no corpo (`type` = `link` ou `embed`) ou num campo do frontmatter que não é relação
 *   (`type` = nome do campo, como `sources`).
 * - `relation`: campo de relação tipada (`type` = `uses`, `part_of`...).
 * - `supersedes`: campos `supersedes` e `superseded_by` (`type` = nome do campo).
 * - `fact`: `subject` e `object` de uma nota `type: fact` (`type` = `subject` ou `object`).
 * - `mention`: título ou apelido de outra nota citado no texto sem link (`type` = `mention`). Não sai daqui: é
 *   derivada do conjunto das notas no fim da varredura (`db/mentions.ts`).
 */
export type EdgeOrigin = 'wikilink' | 'relation' | 'supersedes' | 'fact' | 'mention';

export interface EdgeRecord {
  readonly origin: EdgeOrigin;
  readonly type: string;
  /** Alvo como foi escrito no link, sem âncora nem apelido. */
  readonly target: string;
  /** Nome normalizado do arquivo de destino (minúsculas, NFC, sem pasta nem `.md`): a chave de `buildLinkIndex`. */
  readonly targetKey: string;
  readonly anchor: string | null;
  readonly alias: string | null;
  readonly line: number;
}

export interface FactRecord {
  /** Texto legível do sujeito (`[[Projeto Atlas]]` vira `Projeto Atlas`). */
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly object: string | null;
}

/** Problema encontrado numa nota durante a varredura. A nota é indexada mesmo assim (exceto `read_failed`). */
export type ScanIssueCode =
  /** Frontmatter com YAML inválido ou que não é um mapa: a nota entra só pelo texto. */
  | 'invalid_frontmatter'
  /** Sem `id` no frontmatter (fonte em `raw/`, nota não gerenciada): recebe um id derivado do caminho. */
  | 'missing_id'
  /** Outra nota já usa este `id`: esta recebe um id derivado do caminho até o conflito sumir. */
  | 'duplicate_id'
  /** Não deu para ler o arquivo (permissão, por exemplo). A versão anterior no banco, se havia, é mantida. */
  | 'read_failed'
  /** Falha inesperada ao gravar a nota no banco; as outras notas seguem. */
  | 'index_failed';

export interface ScanIssue {
  readonly path: string;
  readonly code: ScanIssueCode;
  readonly message: string;
}

export interface NoteRecord {
  /** `id` do frontmatter, ou `null` quando falta (ver `pathNoteId`). */
  readonly frontmatterId: string | null;
  readonly path: string;
  readonly type: string | null;
  readonly title: string;
  /** O título veio do nome do arquivo (não há `title` nem título de nível 1): muda se o arquivo for renomeado. */
  readonly titleDerived: boolean;
  readonly scope: string | null;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly created: string | null;
  readonly updated: string | null;
  readonly confirmed: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  readonly contentHash: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly frontmatterJson: string;
  readonly frontmatterError: string | null;
  readonly archived: boolean;
  readonly chunks: readonly Chunk[];
  readonly edges: readonly EdgeRecord[];
  readonly fact: FactRecord | null;
  readonly issues: readonly ScanIssue[];
}

/** Prefixo dos ids derivados do caminho, para notas sem `id` no frontmatter. */
export const PATH_ID_PREFIX = 'path:';

/** Id de uma nota sem `id` próprio (fonte bruta, frontmatter inválido, `id` repetido). Muda se o arquivo mudar de lugar. */
export function pathNoteId(path: string): string {
  return `${PATH_ID_PREFIX}${path}`;
}

/** Chave de nome de um alvo de wikilink, igual à que `resolveWikiLink` usa para procurar em `byName`. */
export function linkTargetKey(target: string): string {
  const key = normalizeLinkTarget(toPosixPath(target))
    .replace(/^(?:\.?\/)+/, '')
    .replace(/\/+/g, '/');
  return key.slice(key.lastIndexOf('/') + 1);
}

/** Chave de nome de um caminho de nota (o que `[[nome]]` precisa para achá-la). */
export function pathNameKey(path: string): string {
  const key = normalizeLinkTarget(path);
  return key.slice(key.lastIndexOf('/') + 1);
}

/** Valor de data do frontmatter como texto ISO, ou `null` se vazio ou de tipo inesperado. */
export function dateText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function frontmatterJson(frontmatter: Readonly<Record<string, unknown>>): string {
  try {
    return JSON.stringify(frontmatter);
  } catch {
    // valores que o JSON não representa (BigInt, referência circular de alias YAML)
    return '{}';
  }
}

/** Monta o registro de uma nota lida. `config` traz as relações extras do `.cabecao.json`. */
export function extractNote(read: NoteRead, config: RelationsConfig): NoteRecord {
  const { note, path } = read;
  const fm = note.frontmatter;
  const issues: ScanIssue[] = [];

  if (note.frontmatterError !== null) {
    const where = note.frontmatterError.line === null ? '' : ` (linha ${note.frontmatterError.line})`;
    issues.push({
      path,
      code: 'invalid_frontmatter',
      message: `frontmatter ilegível${where}: ${note.frontmatterError.message}; a nota foi indexada só pelo texto`,
    });
  }
  const frontmatterId = scalarText(fm.id);
  if (frontmatterId === null && note.frontmatterError === null) {
    issues.push({
      path,
      code: 'missing_id',
      message: 'nota sem "id" no frontmatter; indexada com um id derivado do caminho',
    });
  }

  const relations = new Set(relationTypes(config));
  const listFields = new Set(linkListFields(config));
  const isFact = fm.type === 'fact';
  const edges: EdgeRecord[] = [];
  const pushEdge = (
    origin: EdgeOrigin,
    type: string,
    link: { target: string; anchor: string | null; alias: string | null; line: number },
  ): void => {
    // `[[#Seção]]` aponta para a própria nota: não é aresta
    if (link.target.trim() === '') return;
    edges.push({
      origin,
      type,
      target: link.target,
      targetKey: linkTargetKey(link.target),
      anchor: link.anchor,
      alias: link.alias,
      line: link.line,
    });
  };
  for (const link of note.frontmatterLinks) {
    const property = link.property;
    if (relations.has(property)) pushEdge('relation', property, link);
    else if (listFields.has(property)) pushEdge('supersedes', property, link);
    else if (isFact && (property === 'subject' || property === 'object')) pushEdge('fact', property, link);
    else pushEdge('wikilink', property, link);
  }
  for (const link of note.links) pushEdge('wikilink', link.embed ? 'embed' : 'link', link);

  const fact: FactRecord | null = isFact
    ? {
        subject: fm.subject == null ? null : plainLinkText(fm.subject) || null,
        predicate: scalarText(fm.predicate),
        object: fm.object == null ? null : plainLinkText(fm.object) || null,
      }
    : null;

  return {
    frontmatterId,
    path,
    type: scalarText(fm.type),
    title: note.title ?? displayTitle(fm, path),
    titleDerived: note.title === null,
    scope: scalarText(fm.scope),
    trust: scalarText(fm.trust),
    origin: scalarText(fm.origin),
    created: dateText(fm.created),
    updated: dateText(fm.updated),
    confirmed: dateText(fm.confirmed),
    validFrom: dateText(fm.valid_from),
    validUntil: dateText(fm.valid_until),
    expiresAt: dateText(fm.expires_at),
    contentHash: read.contentHash,
    mtimeMs: read.stamp.mtimeMs,
    size: read.stamp.size,
    frontmatterJson: frontmatterJson(fm),
    frontmatterError: note.frontmatterError?.message ?? null,
    archived: isArchivedPath(path),
    chunks: note.chunks,
    edges,
    fact,
    issues,
  };
}
