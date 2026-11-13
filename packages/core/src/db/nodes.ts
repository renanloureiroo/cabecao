// Resolução de uma referência a nota vinda de fora (tools `graph`, `facts`, `relate`; doc 05): aceita o id, o
// caminho, um wikilink (`[[Nota]]`, `[[pasta/Nota|apelido]]`) ou o título/apelido. Só consulta o banco: nenhum
// caminho chega ao disco por aqui, então `..`, caminho absoluto e afins simplesmente não acham nada.
import { buildLinkIndex, resolveWikiLink } from '../vault/index.ts';
import { nameKey } from './mentions.ts';
import type { LocalIndex } from './open.ts';
import { connection } from './open.ts';
import type { IndexedNote } from './queries.ts';
import { getNote } from './queries.ts';

/** Como a referência foi resolvida. */
export type NodeMatch = 'id' | 'path' | 'link' | 'title' | 'alias';

export type NodeResolution =
  | { readonly kind: 'found'; readonly note: IndexedNote; readonly by: NodeMatch }
  /** Mais de uma nota com esse título ou apelido: quem chamou escolhe pelo caminho. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly IndexedNote[] }
  | { readonly kind: 'not_found' };

/** Tamanho máximo de uma referência (o servidor já corta antes; aqui é a defesa da camada de baixo). */
export const MAX_NODE_REF_LENGTH = 1024;

const WIKILINK_RE = /^!?\[\[([^[\]\n|#]*)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]$/;

/** `[[alvo#seção|apelido]]` → `alvo`; o resto fica como veio, sem espaços em volta. */
export function stripWikilink(ref: string): string {
  const text = ref.trim();
  const match = WIKILINK_RE.exec(text);
  return match === null ? text : (match[1] ?? '').trim();
}

/**
 * Resolve `ref` para uma nota. Ordem: id exato; caminho (com ou sem `.md`, sem diferenciar maiúsculas se só houver
 * uma); wikilink pelo nome do arquivo ou pelo caminho, com o mesmo resolvedor da varredura; título ou apelido, sem
 * diferenciar maiúsculas nem acentos. Cópias de conflito do sync só pelo caminho exato.
 */
export function resolveNodeRef(index: LocalIndex, ref: string): NodeResolution {
  if (typeof ref !== 'string') return { kind: 'not_found' };
  const target = stripWikilink(ref);
  if (target === '' || target.length > MAX_NODE_REF_LENGTH || target.includes('\0')) return { kind: 'not_found' };

  const byId = getNote(index, { id: target });
  if (byId !== null) return { kind: 'found', note: byId, by: 'id' };
  if (target.includes('/') || /\.md$/i.test(target)) {
    const byPath = getNote(index, { path: target });
    if (byPath !== null) return { kind: 'found', note: byPath, by: 'path' };
  }

  const db = connection(index);
  const paths = db
    .prepare('select path from notes where conflict_of is null')
    .all()
    .map((row) => String(row.path));
  const link = resolveWikiLink(buildLinkIndex(paths), target.replace(/\.md$/i, ''));
  if (link.path !== null) {
    const note = getNote(index, { path: link.path });
    if (note !== null) return { kind: 'found', note, by: 'link' };
  }

  const key = nameKey(target);
  if (key === '') return { kind: 'not_found' };
  const rows = db
    .prepare(
      `select distinct nm.note_id, nm.kind from names nm join notes n on n.id = nm.note_id
       where nm.key = ? and n.conflict_of is null order by nm.note_id`,
    )
    .all(key);
  const kinds = new Map<string, NodeMatch>();
  for (const row of rows) {
    const id = String(row.note_id);
    if (kinds.get(id) !== 'title') kinds.set(id, row.kind === 'alias' ? 'alias' : 'title');
  }
  const notes = [...kinds.keys()].map((id) => getNote(index, { id })).filter((note) => note !== null);
  // uma nota arquivada não disputa com uma viva
  const live = notes.filter((note) => !note.archived);
  const pool = live.length > 0 ? live : notes;
  if (pool.length === 1) {
    const note = pool[0] as IndexedNote;
    return { kind: 'found', note, by: kinds.get(note.id) ?? 'title' };
  }
  if (pool.length > 1) {
    return { kind: 'ambiguous', candidates: [...pool].sort((a, b) => (a.path < b.path ? -1 : 1)) };
  }
  return { kind: 'not_found' };
}
