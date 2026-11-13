import type { ForgetOutput } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { confirmTokenOf, EXIT_CONFIRM, stringOption } from '../memory.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const DEFAULT_REASON = 'esquecida pelo usuário na CLI';
const DEFAULT_AGENT_REASON = 'arquivada por um agente pela CLI';

export function forgetText(output: ForgetOutput): string {
  if (output.status === 'confirmation_required') {
    return [
      `Nada foi arquivado. ${output.summary}`,
      `Se o usuário pediu, repita o mesmo comando (mesma nota e mesmo --reason) com --confirm ${output.confirm_token ?? '<token>'} (vale até ${output.token_expires_at ?? '?'}).`,
      `Próximo passo: ${output.next_step}`,
    ].join('\n');
  }
  if (output.status !== 'archived') return output.summary;
  return [
    `Arquivada: ${output.note.path} → ${output.archived_path ?? 'memory/_archive/'} (commit ${output.commit?.slice(0, 10) ?? '?'}).`,
    'A nota saiu da busca e do recall e continua no git.',
    `Mudou de ideia? "cabecao undo --op ${output.op ?? '?'}" traz de volta.`,
  ].join('\n');
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [id, ...rest] = ctx.positionals;
  if (id === undefined) throw new UsageError('informe a nota: cabecao forget <id ou caminho>');
  if (rest.length > 0) throw new UsageError(`argumento a mais: ${rest.join(' ')}`);
  const agent = ctx.actor.actor === 'agent';
  const reason =
    typeof ctx.values.reason === 'string' && ctx.values.reason.trim() !== ''
      ? ctx.values.reason
      : agent
        ? DEFAULT_AGENT_REASON
        : DEFAULT_REASON;
  const yes = ctx.values.yes === true;
  const root = await resolveBrain(ctx);
  if (agent) {
    // um agente usa o fluxo das tools: a primeira chamada devolve o resumo e o token; a segunda, com --confirm, arquiva
    if (yes) {
      throw new CliError(`--yes não vale para um agente: ${ctx.actor.explanation}`, {
        code: 'human_only',
        hint: 'Rode sem --yes: a primeira chamada devolve o resumo e o confirm_token; mostre ao usuário e, se ele disser sim, repita com --confirm <token>.',
      });
    }
    const session = stringOption(ctx, 'session');
    const output = await withBrain(ctx, root, (brain) =>
      brain.forget({
        id,
        reason,
        ...(session === undefined ? {} : { session_handle: session }),
        ...confirmTokenOf(ctx),
      }),
    );
    return {
      data: output,
      text: forgetText(output),
      code: output.status === 'confirmation_required' ? EXIT_CONFIRM : 0,
    };
  }
  const output = await withBrain(ctx, root, async (brain) => {
    const preview = await brain.forget({ id, reason });
    if (!yes) {
      if (ctx.prompt === undefined) {
        throw new CliError(`sem terminal para confirmar: ${preview.summary}`, {
          code: 'ECONFIRM',
          hint: 'Rode de novo com --yes para arquivar sem perguntar.',
        });
      }
      // a pergunta vai direto ao terminal controlador (nunca ao stdin)
      const answer = (await ctx.prompt(`${preview.summary}\nArquivar? [s/N] `))?.trim().toLowerCase() ?? '';
      if (!['s', 'sim', 'y', 'yes'].includes(answer)) return null;
    }
    return brain.forget({ id, reason }, { userConfirmed: true });
  });
  if (output === null) return { text: 'Nada foi arquivado.', data: { status: 'declined' } };
  return { data: output, text: forgetText(output) };
}
