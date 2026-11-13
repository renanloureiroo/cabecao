// `cabecao consolidate`: prepara a consolidação (ponto de restauração e material) e a fecha. Quem raciocina é um
// agente (o Cabeção não tem LLM). Com `--run`, a CLI chama um agente não interativo (Claude Code ou Codex, os que os
// termos permitem: `agents/policy.ts`) com uma configuração de MCP temporária e confere o resultado: ver
// `consolidate-run/run.ts`. O nome das tools deixa de depender de como o servidor foi instalado, porque o agente só
// enxerga o servidor da configuração temporária.
import type { ConsolidateOutput } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES, runConsolidation } from '../consolidate-run/run.ts';
import { CliError, UsageError } from '../errors.ts';
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
    'Peça a um agente com o Cabeção (no Claude Code, por exemplo) para seguir estes passos, ou rode "cabecao consolidate --run" para o Cabeção chamar um sozinho:',
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

const RUN_ONLY = ['agent', 'timeout', 'dry-run', 'model', 'allow-forget', 'allow-elevated'] as const;
/** Opções que liberam, sem ninguém olhando, o que só o usuário libera: só ele, no terminal, as passa. */
const HUMAN_OPTIONS = ['allow-forget', 'allow-elevated'] as const;

function timeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MINUTES * 60_000;
  const minutes = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TIMEOUT_MINUTES) {
    throw new UsageError(`--timeout espera os minutos, até ${MAX_TIMEOUT_MINUTES} (aceita fração, como 0.5)`);
  }
  return Math.round(minutes * 60_000);
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const finishId = typeof ctx.values.finish === 'string' ? ctx.values.finish.trim() : undefined;
  const scope = typeof ctx.values.scope === 'string' ? ctx.values.scope : undefined;
  const title = typeof ctx.values.title === 'string' ? ctx.values.title : undefined;
  const runMode = ctx.values.run === true;
  const runOnly = RUN_ONLY.filter((name) => ctx.values[name] !== undefined && ctx.values[name] !== false);
  if (!runMode && runOnly.length > 0) throw new UsageError(`--${runOnly[0]} vale só com --run`);
  if (runMode) {
    if (finishId !== undefined || title !== undefined)
      throw new UsageError('--run não combina com --finish nem --title');
    // `--run` sem estas opções roda também sem terminal (agendado); com elas, a liberação tem de vir do usuário
    const granted = HUMAN_OPTIONS.filter((name) => ctx.values[name] === true);
    if (granted.length > 0 && ctx.actor.actor !== 'human') {
      throw new CliError(`--${granted.join(' e --')} só o usuário passa, no terminal: ${ctx.actor.explanation}`, {
        code: 'human_only',
        hint: 'Rode "cabecao consolidate --run" sem essas opções (as ações que elas liberam ficam para você), ou rode no seu terminal.',
      });
    }
    return runConsolidation(ctx, {
      agent: typeof ctx.values.agent === 'string' ? ctx.values.agent.trim() : undefined,
      scope,
      timeoutMs: timeoutMs(ctx.values.timeout),
      dryRun: ctx.values['dry-run'] === true,
      model:
        typeof ctx.values.model === 'string' && ctx.values.model.trim() !== '' ? ctx.values.model.trim() : undefined,
      allowForget: ctx.values['allow-forget'] === true,
      allowElevated: ctx.values['allow-elevated'] === true,
    });
  }
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
