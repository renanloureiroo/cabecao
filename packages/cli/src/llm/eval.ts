// `cabecao eval --answers <perguntas.jsonl> [--provider a,b]`: as métricas das respostas do `ask` (núcleo:
// `evaluateAnswers`) com os provedores desta máquina. Um relatório por provedor pedido; sem `--provider`, a ordem de
// recuo configurada, como o `ask` usa. Sem juiz por LLM: só o que dá para conferir sem opinião.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AnswerEvalReport, AnswerQuestion, GenerationProvider, Ratio } from '@cabecao/core';
import { AnswerQuestionsError, evaluateAnswers, parseAnswerQuestions } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';
import { activeProviders, buildProvider, loadLlmMachine } from './machine.ts';

const num = (value: number | null): string => (value === null ? '—' : value.toFixed(2).replace('.', ','));
const ratio = (r: Ratio): string => `${num(r.value)} (${r.hits} de ${r.total})`;

export function answersText(report: AnswerEvalReport, source: string, who: string): string {
  const lines = [
    `${report.questions} pergunta(s) de ${source} (${report.answerable} com resposta no cérebro, ${report.unanswerable} sem), ${who}:`,
    `  citações válidas         ${ratio(report.citation_validity)}`,
    `  afirmações sem apoio     ${ratio(report.unsupported_claims)}`,
    `  fonte certa citada       ${ratio(report.right_source)}`,
    `  recusa correta           ${ratio(report.correct_refusal)}`,
    `  recusa indevida          ${ratio(report.wrong_refusal)}`,
    `  sem resposta gerada      ${report.unavailable}`,
    `  tempo médio ${(report.mean_duration_ms / 1000).toFixed(1).replace('.', ',')} s · tokens: entrada ${report.tokens.input}, saída ${report.tokens.output}`,
    '',
    'Por pergunta:',
    ...report.results.map(
      (r) =>
        `  ${r.id}: ${r.status}${r.answerable ? '' : ' (sem resposta no cérebro)'} · ${r.claims} afirmação(ões), ${r.unsupported} sem apoio, ${r.removed_citations} citação(ões) descartada(s)${r.right_source === null ? '' : r.right_source ? ' · fonte certa' : ' · fonte errada ou ausente'}`,
    ),
    '',
    'As métricas só conferem citação e recusa (sem juiz por LLM); a qualidade do texto, leia você.',
  ];
  return lines.join('\n');
}

export async function runAnswersEval(ctx: CommandContext, file: string): Promise<CommandResult> {
  let questions: AnswerQuestion[];
  try {
    questions = parseAnswerQuestions(await readFile(resolve(ctx.cwd, file), 'utf8'), file);
  } catch (error) {
    if (error instanceof AnswerQuestionsError) throw new CliError(error.message, { code: error.code });
    throw new CliError(`não consegui ler ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'ENOENT',
    });
  }
  const machine = await loadLlmMachine(ctx);
  const config = machine.config;
  const wanted = (
    Array.isArray(ctx.values.provider)
      ? ctx.values.provider
      : ctx.values.provider === undefined
        ? []
        : [ctx.values.provider]
  )
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const runs: { who: string; providers: GenerationProvider[] }[] = [];
  if (wanted.length === 0) {
    const providers = await activeProviders(ctx, machine);
    if (providers.length === 0) {
      throw new CliError('nenhum provedor de respostas ativado nesta máquina', {
        code: 'ELLM_NONE',
        hint: 'Rode "cabecao llm on" num terminal; depois, "cabecao eval --answers" de novo.',
      });
    }
    runs.push({ who: `provedores na ordem configurada (${providers.map((p) => p.id).join(', ')})`, providers });
  } else {
    for (const id of wanted) {
      const entry = config?.providers[id];
      if (entry === undefined || entry.consented_at === null) {
        throw new UsageError(`o provedor "${id}" não está ativado nesta máquina (veja "cabecao llm status")`);
      }
      const provider = buildProvider(ctx, machine, id, entry);
      runs.push({ who: `provedor ${id} (modelo ${provider.model ?? 'padrão'})`, providers: [provider] });
    }
  }
  const root = await resolveBrain(ctx);
  const reports: { who: string; report: AnswerEvalReport }[] = [];
  for (const run of runs) {
    const limits = config?.limits;
    const report = await withBrain(ctx, root, (brain) =>
      evaluateAnswers(brain, questions, {
        providers: run.providers,
        ...(limits === undefined
          ? {}
          : {
              limits: {
                contextTokens: limits.context_tokens,
                maxOutputTokens: limits.max_output_tokens,
                timeoutMs: limits.timeout_ms,
              },
            }),
      }),
    );
    reports.push({ who: run.who, report });
  }
  return {
    data: reports.length === 1 ? reports[0]?.report : reports,
    text: reports.map(({ who, report }) => answersText(report, file, who)).join('\n\n'),
  };
}
