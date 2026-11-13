import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BRAIN_CONFIG_FILE } from '@cabecao/core';
import { syncLogPath } from '../background.ts';
import { readMachine } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { stableBin } from '../install-client/launch.ts';
import { channel } from '../install-method.ts';
import type { ScheduledCommand } from '../schedule/generate.ts';
import { displayCommand, parseInterval } from '../schedule/generate.ts';
import type { Mechanism, ScheduleNames } from '../schedule/system.ts';
import { DEFAULT_NAMES, scheduleOff, scheduleOn, scheduleStatus } from '../schedule/system.ts';
import { didYouMean } from '../suggest.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const MECHANISM_TEXT: Readonly<Record<Mechanism, string>> = {
  launchd: 'LaunchAgent do macOS',
  systemd: 'timer do systemd --user',
  cron: 'crontab',
  schtasks: 'Agendador de Tarefas do Windows',
};

/** Node instalado por um gerenciador de versões: some quando a versão é removida. */
const VERSION_MANAGER =
  /[\\/](?:\.nvm|\.fnm|fnm|\.volta|\.asdf|\.nodenv|\.local[\\/]share[\\/]mise|n[\\/]versions)[\\/]/;

async function isBrainDir(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, BRAIN_CONFIG_FILE))).isFile();
  } catch {
    return false;
  }
}

/** O cérebro do sync agendado: o padrão desta máquina. `--brain` só é aceito quando aponta para ele. */
async function scheduledBrain(ctx: CommandContext): Promise<string> {
  const machine = await readMachine(ctx);
  const configured = machine?.defaultBrain;
  if (configured === undefined) {
    throw new CliError('o sync agendado usa o cérebro padrão desta máquina, e nenhum foi configurado', {
      code: 'EBRAIN',
      hint: 'Rode "cabecao init" (ele grava o cérebro padrão) e depois "cabecao schedule on".',
    });
  }
  const brain = resolve(ctx.cwd, configured);
  if (ctx.brain !== undefined && resolve(ctx.brain) !== brain) {
    throw new CliError(
      `o sync agendado usa sempre o cérebro padrão desta máquina (${brain}), e não a pasta de --brain ou CABECAO_BRAIN`,
      {
        code: 'schedule_brain',
        hint: 'O caminho não vai na linha de comando agendada (no Windows ela tem no máximo 261 caracteres). Rode sem --brain.',
      },
    );
  }
  if (!(await isBrainDir(brain))) {
    throw new CliError(`o cérebro padrão desta máquina (${brain}) não existe mais ou não é um cérebro`, {
      code: 'not_a_brain',
      hint: 'Rode "cabecao init" para configurar o cérebro desta máquina.',
    });
  }
  return brain;
}

/** Variáveis que o processo agendado precisa: o `PATH` (para achar o git) e a pasta da configuração, se trocada. */
function scheduledEnv(ctx: CommandContext): Record<string, string> {
  if (ctx.platform === 'win32') return {};
  const env: Record<string, string> = {};
  const path = ctx.env.PATH;
  if (path !== undefined && path !== '') env.PATH = path;
  const config = ctx.env.CABECAO_CONFIG_DIR;
  if (config !== undefined && config !== '') env.CABECAO_CONFIG_DIR = config;
  return env;
}

async function on(ctx: CommandContext, names: ScheduleNames): Promise<CommandResult> {
  let interval: number;
  try {
    interval = parseInterval(ctx.values.interval);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const brain = await scheduledBrain(ctx);
  const bin = await stableBin(ctx.binPath);
  if (bin === undefined) {
    throw new CliError(
      'o agendamento precisa de uma instalação estável do cabecao: rodando por npx (ou pelo código-fonte), o caminho do programa muda e o agendador ficaria apontando para nada',
      {
        code: 'schedule_unstable',
        hint: `Instale com "npm i -g cabecao@${channel()}" e rode "cabecao schedule on" de novo depois de instalar.`,
      },
    );
  }
  const command: ScheduledCommand = { program: ctx.execPath, args: [bin, 'sync', '--log'], env: scheduledEnv(ctx) };
  let result: Awaited<ReturnType<typeof scheduleOn>>;
  try {
    result = await scheduleOn(ctx, { command, intervalMin: interval, brain }, names);
  } catch (error) {
    if (error instanceof RangeError) throw new CliError(error.message, { code: 'schedule_command_too_long' });
    throw error;
  }
  const warnings = [...result.warnings];
  if (VERSION_MANAGER.test(ctx.execPath)) {
    warnings.push(
      `O agendamento usa este Node (${ctx.execPath}), de um gerenciador de versões: se essa versão for removida, rode "cabecao schedule on" de novo.`,
    );
  }
  const verb = { created: 'registrado', updated: 'atualizado', unchanged: 'já estava registrado assim' }[result.status];
  const lines = [
    `Sync periódico ${verb}: a cada ${interval} min, pelo ${MECHANISM_TEXT[result.mechanism]}.`,
    `Comando: ${displayCommand(command)}`,
    `Cérebro: ${brain}`,
    `Log: ${syncLogPath(brain)}`,
    ...result.files.map((file) => `Arquivo: ${file}`),
    ...warnings.map((warning) => `Aviso: ${warning}`),
    'Para desligar: cabecao schedule off',
  ];
  return {
    data: {
      ...result,
      warnings,
      command: [command.program, ...command.args],
      brain,
      log: syncLogPath(brain),
    },
    text: lines.join('\n'),
  };
}

async function off(ctx: CommandContext, names: ScheduleNames): Promise<CommandResult> {
  const result = await scheduleOff(ctx, names);
  const lines =
    result.status === 'removed'
      ? [
          `Sync periódico removido${result.mechanism === null ? '' : ` do ${MECHANISM_TEXT[result.mechanism]}`}.`,
          ...result.removed.map((item) => `Removido: ${item}`),
        ]
      : ['Nenhum sync periódico do Cabeção registrado nesta máquina; nada a remover.'];
  lines.push(...result.warnings.map((warning) => `Aviso: ${warning}`));
  return { data: result, text: lines.join('\n') };
}

async function status(ctx: CommandContext, names: ScheduleNames): Promise<CommandResult> {
  const result = await scheduleStatus(ctx, { probeWithoutState: true, names });
  if (!result.registered) {
    return { data: result, text: 'Sync periódico: desligado. Para ligar: cabecao schedule on [--interval <min>]' };
  }
  const lines = [
    `Sync periódico: ligado${result.interval_min === null ? '' : `, a cada ${result.interval_min} min`}${
      result.mechanism === null ? '' : `, pelo ${MECHANISM_TEXT[result.mechanism]}`
    }.`,
  ];
  if (result.program !== null) lines.push(`Comando: ${displayCommand({ program: result.program, args: result.args })}`);
  if (result.brain !== null) lines.push(`Cérebro: ${result.brain}`, `Log: ${syncLogPath(result.brain)}`);
  if (result.loaded === false)
    lines.push('Aviso: o agendador não está com a tarefa carregada; rode "cabecao schedule on".');
  if (result.detail !== null) lines.push(`No agendador: ${result.detail}`);
  for (const path of result.missing) {
    lines.push(
      `Aviso: ${path} não existe mais; rode "cabecao schedule on" de novo depois de "npm i -g cabecao@${channel()}".`,
    );
  }
  return { data: result, text: lines.join('\n') };
}

export async function runSchedule(ctx: CommandContext, names: ScheduleNames = DEFAULT_NAMES): Promise<CommandResult> {
  const [action, ...extra] = ctx.positionals;
  if (extra.length > 0) throw new UsageError(`argumento a mais: ${extra.join(' ')}`);
  if (action !== 'on' && ctx.values.interval !== undefined) throw new UsageError('--interval só vale com "on"');
  switch (action) {
    case 'on':
      return on(ctx, names);
    case 'off':
      return off(ctx, names);
    case 'status':
      return status(ctx, names);
    case undefined:
      throw new UsageError('diga o que fazer: on, off ou status');
    default:
      throw new UsageError(
        `ação desconhecida: ${action} (use on, off ou status).${didYouMean(action, ['on', 'off', 'status'], 'schedule ')}`,
      );
  }
}

export function run(ctx: CommandContext): Promise<CommandResult> {
  return runSchedule(ctx);
}
