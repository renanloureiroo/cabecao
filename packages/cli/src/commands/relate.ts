// `cabecao relate <de> <tipo> <para>`: a tool `relate` pela linha de comando.
import type { RelateInput } from '@cabecao/core';
import { relateInput } from '@cabecao/server/input-schemas';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import { checkInput, confirmTokenOf, stringOption, withConfirmation } from '../memory.ts';
import type { CommandContext, CommandResult } from '../types.ts';
import { writeText } from './write.ts';

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [from, type, to, ...rest] = ctx.positionals;
  if (from === undefined || type === undefined || to === undefined) {
    throw new UsageError('informe as duas notas e a relação: cabecao relate <de> <tipo> <para>');
  }
  if (rest.length > 0) throw new UsageError(`argumento a mais: ${rest.join(' ')}`);
  const session = stringOption(ctx, 'session');
  const input = checkInput(
    relateInput,
    { from, type, to, ...(session === undefined ? {} : { session_handle: session }), ...confirmTokenOf(ctx) },
    'relate',
  ) as RelateInput;
  const root = await resolveBrain(ctx);
  const { output, code } = await withBrain(ctx, root, (brain) =>
    withConfirmation(ctx, (options) => brain.relate(input, options)),
  );
  const text =
    output.changed || output.status !== undefined
      ? writeText(output, 'cabecao relate')
      : `A relação já existia: ${output.relation.from} ${output.relation.type} ${output.relation.link}.`;
  return { data: output, text, code };
}
