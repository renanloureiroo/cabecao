// As notas que nunca podem sair para um provedor de respostas (`ask`), com os nomes por que outras notas as citam:
// privadas (`private: true` e variações, ou a tag `private`) e as de frontmatter ilegível (na dúvida, não sai). O `ask`
// usa a lista para tirar do prompt o texto delas E o nome delas quando aparece dentro de outra nota.

import { hasPrivateBodyTag, isPrivateNote } from '../ask/policy.ts';
import { listNotes } from '../db/index.ts';
import { connection } from '../db/open.ts';
import type { BrainContext } from './context.ts';
import { assertOpen, withFreshIndex } from './context.ts';

export interface PrivateNote {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly aliases: readonly string[];
  /** O frontmatter não pôde ser lido (a nota é tratada como privada). */
  readonly unreadable: boolean;
}

/** `aliases` ou `alias`, em lista ou em texto (um apelido, ou vários separados por vírgula). */
function aliasesOf(frontmatter: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const name = key.trim().toLowerCase();
    if (name !== 'aliases' && name !== 'alias') continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      out.push(item.trim(), ...item.split(',').map((part) => part.trim()));
    }
  }
  return [...new Set(out.filter((alias) => alias !== ''))];
}

/** As notas com a tag `#private` no corpo, pelo texto indexado (sem ler cada arquivo). */
function bodyPrivateIds(ctx: BrainContext): Set<string> {
  const rows = connection(ctx.index).prepare(`select note_id, text from chunks where text like '%#private%'`).all() as {
    note_id: string;
    text: string;
  }[];
  return new Set(rows.filter((row) => hasPrivateBodyTag(row.text)).map((row) => row.note_id));
}

export async function privateNotes(ctx: BrainContext): Promise<PrivateNote[]> {
  assertOpen(ctx);
  return withFreshIndex(ctx, () => {
    const byBody = bodyPrivateIds(ctx);
    return listNotes(ctx.index, { includeArchived: true, includeConflictCopies: true, orderBy: 'path' })
      .filter((note) => note.frontmatterError !== null || isPrivateNote(note.frontmatter) || byBody.has(note.id))
      .map((note) => ({
        id: note.id,
        path: note.path,
        title: note.title,
        aliases: aliasesOf(note.frontmatter),
        unreadable: note.frontmatterError !== null,
      }));
  });
}
