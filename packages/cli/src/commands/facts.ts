import type { FactsInput, FactsOutput } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';
import { asUsageError, validityLabel } from './graph.ts';

const MAX_LIMIT = 200;

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const limit = Number(text);
  if (!/^\d+$/.test(text) || limit < 1 || limit > MAX_LIMIT) {
    throw new UsageError(`--limit deveria ser um número de 1 a ${MAX_LIMIT}`);
  }
  return limit;
}

export function factsText(output: FactsOutput): string {
  if (output.facts.length === 0) {
    return [
      `Nenhum fato (validade em ${output.as_of}).`,
      ...(output.next_step === undefined ? [] : [output.next_step]),
    ].join('\n');
  }
  const lines = [`${output.facts.length} fato(s), validade em ${output.as_of}:`, ''];
  output.facts.forEach((fact, i) => {
    const subject = fact.subject ?? '?';
    const object = fact.object ?? '?';
    lines.push(`${i + 1}. ${subject} · ${fact.predicate ?? '?'} · ${object}  ${validityLabel(fact.validity)}`);
    const from = fact.valid_from ?? 'sem início';
    const until = fact.valid_until ?? fact.superseded_on ?? 'em aberto';
    lines.push(`   de ${from} até ${until}   ${fact.path}`);
    if (fact.supersedes.length > 0) lines.push(`   substitui: ${fact.supersedes.join(', ')}`);
    if (fact.superseded_by.length > 0) lines.push(`   substituído por: ${fact.superseded_by.join(', ')}`);
    lines.push('');
  });
  if (output.truncated) lines.push(`Há ${output.total} fatos: use --limit para ver mais, ou filtre.`);
  return lines.join('\n').trimEnd();
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) {
    throw new UsageError('use as opções: cabecao facts --subject "<nota>" [--predicate <p>] [--object "<nota>"]');
  }
  const limit = parseLimit(ctx.values.limit);
  const pick = (name: string): string | undefined => {
    const value = ctx.values[name];
    return typeof value === 'string' ? value : undefined;
  };
  const subject = pick('subject');
  const predicate = pick('predicate');
  const object = pick('object');
  const asOf = pick('as-of');
  const input: FactsInput = {
    ...(subject === undefined ? {} : { subject }),
    ...(predicate === undefined ? {} : { predicate }),
    ...(object === undefined ? {} : { object }),
    ...(asOf === undefined ? {} : { as_of: asOf }),
    ...(limit === undefined ? {} : { limit }),
  };
  const root = await resolveBrain(ctx);
  let output: FactsOutput;
  try {
    output = await withBrain(ctx, root, (brain) => brain.facts(input));
  } catch (error) {
    throw asUsageError(error);
  }
  return { data: output, text: factsText(output) };
}
