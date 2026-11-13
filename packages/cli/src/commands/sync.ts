import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncOutput } from '@cabecao/core';
import { BRAIN_CONFIG_FILE, BrainError, isInvalidConfigError, isUlid, syncBrain, toSyncOutput } from '@cabecao/core';
import { appendSyncLog, logBlock, startDetachedSync } from '../background.ts';
import { CLI_CLIENT, readMachine, resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { EMPTY_HOOK_INPUT, hookBrain, readHookInput } from '../hook/input.ts';
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

async function isBrainDir(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, BRAIN_CONFIG_FILE))).isFile();
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const hint = (error as { hint?: unknown } | null)?.hint;
  return typeof hint === 'string' ? `${message} (${hint})` : message;
}

/**
 * `--detach` e `--hook`: dispara o sync num processo destacado e volta na hora (o resultado vai para
 * `.cabecao/logs/sync.log`). Com `--hook` (o fim de sessão do Claude Code), lê o JSON da sessão no stdin e nunca
 * falha: qualquer problema vai só para o stderr, com código 0.
 */
async function runDetached(ctx: CommandContext): Promise<CommandResult> {
  const hook = ctx.values.hook === true;
  try {
    if (ctx.values.log === true)
      throw new UsageError('--log não combina com --detach: o sync em segundo plano já grava no log');
    if (ctx.values.session !== undefined) throw new UsageError('--session não combina com --detach');
    const input = hook ? await readHookInput(ctx) : EMPTY_HOOK_INPUT;
    const root = await resolveBrain(hook ? { ...ctx, brain: hookBrain(ctx) } : ctx);
    if (!(await isBrainDir(root))) {
      throw new CliError(`${root} não é um cérebro (falta o ${BRAIN_CONFIG_FILE})`, {
        code: 'not_a_brain',
        hint: 'Confira o caminho do cérebro ou rode "cabecao init".',
      });
    }
    const note = hook
      ? `hook ${input.event ?? 'SessionEnd'} do Claude Code${input.reason === null ? '' : `, motivo ${input.reason}`}`
      : 'cabecao sync --detach';
    const started = await startDetachedSync(ctx, root, note);
    if (hook) return { code: 0 };
    return {
      code: 0,
      data: { status: 'started', pid: started.pid, log: started.log },
      text: `Sync disparado em segundo plano (processo ${started.pid}). O resultado vai para ${started.log}.`,
    };
  } catch (error) {
    if (!hook) throw error;
    ctx.stderr.write(
      `cabecao sync --hook: ${describe(error)}. Nada foi sincronizado agora; o próximo sync leva as mudanças.\n`,
    );
    return { code: 0 };
  }
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 0) throw new UsageError(`argumento a mais: ${ctx.positionals.join(' ')}`);
  if (ctx.values.detach === true || ctx.values.hook === true) return runDetached(ctx);
  const session = typeof ctx.values.session === 'string' ? ctx.values.session : undefined;
  const root = await resolveBrain(ctx);
  const log = ctx.values.log === true;
  const startedAt = new Date();
  // O sync roda aqui mesmo: `cabecao sync` já é o processo separado que o hook e o servidor MCP disparam.
  let output: SyncOutput;
  try {
    try {
      output = await withBrain(ctx, root, (brain) =>
        brain.sync(session === undefined ? {} : { session_handle: session }),
      );
    } catch (error) {
      if (!invalidConfig(error)) throw error;
      output = await syncWithoutBrain(ctx, root, session);
    }
  } catch (error) {
    if (log) await writeLog(ctx, root, logBlock(startedAt, new Date(), 1, `Erro: ${describe(error)}`));
    throw error;
  }
  const code = syncExitCode(output);
  const text = syncText(output);
  if (log) await writeLog(ctx, root, logBlock(startedAt, new Date(), code, text));
  return { code, data: output, text };
}

/** Grava no log sem nunca derrubar o sync: um disco cheio vira só um aviso. */
async function writeLog(ctx: CommandContext, root: string, block: string): Promise<void> {
  try {
    await appendSyncLog(root, block);
  } catch (error) {
    ctx.stderr.write(`cabecao: não consegui gravar o log do sync: ${describe(error)}\n`);
  }
}
