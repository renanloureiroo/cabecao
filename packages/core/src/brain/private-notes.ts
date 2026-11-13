// As notas que nunca podem sair para um provedor de respostas (`ask`), com os nomes por que outras notas as citam:
// privadas (`private: true` e variações, ou a tag `private`) e as de frontmatter ilegível (na dúvida, não sai). O `ask`
// usa a lista para tirar do prompt o texto delas E o nome delas quando aparece dentro de outra nota.

import { isPrivateNote } from '../ask/policy.ts';
import { listNotes } from '../db/index.ts';
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

export async function privateNotes(ctx: BrainContext): Promise<PrivateNote[]> {
  assertOpen(ctx);
  return withFreshIndex(ctx, () =>
    listNotes(ctx.index, { includeArchived: true, includeConflictCopies: true, orderBy: 'path' })
      .filter((note) => note.frontmatterError !== null || isPrivateNote(note.frontmatter))
      .map((note) => {
        const aliases = note.frontmatter.aliases;
        return {
          id: note.id,
          path: note.path,
          title: note.title,
          aliases: Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : [],
          unreadable: note.frontmatterError !== null,
        };
      }),
  );
}
