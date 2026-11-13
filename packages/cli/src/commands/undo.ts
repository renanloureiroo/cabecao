import type { ListOperationsOutput, UndoInput, UndoOutput } from '@cabecao/core';
import { MIN_HUMAN_ID_PREFIX } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import { confirmationText, confirmTokenOf, withConfirmation } from '../memory.ts';
import { formatWhen, plural } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const LIST_LIMIT_MAX = 200;

/**
 * `--op` e `--session`: o ULID ou o começo dele, com pelo menos `MIN_HUMAN_ID_PREFIX` caracteres (com menos, um
 * engano desfaria a operação errada). `--list --session` só lê, e aceita qualquer começo.
 */
function idOption(ctx: CommandContext, name: string, min: number): string | undefined {
  const value = ctx.values[name];
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!new RegExp(`^[0-9A-Za-z]{${min},26}$`).test(text)) {
    throw new UsageError(
      `--${name} deveria ser o identificador da ${name === 'op' ? 'operação' : 'sessão'} (ou o começo dele${min > 1 ? `, com pelo menos ${min} caracteres` : ''})`,
    );
  }
  return text;
}

export function undoText(output: UndoOutput): string {
  const pending = confirmationText(output, 'cabecao undo');
  if (pending !== null) return pending;
  const lines: string[] = [];
  if (output.commit === null) {
    lines.push(
      `Nada mudou: ${plural(output.undone.length, 'operação já estava', 'operações já estavam')} sem efeito nas notas.`,
    );
  } else {
    lines.push(
      `Desfeito: ${plural(output.undone.length, 'operação', 'operações')}, no commit ${output.commit.slice(0, 10)} (operação de undo ${output.op}).`,
    );
  }
  for (const undone of output.undone) {
    lines.push(`  ${undone.op}  ${undone.changes.join('; ') || '(sem descrição)'}`);
  }
  if (output.changed_paths.length > 0) {
    lines.push('Arquivos alterados:', ...output.changed_paths.map((path) => `  ${path}`));
  }
  for (const warning of output.warnings) lines.push(`Aviso: ${warning.message}`);
  if (output.next_step !== undefined) lines.push(`Próximo passo: ${output.next_step}`);
  lines.push(`Mudou de ideia? "cabecao undo --op ${output.op}" desfaz este undo.`);
  return lines.join('\n');
}

export function listText(output: ListOperationsOutput): string {
  if (output.operations.length === 0) return 'Nenhuma operação do Cabeção neste cérebro.';
  const lines = ['Operações, da mais nova para a mais antiga (desfaça uma com "cabecao undo --op <id>"):', ''];
  for (const op of output.operations) {
    const who = [op.client, op.machine].filter((part) => part !== null).join(' @ ');
    const session = op.session === null ? '' : `  sessão ${op.session}`;
    const state = op.undone ? `  [desfeita por ${op.undone_by ?? '?'}]` : '';
    lines.push(`${op.op}  ${formatWhen(op.date)}  ${op.action.padEnd(7)}  ${who}${session}${state}`);
    for (const change of op.changes) lines.push(`    ${change}`);
  }
  return lines.join('\n');
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const list = ctx.values.list === true;
  const op = idOption(ctx, 'op', MIN_HUMAN_ID_PREFIX);
  const session = idOption(ctx, 'session', list ? 1 : MIN_HUMAN_ID_PREFIX);
  if (op !== undefined && session !== undefined) throw new UsageError('use --op ou --session, não os dois');
  if (list && op !== undefined) throw new UsageError('--list não combina com --op');
  let limit: number | undefined;
  if (ctx.values.limit !== undefined) {
    if (!list) throw new UsageError('--limit só vale com --list');
    const text = String(ctx.values.limit).trim();
    limit = Number(text);
    if (!/^\d+$/.test(text) || limit < 1 || limit > LIST_LIMIT_MAX) {
      throw new UsageError(`--limit deveria ser um número de 1 a ${LIST_LIMIT_MAX}`);
    }
  }

  const root = await resolveBrain(ctx);
  if (list) {
    const output = await withBrain(ctx, root, (brain) =>
      brain.listOperations({
        ...(limit === undefined ? {} : { limit }),
        ...(session === undefined ? {} : { session }),
      }),
    );
    return { data: output, text: listText(output) };
  }
  const input: UndoInput = {
    ...(op !== undefined ? { op } : session !== undefined ? { session } : {}),
    ...confirmTokenOf(ctx),
  };
  // um agente desfaz sem confirmação só as próprias operações, pelo id inteiro; o resto volta com o resumo e o token
  const { output, code } = await withBrain(ctx, root, (brain) =>
    withConfirmation(ctx, (options) => brain.undo(input, options)),
  );
  return { data: output, text: undoText(output), code };
}
