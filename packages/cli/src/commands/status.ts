import type { StatusOutput } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { formatWhen, plural } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

function notesLine(status: StatusOutput): string {
  const { notes } = status;
  const types = Object.entries(notes.by_type)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type} ${count}`);
  if (notes.untyped > 0) types.push(`sem tipo ${notes.untyped}`);
  const parts = [`Notas: ${notes.total}${types.length === 0 ? '' : ` (${types.join(', ')})`}`];
  if (notes.archived > 0) parts.push(plural(notes.archived, 'arquivada', 'arquivadas'));
  if (notes.unmanaged > 0) parts.push(`${notes.unmanaged} sem id (fontes ou notas soltas)`);
  return parts.join(' · ');
}

function syncLines(status: StatusOutput): string[] {
  const { sync } = status;
  if (sync === null) return ['Sync: estado do git indisponível (veja os problemas abaixo)'];
  const lines: string[] = [];
  const branch = sync.branch ?? 'HEAD solto';
  lines.push(
    sync.remote === null
      ? `Sync: branch ${branch}, sem remoto (cérebro só desta máquina)`
      : `Sync: branch ${branch} ↔ ${sync.remote.name}/${sync.remote.branch} (${sync.remote.url})`,
  );
  const last = sync.last_sync;
  lines.push(
    last === null ? '  Último sync: nunca' : `  Último sync: ${formatWhen(last.at)}, ${last.status}: ${last.message}`,
  );
  if (sync.running) lines.push('  Um sync está rodando agora.');
  if (sync.remote !== null) {
    lines.push(
      `  Commits não enviados: ${sync.unpushed ?? '?'} · do remoto, ainda não integrados: ${sync.unpulled ?? '?'}`,
    );
  }
  lines.push(`  Mudanças feitas fora do Cabeção, esperando o sync: ${sync.pending_changes}`);
  return lines;
}

export function statusText(status: StatusOutput): string {
  const lines = [
    `Cérebro: ${status.root} (máquina ${status.machine}, esquema ${status.brain_schema_version})`,
    notesLine(status),
    `Links quebrados: ${status.broken_links}`,
    ...syncLines(status),
  ];
  if (status.conflicts.length === 0) {
    lines.push('Conflitos pendentes: nenhum');
  } else {
    lines.push(`Conflitos pendentes: ${status.conflicts.length}`);
    for (const conflict of status.conflicts) {
      const original = conflict.original_exists ? conflict.original : `${conflict.original} (apagada)`;
      lines.push(`  ${conflict.copy} → ${original}`);
    }
  }
  const embeddings = status.embeddings;
  if (embeddings !== null) {
    if (!embeddings.configured) lines.push('Busca por significado: desativada ("cabecao embeddings on" ativa)');
    else {
      lines.push(
        `Busca por significado: ${embeddings.model} · ${embeddings.enabled_here ? `runtime ${embeddings.runtime}` : 'desligada nesta máquina'} · embeddings na fila: ${embeddings.pending ?? '?'} de ${embeddings.chunks} trechos`,
      );
    }
  }
  if (status.problems.length > 0) {
    lines.push('Problemas:');
    for (const problem of status.problems) lines.push(`  - ${problem}`);
  } else {
    lines.push('Saúde: ok');
  }
  if (status.next_step !== undefined) lines.push(`Próximo passo: ${status.next_step}`);
  return lines.join('\n');
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const root = await resolveBrain(ctx);
  const status = await withBrain(ctx, root, (brain) => brain.status());
  // Avisos (conflitos, sync com erro) não mudam o código de saída: o comando funcionou e mostrou o estado.
  return { data: status, text: statusText(status) };
}
