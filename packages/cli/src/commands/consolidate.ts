// `cabecao consolidate`: prepara a consolidação (ponto de restauração e material) e a fecha. Quem raciocina é um
// agente (o Cabeção não tem LLM): esta CLI não chama nenhum. Chamar um agente não interativo (`claude -p`) daqui foi
// deixado de fora: as tools MCP chegam a ele adiadas e com nome que depende de como o servidor foi instalado (plugin
// ou `install-client`), o que não foi testado; o agendamento é de `cabecao schedule`.
import type { ConsolidateOutput } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

export function startText(output: ConsolidateOutput): string {
  const material = output.material;
  const lines = [
    `Consolidação ${output.consolidation_id} preparada.`,
    `Ponto de restauração: ${output.restore_point.tag} (${output.restore_point.commit.slice(0, 10)}).`,
    '',
  ];
  if (material !== null) {
    lines.push(
      `Material: ${material.repeated_episodes.length} grupo(s) de episódios parecidos, ${material.duplicates.length} par(es) de notas parecidas, ${material.lint.length} achado(s) do lint.`,
    );
    for (const group of material.repeated_episodes.slice(0, 5)) {
      lines.push(`  episódios: ${group.notes.map((note) => note.path).join(', ')}`);
    }
    for (const pair of material.duplicates.slice(0, 5)) {
      lines.push(`  ${pair.verdict}: ${pair.a.path} × ${pair.b.path}`);
    }
  }
  lines.push(
    '',
    'Peça a um agente com o Cabeção (no Claude Code, por exemplo) para seguir estes passos:',
    ...output.instructions.map((step, i) => `  ${i + 1}. ${step}`),
    '',
    `Depois, feche com "cabecao consolidate --finish ${output.consolidation_id}" (ou o agente fecha com a tool).`,
  );
  return lines.join('\n');
}

export function finishText(output: ConsolidateOutput): string {
  if (output.commit === null) return output.next_step;
  return [
    output.squashed
      ? `Consolidação fechada num commit (${output.commit.slice(0, 10)}):`
      : `Consolidação fechada (${output.commit.slice(0, 10)}); os commits ficaram separados:`,
    ...output.changes.map((line) => `  - ${line}`),
    `Para desfazer tudo: "cabecao undo --session ${output.consolidation_id}".`,
  ].join('\n');
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const finishId = typeof ctx.values.finish === 'string' ? ctx.values.finish.trim() : undefined;
  const scope = typeof ctx.values.scope === 'string' ? ctx.values.scope : undefined;
  const title = typeof ctx.values.title === 'string' ? ctx.values.title : undefined;
  if (finishId !== undefined && scope !== undefined)
    throw new UsageError('--scope vale só ao preparar, não com --finish');
  if (finishId === undefined && title !== undefined) throw new UsageError('--title vale só com --finish');
  const root = await resolveBrain(ctx);
  if (finishId !== undefined) {
    const output = await withBrain(ctx, root, (brain) =>
      brain.consolidate({ action: 'finish', consolidation_id: finishId, ...(title === undefined ? {} : { title }) }),
    );
    return { data: output, text: finishText(output) };
  }
  const output = await withBrain(ctx, root, (brain) =>
    brain.consolidate({ action: 'start', ...(scope === undefined ? {} : { scope }) }),
  );
  return { data: output, text: startText(output) };
}
