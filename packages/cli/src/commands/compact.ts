import type { CompactOutput, SyncOutput } from '@cabecao/core';
import { pruneRemoteGenerations } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import { formatBytes } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

export interface CompactData {
  readonly before_sync: SyncOutput['status'] | null;
  /** Vetores de trechos que não existem mais foram descartados (só com o conteúdo em dia com o remoto). */
  readonly dropped_orphans: boolean;
  readonly compact: CompactOutput | null;
  readonly after_sync: SyncOutput['status'] | null;
  readonly pruned: readonly string[];
  readonly kept: readonly { ref: string; reason: string }[];
}

/**
 * `cabecao compact` (doc 04, "Crescimento do repositório"): sincroniza (para o conteúdo e a branch de índice
 * estarem em dia com o remoto), compacta numa geração nova e sincroniza de novo para enviar a geração. Com
 * `--prune`, apaga no remoto as gerações antigas que já estão inteiras na nova.
 */
export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const root = await resolveBrain(ctx);
  const data = await withBrain(ctx, root, async (brain): Promise<CompactData> => {
    const before = await brain.sync();
    const remote = before.remote;
    // com o remoto fora do ar, o conteúdo daqui pode estar atrasado: só junta e tira repetidos, sem descartar vetores
    // de trechos que outra máquina pode estar usando
    const current = remote === null || before.status === 'ok';
    const compact = await brain.compactIndex({ dropOrphans: current });
    const after = compact === null || remote === null ? null : await brain.sync();
    let pruned: string[] = [];
    let kept: { ref: string; reason: string }[] = [];
    if (ctx.values.prune === true && remote !== null && after?.status === 'ok') {
      const result = await pruneRemoteGenerations(root, remote);
      pruned = [...result.deleted];
      kept = [...result.kept];
    }
    return {
      before_sync: remote === null ? null : before.status,
      dropped_orphans: current,
      compact,
      after_sync: after?.status ?? null,
      pruned,
      kept,
    };
  });
  const c = data.compact;
  if (c === null) {
    return { data, text: 'Nada a compactar: este cérebro não tem branch de índice.' };
  }
  const lines = [
    `Índice compactado: geração ${c.generation.from} → ${c.generation.to}.`,
    `Segmentos: ${c.before.segments} → ${c.after.segments} · vetores: ${c.before.vectors} → ${c.after.vectors} · tamanho: ${formatBytes(c.before.bytes)} → ${formatBytes(c.after.bytes)}`,
    `Removidos: ${c.removed.orphans} de trechos que não existem mais, ${c.removed.duplicates} repetidos, ${c.removed.invalidSegments} segmentos inválidos${
      c.removed.models.length > 0 ? `, pastas de modelos fora de uso: ${c.removed.models.join(', ')}` : ''
    }.`,
  ];
  if (!data.dropped_orphans) {
    lines.push(
      'O remoto não respondeu: vetores de trechos que não existem aqui foram mantidos (rode de novo com rede).',
    );
  }
  if (data.after_sync !== null) lines.push(`Envio da geração nova: ${data.after_sync}.`);
  if (data.pruned.length > 0) lines.push(`Gerações antigas apagadas no remoto: ${data.pruned.join(', ')}.`);
  for (const item of data.kept) lines.push(`Mantida no remoto: ${item.ref} (${item.reason}).`);
  return { data, text: lines.join('\n') };
}
