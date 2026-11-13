import type { GraphInput, GraphOutput, Validity } from '@cabecao/core';
import { BrainError } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

/** Rótulo da validade para o terminal (o mesmo do `search`). */
export function validityLabel(validity: Validity): string {
  return validity === 'current' ? 'vigente' : validity === 'expired' ? 'VENCIDO' : 'AINDA NÃO VIGENTE';
}

/** Lista de `--type` repetido ou separado por vírgula. */
export function listOption(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return list.length === 0 ? undefined : list;
}

/** Erro de argumento do núcleo (data, tipo, referência ambígua) vira erro de uso, com a explicação dele. */
export function asUsageError(error: unknown): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof BrainError && cause.code === 'invalid_argument') {
    return new UsageError(cause.nextStep === null ? cause.message : `${cause.message}. ${cause.nextStep}`);
  }
  return error;
}

function parseDepth(value: unknown): 1 | 2 | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (text === '1') return 1;
  if (text === '2') return 2;
  throw new UsageError('--depth deveria ser 1 ou 2');
}

export function graphText(output: GraphOutput): string {
  const title = output.node.title ?? output.node.path;
  const lines = [
    `${title}  [${output.node.type ?? 'sem tipo'}]  ${validityLabel(output.node.validity)}`,
    `${output.node.path}`,
    `Vizinhos até ${output.depth} salto(s), validade em ${output.as_of}${output.relation_types === null ? '' : `, só ${output.relation_types.join(', ')}`}:`,
    '',
  ];
  if (output.neighbors.length === 0) lines.push('Nenhum vizinho.');
  for (const distance of [1, 2]) {
    const group = output.neighbors.filter((neighbor) => neighbor.distance === distance);
    if (group.length === 0) continue;
    lines.push(distance === 1 ? 'Ligados direto:' : 'A dois saltos:');
    for (const neighbor of group) {
      lines.push(
        `  ${neighbor.title ?? neighbor.path}  [${neighbor.type ?? 'sem tipo'}]  ${validityLabel(neighbor.validity)}`,
      );
      lines.push(`    ${neighbor.path}`);
      for (const link of neighbor.links) {
        const arrow = `${link.from} —${link.type}→ ${link.to}`;
        lines.push(`    ${arrow}${link.validity === 'current' ? '' : ` (${validityLabel(link.validity)})`}`);
      }
    }
    lines.push('');
  }
  if (output.truncated) {
    lines.push(`${output.omitted} vizinho(s) ficaram de fora: filtre com --type ou consulte um vizinho direto.`);
  }
  return lines.join('\n').trimEnd();
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const node = ctx.positionals.join(' ').trim();
  if (node === '') throw new UsageError('diga de qual nota: cabecao graph "<título, caminho ou id>"');
  const depth = parseDepth(ctx.values.depth);
  const types = listOption(ctx.values.type);
  const asOf = ctx.values['as-of'];
  const input: GraphInput = {
    node,
    ...(depth === undefined ? {} : { depth }),
    ...(types === undefined ? {} : { relation_types: types }),
    ...(typeof asOf === 'string' ? { as_of: asOf } : {}),
  };
  const root = await resolveBrain(ctx);
  let output: GraphOutput;
  try {
    output = await withBrain(ctx, root, (brain) => brain.graph(input));
  } catch (error) {
    throw asUsageError(error);
  }
  return { data: output, text: graphText(output) };
}
