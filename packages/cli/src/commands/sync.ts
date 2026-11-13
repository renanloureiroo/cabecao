import type { SyncOutput } from '@cabecao/core';
import { BrainError, isInvalidConfigError, isUlid, syncBrain, toSyncOutput } from '@cabecao/core';
import { CLI_CLIENT, readMachine, resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { plural } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const STATUS_TEXT: Readonly<Record<SyncOutput['status'], string>> = {
  ok: 'ok',
  busy: 'outro sync em andamento',
  blocked: 'bloqueado',
  offline: 'remoto indisponível',
  error: 'erro',
};

/**
 * Código de saída do sync:
 * - 0: `ok`, e também `busy` (outro sync já está fazendo o trabalho; não é erro);
 * - 1: `blocked` e `error`;
 * - `offline`: 0 quando não há remoto configurado (cérebro só local, com aviso), 1 quando o remoto falhou.
 */
export function syncExitCode(output: Pick<SyncOutput, 'status' | 'remote'>): number {
  switch (output.status) {
    case 'ok':
    case 'busy':
      return 0;
    case 'offline':
      return output.remote === null ? 0 : 1;
    default:
      return 1;
  }
}

export function syncText(output: SyncOutput): string {
  const lines = [`Sync: ${STATUS_TEXT[output.status]}. ${output.message}`.trim()];
  if (output.status === 'ok' || output.pulled + output.pushed + output.committed > 0) {
    lines.push(
      `Recebidos: ${plural(output.pulled, 'commit', 'commits')} · enviados: ${output.pushed} · criados neste sync: ${output.committed}`,
    );
  }
  const index = output.index;
  if (index?.participating === true) {
    const parts = [
      `vetores recebidos ${index.received}`,
      `calculados ${index.computed}`,
      `enviados ${index.pushed}`,
      `geração ${index.generation ?? '—'}`,
    ];
    lines.push(`Índice: ${parts.join(' · ')}${index.graph_written ? ' · grafo exportado atualizado' : ''}`);
    if (index.pending !== null && index.pending > 0) {
      lines.push(
        `  ${plural(index.pending, 'trecho sem embedding', 'trechos sem embedding')}${index.skipped === null ? '' : `: ${index.skipped}`}`,
      );
    }
    if (index.error !== null) lines.push(`  Aviso do índice: ${index.error}`);
  }
  if (output.remote === null && (output.status === 'ok' || output.status === 'offline')) {
    lines.push(
      'Aviso: este cérebro não tem remoto; as mudanças ficam só nesta máquina. Para ligar um, crie um repositório privado e vazio e rode, na pasta do cérebro, "git remote add origin <url>" e "git push -u origin <branch>".',
    );
  }
  if (output.conflicts.length > 0) {
    lines.push(`Conflitos (${output.conflicts.length}): nada foi descartado.`);
    for (const conflict of output.conflicts) {
      if (conflict.kind === 'content') {
        lines.push(`  ${conflict.path}: ficou com a versão do remoto; a sua está em ${conflict.copy ?? '?'}`);
      } else if (conflict.kind === 'invalid') {
        lines.push(
          conflict.copy === null
            ? `  ${conflict.path}: apagado no remoto; a versão desta máquina foi mantida`
            : `  ${conflict.path}: a versão do remoto é inválida (${conflict.reason ?? '?'}); ficou a desta máquina, e a do remoto está em ${conflict.copy}`,
        );
      } else {
        const side = conflict.kept === 'local' ? 'desta máquina' : 'do remoto';
        lines.push(`  ${conflict.path}: apagada de um lado e editada do outro; a edição ${side} foi mantida`);
      }
    }
  }
  if (output.secrets.length > 0) {
    lines.push('Possíveis segredos (o valor não é mostrado):');
    for (const hit of output.secrets) {
      const where = hit.where === 'pending' ? 'mudança ainda sem commit' : 'commit que seria enviado';
      lines.push(`  ${hit.path}:${hit.line}:${hit.column}  ${hit.rule} (${hit.description}; ${where})`);
    }
  }
  if (output.remote_error !== null && output.remote_error.detail !== '') {
    lines.push('Saída do git:', ...output.remote_error.detail.split('\n').map((line) => `  ${line}`));
  }
  if (output.recovered.length > 0) {
    lines.push('Recuperado de uma execução interrompida:', ...output.recovered.map((line) => `  ${line}`));
  }
  if (output.next_step !== undefined) lines.push(`Próximo passo: ${output.next_step}`);
  return lines.join('\n');
}

/**
 * Sync sem abrir o cérebro, para quando o `.cabecao.json` da pasta está inválido (`openBrain` recusa abrir): o sync
 * do núcleo roda com a última configuração válida do histórico, e é justamente por ele que a correção feita em outra
 * máquina chega. O banco local é reindexado na próxima abertura.
 */
async function syncWithoutBrain(ctx: CommandContext, root: string, session: string | undefined): Promise<SyncOutput> {
  if (session !== undefined && !isUlid(session)) {
    throw new CliError('"--session" deveria ser o identificador devolvido pelo recall (ULID)', {
      code: 'invalid_argument',
    });
  }
  const machine = (await readMachine(ctx))?.machine;
  return toSyncOutput(
    await syncBrain(root, { client: CLI_CLIENT, session, ...(machine === undefined ? {} : { machine }) }),
  );
}

/** O erro de abertura é um `.cabecao.json` inválido (JSON quebrado ou campo errado; não o esquema mais novo). */
function invalidConfig(error: unknown): boolean {
  if (!(error instanceof CliError) || error.code !== 'invalid_config') return false;
  const cause = error.cause instanceof BrainError ? error.cause.cause : error.cause;
  return isInvalidConfigError(cause);
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  const session = typeof ctx.values.session === 'string' ? ctx.values.session : undefined;
  const root = await resolveBrain(ctx);
  // O sync roda aqui mesmo: `cabecao sync` já é o processo separado que o hook e o servidor MCP disparam.
  let output: SyncOutput;
  try {
    output = await withBrain(ctx, root, (brain) =>
      brain.sync(session === undefined ? {} : { session_handle: session }),
    );
  } catch (error) {
    if (!invalidConfig(error)) throw error;
    output = await syncWithoutBrain(ctx, root, session);
  }
  return { code: syncExitCode(output), data: output, text: syncText(output) };
}
