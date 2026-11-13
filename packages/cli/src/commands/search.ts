import type { SearchInput, SearchOutput } from '@cabecao/core';
import { BrainError } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const MAX_LIMIT = 100;

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const limit = Number(text);
  if (!/^\d+$/.test(text) || limit < 1 || limit > MAX_LIMIT) {
    throw new UsageError(`--limit deveria ser um número de 1 a ${MAX_LIMIT}`);
  }
  return limit;
}

function typesOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return list.length === 0 ? undefined : list;
}

export function searchText(output: SearchOutput): string {
  if (output.hits.length === 0) {
    return [
      `Nada encontrado para "${output.query}".`,
      ...(output.next_step === undefined ? [] : [output.next_step]),
    ].join('\n');
  }
  const how = output.mode === 'and' ? 'com todos os termos' : 'com algum dos termos (nenhuma nota tinha todos)';
  const lines = [`${output.hits.length} resultado(s) para "${output.query}", ${how}:`, ''];
  output.hits.forEach((hit, i) => {
    const tags = [hit.type ?? 'sem tipo', ...(hit.scope === null ? [] : [hit.scope])].join(' · ');
    const validity = hit.validity === 'current' ? 'vigente' : 'VENCIDO';
    lines.push(`${i + 1}. ${hit.title ?? hit.path}  [${tags}]  ${validity}`);
    const section = hit.heading_path.length === 0 ? '' : ` › ${hit.heading_path.join(' › ')}`;
    lines.push(`   ${hit.path}${section}`);
    const snippet = hit.content.replace(/\s+/g, ' ').trim();
    if (snippet !== '') lines.push(`   ${snippet}`);
    lines.push('');
  });
  if (output.truncated) lines.push('Há mais resultados: use --limit para ver mais, ou refine a pergunta.');
  return lines.join('\n').trimEnd();
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const query = ctx.positionals.join(' ').trim();
  if (query === '') throw new UsageError('diga o que procurar: cabecao search "<pergunta>"');
  const limit = parseLimit(ctx.values.limit);
  const types = typesOf(ctx.values.type);
  const scope = ctx.values.scope;
  const input: SearchInput = {
    query,
    ...(limit === undefined ? {} : { limit }),
    ...(types === undefined ? {} : { types }),
    ...(typeof scope === 'string' ? { scope } : {}),
  };
  const root = await resolveBrain(ctx);
  let output: SearchOutput;
  try {
    output = await withBrain(ctx, root, (brain) => brain.search(input));
  } catch (error) {
    // Tipo ou escopo inválido é erro de uso: o núcleo já explica o formato certo.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof BrainError && cause.code === 'invalid_argument') throw new UsageError(cause.message);
    throw error;
  }
  return { data: output, text: searchText(output) };
}
