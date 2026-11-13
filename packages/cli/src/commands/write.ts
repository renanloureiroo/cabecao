// `cabecao write <caminho>`: a tool `write_page` pela linha de comando. O conteúdo vem do argumento, de `--file` (ou
// `-`), da entrada padrão, ou de um JSON com os campos da tool (`--json-input`).
import type { WriteOutput, WritePageInput } from '@cabecao/core';
import { writePageInput } from '@cabecao/server/input-schemas';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import {
  checkInput,
  confirmationText,
  confirmTokenOf,
  readAllStdin,
  readJsonInput,
  readTextFile,
  stringOption,
  withConfirmation,
} from '../memory.ts';
import type { CommandContext, CommandResult } from '../types.ts';

/** Texto de uma escrita (`write`, `patch`, `relate`), para o terminal. */
export function writeText(output: WriteOutput, command: string): string {
  const pending = confirmationText(output, command);
  if (pending !== null) return pending;
  const lines = output.changed
    ? [
        `Gravado: ${output.path} (commit ${output.commit?.slice(0, 10) ?? '-'}, operação ${output.op}).`,
        `Desfazer: cabecao undo --op ${output.op}`,
      ]
    : [`Nada mudou em ${output.path}.`];
  for (const warning of output.warnings) lines.push(`Aviso: ${warning.message}`);
  if (output.next_step !== undefined) lines.push(`Próximo passo: ${output.next_step}`);
  return lines.join('\n');
}

function frontmatterOf(ctx: CommandContext): Record<string, unknown> | undefined {
  const raw = stringOption(ctx, 'frontmatter');
  let frontmatter: Record<string, unknown> | undefined;
  if (raw !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new CliError(`--frontmatter deveria ser um objeto JSON (${(error as Error).message})`, {
        code: 'invalid_argument',
      });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CliError('--frontmatter deveria ser um objeto JSON, como {"type": "concept"}', {
        code: 'invalid_argument',
      });
    }
    frontmatter = { ...(value as Record<string, unknown>) };
  }
  for (const key of ['type', 'title'] as const) {
    const value = stringOption(ctx, key);
    if (value !== undefined) frontmatter = { ...frontmatter, [key]: value };
  }
  return frontmatter;
}

async function inputOf(ctx: CommandContext): Promise<Record<string, unknown>> {
  if (ctx.values['json-input'] === true) {
    const given = ['mode', 'type', 'title', 'frontmatter', 'file', 'session'].filter(
      (option) => ctx.values[option] !== undefined,
    );
    if (given.length > 0 || ctx.positionals.length > 0) {
      throw new UsageError(
        `com --json-input, todos os campos (inclusive path) vêm no JSON; tire ${[...given.map((option) => `--${option}`), ...ctx.positionals].join(', ')}`,
      );
    }
    return { ...(await readJsonInput(ctx)), ...confirmTokenOf(ctx) };
  }
  const [path, ...words] = ctx.positionals;
  if (path === undefined) throw new UsageError('informe o caminho: cabecao write <caminho> [conteúdo]');
  const file = stringOption(ctx, 'file');
  if (file !== undefined && words.length > 0)
    throw new UsageError('use o conteúdo no argumento ou --file, não os dois');
  const content =
    words.length > 0
      ? words.join(' ')
      : file !== undefined
        ? await readTextFile(ctx, file, 'o conteúdo')
        : await readAllStdin(ctx, 'o conteúdo');
  const frontmatter = frontmatterOf(ctx);
  const session = stringOption(ctx, 'session');
  return {
    path,
    mode: stringOption(ctx, 'mode') ?? 'create',
    content,
    ...(frontmatter === undefined ? {} : { frontmatter }),
    ...(session === undefined ? {} : { session_handle: session }),
    ...confirmTokenOf(ctx),
  };
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const input = checkInput(writePageInput, await inputOf(ctx), 'write_page') as WritePageInput;
  const root = await resolveBrain(ctx);
  const { output, code } = await withBrain(ctx, root, (brain) =>
    withConfirmation(ctx, (options) => brain.writePage(input, options)),
  );
  return { data: output, text: writeText(output, 'cabecao write'), code };
}
