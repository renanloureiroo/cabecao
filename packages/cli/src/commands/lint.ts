import type { LintInput, LintOutput } from '@cabecao/core';
import { BrainError, MAX_LINT_LIMIT } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const SEVERITY_LABEL = { error: 'ERRO', warning: 'aviso', info: 'info' } as const;

export function lintText(output: LintOutput): string {
  if (output.total === 0) return `Nenhum problema em ${output.checked_notes} notas.`;
  const { error, warning, info } = output.counts;
  const lines = [
    `${output.total} achado(s) em ${output.checked_notes} notas: ${error} erro(s), ${warning} aviso(s), ${info} informativo(s).`,
    '',
  ];
  for (const finding of output.findings) {
    const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    lines.push(`[${SEVERITY_LABEL[finding.severity]}] ${finding.rule}  ${where}`);
    lines.push(`  ${finding.message}`);
    if (finding.related.length > 0) lines.push(`  com: ${finding.related.join(', ')}`);
    lines.push(`  correção: ${finding.fix}`, '');
  }
  if (output.truncated) lines.push(`Mostrando ${output.findings.length} de ${output.total}: use --limit ou --rule.`);
  return lines.join('\n').trimEnd();
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const rules = (
    Array.isArray(ctx.values.rule) ? ctx.values.rule : ctx.values.rule === undefined ? [] : [ctx.values.rule]
  )
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  let limit: number | undefined;
  if (ctx.values.limit !== undefined) {
    const text = String(ctx.values.limit).trim();
    limit = Number(text);
    if (!/^\d+$/.test(text) || limit < 1 || limit > MAX_LINT_LIMIT) {
      throw new UsageError(`--limit deveria ser um número de 1 a ${MAX_LINT_LIMIT}`);
    }
  }
  const scope = typeof ctx.values.scope === 'string' ? ctx.values.scope : undefined;
  const input: LintInput = {
    ...(rules.length === 0 ? {} : { rules }),
    ...(scope === undefined ? {} : { scope }),
    ...(limit === undefined ? {} : { limit }),
  };
  const root = await resolveBrain(ctx);
  let output: LintOutput;
  try {
    output = await withBrain(ctx, root, (brain) => brain.lint(input));
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof BrainError && cause.code === 'invalid_argument') throw new UsageError(cause.message);
    throw error;
  }
  // código 1 quando há erro (frontmatter ilegível ou inválido): serve para scripts e para o CI de quem quiser
  return { data: output, text: lintText(output), code: output.counts.error > 0 ? 1 : 0 };
}
