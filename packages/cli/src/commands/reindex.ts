import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

/** `cabecao reindex [--full]`: reconstrói o banco local (incremental, ou do zero com `--full`). */
export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const full = ctx.values.full === true;
  const root = await resolveBrain(ctx);
  const summary = await withBrain(ctx, root, (brain) => brain.reindex({ full }));
  const lines = [
    full ? 'Banco local refeito do zero.' : 'Banco local atualizado.',
    `Notas: ${summary.total} (novas ${summary.added}, alteradas ${summary.updated}, removidas ${summary.removed}, movidas ${summary.renamed}) em ${summary.ms} ms.`,
  ];
  if (summary.errors.length > 0) {
    lines.push(`Problemas em ${summary.errors.length} nota(s):`);
    for (const issue of summary.errors.slice(0, 10)) lines.push(`  ${issue.path}: ${issue.message}`);
  }
  return { data: { full, ...summary }, text: lines.join('\n') };
}
