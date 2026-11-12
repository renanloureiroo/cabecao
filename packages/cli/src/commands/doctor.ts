import { resolveBrain } from '../brain.ts';
import type { DoctorReport } from '../doctor/checks.ts';
import { evaluate, renderReport } from '../doctor/checks.ts';
import type { DoctorIo, GatherOptions } from '../doctor/facts.ts';
import { gatherFacts } from '../doctor/facts.ts';
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
  const header = report.brain === null ? 'Diagnóstico do Cabeção' : `Diagnóstico do Cabeção: ${report.brain}`;
  return {
    code: report.summary.fail > 0 ? 1 : 0,
    data: report,
    text: `${header}\n\n${renderReport(report)}`,
  };
}
