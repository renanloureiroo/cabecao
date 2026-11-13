import type { BrainConfig } from '@cabecao/core';
import { readBrainConfig } from '@cabecao/core';
import { resolveBrain } from '../brain.ts';
import type { DoctorReport } from '../doctor/checks.ts';
import { evaluate, renderReport } from '../doctor/checks.ts';
import type { DoctorIo, GatherOptions } from '../doctor/facts.ts';
import { gatherFacts } from '../doctor/facts.ts';
import { llmCheck } from '../llm/doctor.ts';
import type { CommandContext, CommandResult } from '../types.ts';

/** Coleta os fatos e roda as verificações. Usado pelo `doctor` e pelo último passo do `init`. */
export async function runDoctor(io: DoctorIo, options: GatherOptions): Promise<DoctorReport> {
  return evaluate(await gatherFacts(io, options));
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  let brain: GatherOptions['brain'];
  try {
    brain = { root: await resolveBrain(ctx) };
  } catch (error) {
    brain = { error };
  }
  const report = await runDoctor(ctx, {
    brain,
    offline: ctx.values.offline === true,
    nodeVersion: process.versions.node,
  });
  // o provedor de respostas (opcional) entra só no doctor, nunca no resumo do init
  let brainConfig: BrainConfig | null = null;
  if ('root' in brain && brain.root !== undefined) brainConfig = await readBrainConfig(brain.root).catch(() => null);
  const llm = await llmCheck(ctx, brainConfig, ctx.actor.actor === 'agent').catch((error: unknown) => ({
    id: 'llm',
    title: 'Respostas (ask)',
    status: 'warn' as const,
    message: `não consegui verificar: ${error instanceof Error ? error.message : String(error)}`,
  }));
  report.checks.push(llm);
  report.summary[llm.status] += 1;
  const header = report.brain === null ? 'Diagnóstico do Cabeção' : `Diagnóstico do Cabeção: ${report.brain}`;
  return {
    code: report.summary.fail > 0 ? 1 : 0,
    data: report,
    text: `${header}\n\n${renderReport(report)}`,
  };
}
