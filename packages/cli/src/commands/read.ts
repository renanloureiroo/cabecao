// `cabecao read <caminho|id> [--section <seção>]`: a tool `read` pela linha de comando. Só lê.
import type { ReadInput, ReadOutput } from '@cabecao/core';
import { readInput } from '@cabecao/server/input-schemas';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import { checkInput, stringOption } from '../memory.ts';
import type { CommandContext, CommandResult } from '../types.ts';
import { validityLabel } from './graph.ts';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function readText(output: ReadOutput): string {
  const note = output.note;
  const facts = [
    note.type ?? 'sem tipo',
    ...(note.scope === null ? [] : [note.scope]),
    `trust ${note.trust ?? '?'}`,
    `origin ${note.origin ?? '?'}`,
    ...(note.edited_by === null ? [] : [`editada por ${note.edited_by}`]),
    validityLabel(note.validity),
    ...(output.archived ? ['ARQUIVADA'] : []),
  ];
  const lines = [
    `${note.title ?? note.path}  (${note.path})`,
    facts.join(' · '),
    ...(output.section === null ? [] : [`Seção: ${output.section}`]),
    `Aviso: ${output.data_notice}`,
    '',
    note.content.trimEnd(),
  ];
  if (output.backlinks.length > 0) {
    lines.push('', `Citada por: ${[...new Set(output.backlinks.map((link) => link.path))].join(', ')}`);
  }
  return lines.join('\n');
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [ref, ...rest] = ctx.positionals;
  if (ref === undefined || ref.trim() === '') throw new UsageError('informe a nota: cabecao read <caminho ou id>');
  if (rest.length > 0) throw new UsageError(`argumento a mais: ${rest.join(' ')}`);
  const section = stringOption(ctx, 'section');
  const asked = {
    ...(ULID_RE.test(ref) ? { id: ref.toUpperCase() } : { path: ref }),
    ...(section === undefined ? {} : { section }),
  };
  const input = checkInput(readInput, asked, 'read') as unknown as ReadInput;
  const root = await resolveBrain(ctx);
  const output = await withBrain(ctx, root, (brain) => brain.read(input));
  return { data: output, text: readText(output) };
}
