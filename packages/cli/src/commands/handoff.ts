// `cabecao handoff`: a tool `handoff_save` pela linha de comando (passagem de bastão para a próxima sessão).
import type { HandoffSaveInput, HandoffSaveOutput } from '@cabecao/core';
import { handoffSaveInput } from '@cabecao/server/input-schemas';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import { checkInput, listOption, readJsonInput, stringOption } from '../memory.ts';
import type { CommandContext, CommandResult } from '../types.ts';

/** Opção repetível → campo de lista da tool. */
const LISTS: readonly (readonly [string, keyof HandoffSaveInput])[] = [
  ['done', 'done'],
  ['next', 'next'],
  ['decision', 'decisions'],
  ['gotcha', 'gotchas'],
];

async function inputOf(ctx: CommandContext): Promise<Record<string, unknown>> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  if (ctx.values['json-input'] === true) {
    const given = ['session', 'scope', 'title', ...LISTS.map(([option]) => option)].filter(
      (option) => ctx.values[option] !== undefined,
    );
    if (given.length > 0) {
      throw new UsageError(
        `com --json-input, todos os campos vêm no JSON; tire ${given.map((o) => `--${o}`).join(', ')}`,
      );
    }
    return readJsonInput(ctx);
  }
  const session = stringOption(ctx, 'session');
  if (session === undefined) {
    throw new UsageError('informe a sessão: cabecao handoff --session <session_handle do recall>');
  }
  const input: Record<string, unknown> = { session_handle: session };
  for (const [option, field] of LISTS) {
    const items = listOption(ctx, option);
    if (items !== undefined) input[field] = items;
  }
  for (const option of ['scope', 'title'] as const) {
    const value = stringOption(ctx, option);
    if (value !== undefined) input[option] = value;
  }
  return input;
}

export function handoffText(output: HandoffSaveOutput): string {
  const lines = [
    `Passagem de bastão gravada: ${output.handoff.path} (commit ${output.commit?.slice(0, 10) ?? '-'}, operação ${output.op}); vale até ${output.expires_at}.`,
  ];
  if (output.episode !== null) lines.push(`Episódio da sessão: ${output.episode.path}.`);
  if (output.supersedes !== null) lines.push(`Substitui o handoff anterior: ${output.supersedes.path}.`);
  for (const warning of output.warnings) lines.push(`Aviso: ${warning.message}`);
  lines.push(`Próximo passo: ${output.next_step}`);
  return lines.join('\n');
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const input = checkInput(handoffSaveInput, await inputOf(ctx), 'handoff_save') as HandoffSaveInput;
  const root = await resolveBrain(ctx);
  const output = await withBrain(ctx, root, (brain) => brain.handoffSave(input));
  return { data: output, text: handoffText(output) };
}
