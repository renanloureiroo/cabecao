// `cabecao patch <caminho>`: a tool `patch_page` pela linha de comando. O trecho antigo e o novo vêm de `--old`/`--new`,
// de `--old-file`/`--new-file` (um deles pode ser `-`, a entrada padrão) ou de um JSON com os campos da tool
// (`--json-input`): para texto com aspas e quebras de linha, nada depende de escape de shell.
import type { PatchPageInput } from '@cabecao/core';
import { patchPageInput } from '@cabecao/server/input-schemas';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import { checkInput, confirmTokenOf, readJsonInput, readTextFile, stringOption, withConfirmation } from '../memory.ts';
import type { CommandContext, CommandResult } from '../types.ts';
import { writeText } from './write.ts';

async function side(ctx: CommandContext, name: 'old' | 'new'): Promise<string | undefined> {
  const inline = stringOption(ctx, name);
  const file = stringOption(ctx, `${name}-file`);
  if (inline !== undefined && file !== undefined) throw new UsageError(`use --${name} ou --${name}-file, não os dois`);
  return file === undefined ? inline : readTextFile(ctx, file, `o trecho de --${name}-file`);
}

async function inputOf(ctx: CommandContext): Promise<Record<string, unknown>> {
  if (ctx.values['json-input'] === true) {
    const given = ['old', 'new', 'old-file', 'new-file', 'session'].filter(
      (option) => ctx.values[option] !== undefined,
    );
    if (given.length > 0 || ctx.positionals.length > 0) {
      throw new UsageError(
        `com --json-input, todos os campos (inclusive path) vêm no JSON; tire ${[...given.map((option) => `--${option}`), ...ctx.positionals].join(', ')}`,
      );
    }
    return { ...(await readJsonInput(ctx)), ...confirmTokenOf(ctx) };
  }
  const [path, ...rest] = ctx.positionals;
  if (path === undefined)
    throw new UsageError('informe o caminho: cabecao patch <caminho> --old <trecho> --new <trecho>');
  if (rest.length > 0) throw new UsageError(`argumento a mais: ${rest.join(' ')}`);
  if (stringOption(ctx, 'old-file') === '-' && stringOption(ctx, 'new-file') === '-') {
    throw new UsageError('só um dos dois lados pode vir da entrada padrão; para os dois, use --json-input');
  }
  const old = await side(ctx, 'old');
  const replacement = await side(ctx, 'new');
  if (old === undefined) throw new UsageError('informe o trecho antigo: --old <trecho> ou --old-file <arquivo>');
  if (replacement === undefined) throw new UsageError('informe o trecho novo: --new <trecho> ou --new-file <arquivo>');
  const session = stringOption(ctx, 'session');
  return {
    path,
    old,
    new: replacement,
    ...(session === undefined ? {} : { session_handle: session }),
    ...confirmTokenOf(ctx),
  };
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const input = checkInput(patchPageInput, await inputOf(ctx), 'patch_page') as PatchPageInput;
  const root = await resolveBrain(ctx);
  const { output, code } = await withBrain(ctx, root, (brain) =>
    withConfirmation(ctx, (options) => brain.patchPage(input, options)),
  );
  return { data: output, text: writeText(output, 'cabecao patch'), code };
}
