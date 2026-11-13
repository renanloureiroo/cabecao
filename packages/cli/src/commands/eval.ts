import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EvalQuestion, EvaluateOutput } from '@cabecao/core';
import { EvalQuestionsError, parseEvalQuestions } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const num = (value: number): string => value.toFixed(3).replace('.', ',');

function parseAlphas(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim().replace(',', '.'))
    .filter((item) => item !== '');
  const alphas = list.map(Number);
  if (alphas.length === 0 || alphas.some((a) => !Number.isFinite(a) || a < 0 || a > 1)) {
    throw new UsageError('--alpha deveria ser um número de 0 a 1 (repita, ou separe por vírgula)');
  }
  return alphas;
}

function parseK(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const k = Number(String(value));
  if (!Number.isInteger(k) || k < 1 || k > 100) throw new UsageError('--k deveria ser um número de 1 a 100');
  return k;
}

/** A tabela de métricas: uma linha por configuração, com a diferença contra a palavra-chave. */
export function evalText(output: EvaluateOutput, source: string): string {
  const { report } = output;
  const lines = [
    `${report.questions} pergunta(s) de ${source}; métricas @${report.k} (MRR, nDCG, recall e acerto na 1ª posição).`,
  ];
  if (!output.vector) {
    lines.push(
      `Sem vetores: ${output.vector_problem ?? 'busca por significado indisponível'}. Só a palavra-chave foi medida.`,
    );
  } else lines.push(`Modelo: ${output.model}.`);
  lines.push('');
  const width = Math.max(14, ...report.configs.map((c) => c.name.length));
  lines.push(`${'configuração'.padEnd(width)}  MRR    nDCG   recall acerto@1`);
  for (const config of report.configs) {
    const o = config.overall;
    lines.push(`${config.name.padEnd(width)}  ${num(o.mrr)}  ${num(o.ndcg)}  ${num(o.recall)}  ${num(o.hitAt1)}`);
  }
  const kinds = [...new Set(report.configs.flatMap((c) => Object.keys(c.byKind)))].filter((k) => k !== '');
  if (kinds.length > 0) {
    lines.push('', 'MRR por tipo de pergunta:');
    lines.push(`${'configuração'.padEnd(width)}  ${kinds.map((k) => k.padEnd(10)).join(' ')}`);
    for (const config of report.configs) {
      lines.push(
        `${config.name.padEnd(width)}  ${kinds.map((k) => (config.byKind[k] === undefined ? '—' : num(config.byKind[k].mrr)).padEnd(10)).join(' ')}`,
      );
    }
  }
  if (report.differences.length > 0) {
    lines.push('', `Contra "${report.configs[0]?.name}" (MRR, intervalo de 95% por bootstrap):`);
    for (const diff of report.differences) {
      const verdict = diff.verdict === 'better' ? 'melhor' : diff.verdict === 'worse' ? 'pior' : 'inconclusivo';
      lines.push(
        `  ${diff.config}: ${diff.diff >= 0 ? '+' : ''}${num(diff.diff)} [${num(diff.low)}; ${num(diff.high)}] ${verdict}`,
      );
    }
  }
  const misses = report.configs.at(-1)?.questions.filter((q) => q.firstRelevantRank === null) ?? [];
  if (misses.length > 0) {
    lines.push(
      '',
      `Sem acerto nas ${report.k} primeiras (${report.configs.at(-1)?.name}): ${misses.map((q) => q.id).join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** `cabecao eval <arquivo.jsonl>`: compara palavra-chave, vetor e fusão com as perguntas do usuário. */
export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [file, ...extra] = ctx.positionals;
  if (file === undefined) throw new UsageError('diga o arquivo de perguntas: cabecao eval <perguntas.jsonl>');
  if (extra.length > 0) throw new UsageError(`argumento a mais: ${extra.join(' ')}`);
  if (ctx.values.answers === true) {
    // as respostas do `ask` (opcional): o código dos provedores só carrega aqui
    const { runAnswersEval } = await import('../llm/eval.ts');
    return runAnswersEval(ctx, file);
  }
  if (ctx.values.provider !== undefined) throw new UsageError('--provider só vale com --answers');
  const alphas = parseAlphas(ctx.values.alpha);
  const k = parseK(ctx.values.k);
  const path = resolve(ctx.cwd, file);
  let questions: EvalQuestion[];
  try {
    questions = parseEvalQuestions(await readFile(path, 'utf8'), file);
  } catch (error) {
    if (error instanceof EvalQuestionsError) throw new CliError(error.message, { code: error.code, cause: error });
    throw new CliError(`não consegui ler ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'ENOENT',
      cause: error,
    });
  }
  const root = await resolveBrain(ctx);
  const output = await withBrain(ctx, root, (brain) =>
    brain.evaluateSearch({
      questions,
      ...(alphas === undefined ? {} : { alphas }),
      ...(k === undefined ? {} : { k }),
    }),
  );
  return { data: output, text: evalText(output, file) };
}
