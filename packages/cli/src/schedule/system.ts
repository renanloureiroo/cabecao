// Registro, consulta e remoção do sync periódico no agendador do sistema, por usuário e sem administrador. Todo
// programa externo roda pelo executor injetado (`io.exec`, sem shell, com lista de argumentos) e toda pasta vem do
// ambiente injetado (`HOME`, `XDG_CONFIG_HOME`, `CABECAO_CONFIG_DIR`): nos testes, nada chega ao agendador de verdade.
//
// O que o Cabeção registrou fica anotado em `<configuração da máquina>/schedule.json`. O `doctor` só executa algo
// (`launchctl`, `systemctl`, `crontab`, `schtasks`) quando essa anotação existe.
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@cabecao/core';
import { logDir } from '../background.ts';
import { homeDir, machineConfigDir } from '../brain.ts';
import { CliError } from '../errors.ts';
import type { CliIo, ExecResult } from '../types.ts';
import type { ScheduledCommand } from './generate.ts';
import {
  CRON_MARKER,
  cronLine,
  cronSchedule,
  isCabecaoCronLine,
  LAUNCHD_LABEL,
  launchdPlist,
  mergeCrontab,
  SCHEDULE_MARKER,
  SCHTASKS_NAME,
  SYSTEMD_NAME,
  schtasksCreateArgs,
  systemdUnits,
} from './generate.ts';

export type ScheduleIo = Pick<CliIo, 'env' | 'platform' | 'homedir' | 'exec'>;
export type Mechanism = 'launchd' | 'systemd' | 'cron' | 'schtasks';

/** Nomes no agendador. Trocados só pelo teste opcional que registra de verdade. */
export interface ScheduleNames {
  launchd: string;
  systemd: string;
  schtasks: string;
}

export const DEFAULT_NAMES: ScheduleNames = { launchd: LAUNCHD_LABEL, systemd: SYSTEMD_NAME, schtasks: SCHTASKS_NAME };

/** O que fica em `schedule.json`. */
export interface ScheduleState {
  mechanism: Mechanism;
  interval_min: number;
  program: string;
  args: string[];
  brain: string;
  files: string[];
  registered_at: string;
}

export interface ScheduleOnResult {
  status: 'created' | 'updated' | 'unchanged';
  mechanism: Mechanism;
  interval_min: number;
  files: string[];
  warnings: string[];
}

export interface ScheduleOffResult {
  status: 'removed' | 'absent';
  mechanism: Mechanism | null;
  removed: string[];
  warnings: string[];
}

export interface ScheduleStatus {
  registered: boolean;
  mechanism: Mechanism | null;
  interval_min: number | null;
  program: string | null;
  args: string[];
  brain: string | null;
  /** O agendador está com a tarefa carregada; `null` quando não foi consultado. */
  loaded: boolean | null;
  /** O que o agendador conta da tarefa (último código de saída, próxima execução), quando dá para ler. */
  detail: string | null;
  /** Caminhos do comando agendado que não existem mais (o Node ou o bin foram removidos). */
  missing: string[];
  files: string[];
}

const EXEC_TIMEOUT_MS = 15_000;

function stateFile(io: ScheduleIo): string {
  return join(machineConfigDir(io), 'schedule.json');
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readScheduleState(io: ScheduleIo): Promise<ScheduleState | null> {
  const text = await readOptional(stateFile(io));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<ScheduleState>;
    if (
      typeof value.mechanism === 'string' &&
      ['launchd', 'systemd', 'cron', 'schtasks'].includes(value.mechanism) &&
      typeof value.interval_min === 'number' &&
      typeof value.program === 'string' &&
      Array.isArray(value.args)
    ) {
      return {
        mechanism: value.mechanism,
        interval_min: value.interval_min,
        program: value.program,
        args: value.args.filter((arg): arg is string => typeof arg === 'string'),
        brain: typeof value.brain === 'string' ? value.brain : '',
        files: Array.isArray(value.files) ? value.files.filter((f): f is string => typeof f === 'string') : [],
        registered_at: typeof value.registered_at === 'string' ? value.registered_at : '',
      };
    }
  } catch {
    // anotação ilegível: tratada como ausente
  }
  return null;
}

async function writeState(io: ScheduleIo, state: ScheduleState): Promise<void> {
  await writeFileAtomic(stateFile(io), `${JSON.stringify(state, null, 2)}\n`);
}

function failure(action: string, result: ExecResult): CliError {
  const detail = (result.stderr.trim() || result.stdout.trim() || `código ${result.code ?? 'nenhum'}`)
    .split('\n')
    .slice(-3)
    .join(' ');
  return new CliError(`${action} falhou: ${detail}`, {
    code: 'schedule_failed',
    hint: 'Nada do Cabeção ficou pela metade que um "cabecao schedule off" não remova.',
  });
}

function foreign(path: string): CliError {
  return new CliError(`${path} já existe e não foi criado pelo Cabeção; nada foi alterado`, {
    code: 'schedule_foreign',
    hint: 'Confira o arquivo: se for de uma versão antiga do Cabeção, apague-o e rode "cabecao schedule on" de novo.',
  });
}

function xdgConfig(io: ScheduleIo): string {
  const value = io.env.XDG_CONFIG_HOME;
  return value !== undefined && value !== '' ? value : join(homeDir(io), '.config');
}

/** `/caminho/do/cérebro/.cabecao/logs/schedule-stderr.log`: o stderr do processo agendado (erro antes do log). */
export function scheduleStderrPath(brain: string): string {
  return join(logDir(brain), 'schedule-stderr.log');
}

// ---------------------------------------------------------------------------------------------------------------
// macOS

function plistPath(io: ScheduleIo, names: ScheduleNames): string {
  return join(homeDir(io), 'Library', 'LaunchAgents', `${names.launchd}.plist`);
}

async function launchdDomain(io: ScheduleIo): Promise<string> {
  const result = await io.exec('id', ['-u'], { timeoutMs: EXEC_TIMEOUT_MS });
  const uid = result.stdout.trim();
  if (result.code !== 0 || !/^\d+$/.test(uid)) throw failure('id -u', result);
  return `gui/${uid}`;
}

async function launchdOn(io: ScheduleIo, input: OnInput, names: ScheduleNames): Promise<OnOutcome> {
  const path = plistPath(io, names);
  const content = launchdPlist(input.command, input.intervalMin, {
    label: names.launchd,
    stderrPath: scheduleStderrPath(input.brain),
  });
  const current = await readOptional(path);
  if (current !== null && !current.includes(SCHEDULE_MARKER)) throw foreign(path);
  const domain = await launchdDomain(io);
  const service = `${domain}/${names.launchd}`;
  const loaded = (await io.exec('launchctl', ['print', service], { timeoutMs: EXEC_TIMEOUT_MS })).code === 0;
  if (current === content && loaded) return { changed: false, files: [path], warnings: [] };
  await writeFileAtomic(path, content);
  // um agente carregado não relê o arquivo: sai e entra de novo com a versão nova
  if (loaded) await io.exec('launchctl', ['bootout', service], { timeoutMs: EXEC_TIMEOUT_MS });
  const boot = await io.exec('launchctl', ['bootstrap', domain, path], { timeoutMs: EXEC_TIMEOUT_MS });
  if (boot.code !== 0) throw failure('launchctl bootstrap', boot);
  return { changed: true, files: [path], warnings: [] };
}

async function launchdOff(io: ScheduleIo, names: ScheduleNames): Promise<OffOutcome> {
  const path = plistPath(io, names);
  const current = await readOptional(path);
  if (current !== null && !current.includes(SCHEDULE_MARKER)) {
    return { removed: [], warnings: [`${path} não foi criado pelo Cabeção e ficou como estava`] };
  }
  const domain = await launchdDomain(io);
  const out = await io.exec('launchctl', ['bootout', `${domain}/${names.launchd}`], { timeoutMs: EXEC_TIMEOUT_MS });
  const removed: string[] = [];
  if (current !== null) {
    await rm(path, { force: true });
    removed.push(path);
  }
  return { removed, warnings: [], wasLoaded: out.code === 0 };
}

async function launchdProbe(io: ScheduleIo, names: ScheduleNames): Promise<Probe> {
  const domain = await launchdDomain(io);
  const result = await io.exec('launchctl', ['print', `${domain}/${names.launchd}`], { timeoutMs: EXEC_TIMEOUT_MS });
  if (result.code !== 0) return { loaded: false, detail: null };
  const lastExit = /last exit code = ([^\n]+)/.exec(result.stdout)?.[1]?.trim();
  const state = /\bstate = (\w+)/.exec(result.stdout)?.[1];
  const parts = [
    state === undefined ? null : `estado ${state}`,
    lastExit === undefined ? null : `último código ${lastExit}`,
  ];
  return { loaded: true, detail: parts.filter((part) => part !== null).join(', ') || null };
}

// ---------------------------------------------------------------------------------------------------------------
// Linux

function unitDir(io: ScheduleIo): string {
  return join(xdgConfig(io), 'systemd', 'user');
}

async function hasSystemdUser(io: ScheduleIo): Promise<boolean> {
  return (await io.exec('systemctl', ['--user', 'show-environment'], { timeoutMs: EXEC_TIMEOUT_MS })).code === 0;
}

async function systemctl(io: ScheduleIo, args: string[]): Promise<ExecResult> {
  return io.exec('systemctl', ['--user', ...args], { timeoutMs: EXEC_TIMEOUT_MS });
}

async function lingerWarning(io: ScheduleIo): Promise<string[]> {
  const user = io.env.USER ?? io.env.LOGNAME;
  if (user === undefined || user === '') return [];
  const result = await io.exec('loginctl', ['show-user', user, '--property=Linger', '--value'], {
    timeoutMs: EXEC_TIMEOUT_MS,
  });
  if (result.code === 0 && result.stdout.trim() === 'no') {
    return [
      'Sem "linger", o timer só roda enquanto você tem uma sessão aberta. Para rodar mesmo sem login: loginctl enable-linger (pode pedir senha).',
    ];
  }
  return [];
}

async function systemdOn(io: ScheduleIo, input: OnInput, names: ScheduleNames): Promise<OnOutcome> {
  const dir = unitDir(io);
  const units = systemdUnits(input.command, input.intervalMin, names.systemd);
  let changed = false;
  for (const [file, content] of Object.entries(units)) {
    const current = await readOptional(join(dir, file));
    if (current !== null && !current.includes(SCHEDULE_MARKER)) throw foreign(join(dir, file));
    if (current !== content) changed = true;
  }
  const timer = `${names.systemd}.timer`;
  const active = (await systemctl(io, ['is-active', timer])).stdout.trim() === 'active';
  const files = Object.keys(units).map((file) => join(dir, file));
  const warnings = await lingerWarning(io);
  if (!changed && active) return { changed: false, files, warnings };
  for (const [file, content] of Object.entries(units)) await writeFileAtomic(join(dir, file), content);
  for (const args of [['daemon-reload'], ['enable', timer], ['restart', timer]]) {
    const result = await systemctl(io, args);
    if (result.code !== 0) throw failure(`systemctl --user ${args.join(' ')}`, result);
  }
  return { changed: true, files, warnings };
}

async function systemdOff(io: ScheduleIo, names: ScheduleNames): Promise<OffOutcome> {
  const dir = unitDir(io);
  const removed: string[] = [];
  const warnings: string[] = [];
  const timer = `${names.systemd}.timer`;
  await systemctl(io, ['disable', '--now', timer]);
  for (const file of [timer, `${names.systemd}.service`]) {
    const path = join(dir, file);
    const current = await readOptional(path);
    if (current === null) continue;
    if (!current.includes(SCHEDULE_MARKER)) {
      warnings.push(`${path} não foi criado pelo Cabeção e ficou como estava`);
      continue;
    }
    await rm(path, { force: true });
    removed.push(path);
  }
  if (removed.length > 0) await systemctl(io, ['daemon-reload']);
  return { removed, warnings };
}

async function systemdProbe(io: ScheduleIo, names: ScheduleNames): Promise<Probe> {
  const timer = `${names.systemd}.timer`;
  const active = (await systemctl(io, ['is-active', timer])).stdout.trim();
  if (active !== 'active') return { loaded: false, detail: active === '' ? null : `timer ${active}` };
  const show = await systemctl(io, ['show', `${names.systemd}.service`, '--property=Result', '--value']);
  const result = show.code === 0 ? show.stdout.trim() : '';
  return { loaded: true, detail: result === '' ? 'timer ativo' : `timer ativo, último resultado: ${result}` };
}

async function readCrontab(io: ScheduleIo): Promise<string> {
  const result = await io.exec('crontab', ['-l'], { timeoutMs: EXEC_TIMEOUT_MS });
  if (result.code === 0) return result.stdout;
  if (/no crontab/i.test(result.stderr)) return '';
  throw failure('crontab -l', result);
}

async function writeCrontab(io: ScheduleIo, content: string): Promise<void> {
  // `crontab <arquivo>` troca o crontab inteiro pelo arquivo, sem shell: o conteúdo é o atual menos as linhas do Cabeção
  const temp = join(machineConfigDir(io), `crontab-${Date.now()}.tmp`);
  await writeFileAtomic(temp, content);
  try {
    const result = await io.exec('crontab', [temp], { timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw failure('crontab', result);
  } finally {
    await rm(temp, { force: true });
  }
}

async function cronOn(io: ScheduleIo, input: OnInput): Promise<OnOutcome> {
  const current = await readCrontab(io);
  const line = cronLine(input.command, input.intervalMin, scheduleStderrPath(input.brain));
  const warnings: string[] = [];
  const { effectiveMin } = cronSchedule(input.intervalMin);
  if (effectiveMin !== input.intervalMin) {
    warnings.push(`O cron só repete em divisões da hora ou do dia: o intervalo efetivo é de ${effectiveMin} min.`);
  }
  const ours = current.split(/\r?\n/).filter(isCabecaoCronLine);
  if (ours.length === 1 && ours[0] === line) return { changed: false, files: [], warnings };
  await writeCrontab(io, mergeCrontab(current, line));
  return { changed: true, files: [], warnings };
}

async function cronOff(io: ScheduleIo): Promise<OffOutcome> {
  let current: string;
  try {
    current = await readCrontab(io);
  } catch {
    return { removed: [], warnings: [] };
  }
  if (!current.split(/\r?\n/).some(isCabecaoCronLine)) return { removed: [], warnings: [] };
  await writeCrontab(io, mergeCrontab(current, null));
  return { removed: [`crontab (${CRON_MARKER})`], warnings: [] };
}

async function cronProbe(io: ScheduleIo): Promise<Probe> {
  try {
    const present = (await readCrontab(io)).split(/\r?\n/).some(isCabecaoCronLine);
    return { loaded: present, detail: present ? 'linha no crontab' : null };
  } catch {
    return { loaded: null, detail: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Windows

interface TaskInfo {
  exists: boolean;
  xml: string;
}

async function queryTask(io: ScheduleIo, names: ScheduleNames): Promise<TaskInfo> {
  const result = await io.exec('schtasks', ['/Query', '/TN', names.schtasks, '/XML'], { timeoutMs: EXEC_TIMEOUT_MS });
  return { exists: result.code === 0 && result.stdout.includes('<Task'), xml: result.stdout };
}

function isOurTask(xml: string): boolean {
  return /<Arguments>[^<]*\bsync --log\b/.test(xml) && /cabecao/i.test(xml);
}

function xmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function schtasksOn(io: ScheduleIo, input: OnInput, names: ScheduleNames): Promise<OnOutcome> {
  const args = schtasksCreateArgs(input.command, input.intervalMin, names.schtasks);
  const task = await queryTask(io, names);
  if (task.exists && !isOurTask(task.xml)) {
    throw new CliError(`a tarefa "${names.schtasks}" já existe e não foi criada pelo Cabeção; nada foi alterado`, {
      code: 'schedule_foreign',
      hint: `Confira em Agendador de Tarefas; se puder apagá-la: schtasks /Delete /TN "${names.schtasks}".`,
    });
  }
  const warnings = [
    'No Windows a tarefa roda só com você logado ("Interactive only"), e uma janela de console pode piscar a cada execução.',
  ];
  if (io.env.CABECAO_CONFIG_DIR !== undefined && io.env.CABECAO_CONFIG_DIR !== '') {
    warnings.push(
      'CABECAO_CONFIG_DIR está definida só neste terminal: a tarefa agendada não a enxerga, a não ser que ela seja uma variável de ambiente do usuário.',
    );
  }
  const interval = input.intervalMin >= 1440 ? '<ScheduleByDay>' : `<Interval>PT${input.intervalMin}M</Interval>`;
  const command = `<Command>${xmlText(input.command.program)}</Command>`;
  const bin = input.command.args[0] ?? '';
  if (task.exists && task.xml.includes(command) && task.xml.includes(xmlText(bin)) && task.xml.includes(interval)) {
    return { changed: false, files: [], warnings };
  }
  const result = await io.exec('schtasks', args, { timeoutMs: EXEC_TIMEOUT_MS });
  if (result.code !== 0) throw failure('schtasks /Create', result);
  return { changed: true, files: [], warnings };
}

async function schtasksOff(io: ScheduleIo, names: ScheduleNames): Promise<OffOutcome> {
  const task = await queryTask(io, names);
  if (!task.exists) return { removed: [], warnings: [] };
  if (!isOurTask(task.xml)) {
    return { removed: [], warnings: [`a tarefa "${names.schtasks}" não foi criada pelo Cabeção e ficou como estava`] };
  }
  const result = await io.exec('schtasks', ['/Delete', '/F', '/TN', names.schtasks], { timeoutMs: EXEC_TIMEOUT_MS });
  if (result.code !== 0) throw failure('schtasks /Delete', result);
  return { removed: [`tarefa "${names.schtasks}"`], warnings: [] };
}

async function schtasksProbe(io: ScheduleIo, names: ScheduleNames): Promise<Probe> {
  const task = await queryTask(io, names);
  return { loaded: task.exists, detail: task.exists ? 'tarefa registrada' : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Entrada comum

interface OnInput {
  command: ScheduledCommand;
  intervalMin: number;
  brain: string;
}

interface OnOutcome {
  changed: boolean;
  files: string[];
  warnings: string[];
}

interface OffOutcome {
  removed: string[];
  warnings: string[];
  wasLoaded?: boolean;
}

interface Probe {
  loaded: boolean | null;
  detail: string | null;
}

/** Mecanismo desta máquina. No Linux, o systemd de usuário quando responde; senão, o crontab. */
async function pickMechanism(io: ScheduleIo): Promise<Mechanism> {
  switch (io.platform) {
    case 'darwin':
      return 'launchd';
    case 'win32':
      return 'schtasks';
    default: {
      if (await hasSystemdUser(io)) return 'systemd';
      const list = await io.exec('crontab', ['-l'], { timeoutMs: EXEC_TIMEOUT_MS });
      if (list.code === 0 || /no crontab/i.test(list.stderr)) return 'cron';
      throw new CliError(
        'não achei um agendador de usuário nesta máquina: nem o systemd --user nem o crontab respondem',
        {
          code: 'schedule_unavailable',
          hint: 'Instale o cron (pacote "cron" ou "cronie") ou rode "cabecao sync" à mão de vez em quando.',
        },
      );
    }
  }
}

/** Registra (ou atualiza) o sync periódico. Idempotente: com tudo igual e carregado, não executa nada que mude estado. */
export async function scheduleOn(
  io: ScheduleIo,
  input: OnInput,
  names: ScheduleNames = DEFAULT_NAMES,
): Promise<ScheduleOnResult> {
  const previous = await readScheduleState(io);
  const mechanism = await pickMechanism(io);
  // trocar de mecanismo (o systemd de usuário apareceu ou sumiu) não deixa o antigo rodando junto
  if (previous !== null && previous.mechanism !== mechanism) await removeWith(io, previous.mechanism, names);
  const outcome =
    mechanism === 'launchd'
      ? await launchdOn(io, input, names)
      : mechanism === 'systemd'
        ? await systemdOn(io, input, names)
        : mechanism === 'cron'
          ? await cronOn(io, input)
          : await schtasksOn(io, input, names);
  const state: ScheduleState = {
    mechanism,
    interval_min: input.intervalMin,
    program: input.command.program,
    args: [...input.command.args],
    brain: input.brain,
    files: outcome.files,
    registered_at:
      !outcome.changed && previous !== null && previous.registered_at !== ''
        ? previous.registered_at
        : new Date().toISOString(),
  };
  const sameState = previous !== null && JSON.stringify(previous) === JSON.stringify(state);
  if (!sameState) await writeState(io, state);
  return {
    status: outcome.changed || previous === null ? (previous === null ? 'created' : 'updated') : 'unchanged',
    mechanism,
    interval_min: input.intervalMin,
    files: outcome.files,
    warnings: outcome.warnings,
  };
}

async function removeWith(io: ScheduleIo, mechanism: Mechanism, names: ScheduleNames): Promise<OffOutcome> {
  switch (mechanism) {
    case 'launchd':
      return launchdOff(io, names);
    case 'systemd':
      return systemdOff(io, names);
    case 'cron':
      return cronOff(io);
    case 'schtasks':
      return schtasksOff(io, names);
  }
}

/** Remove o sync periódico: só o que o Cabeção criou. Sem nada registrado, não faz nada. */
export async function scheduleOff(io: ScheduleIo, names: ScheduleNames = DEFAULT_NAMES): Promise<ScheduleOffResult> {
  const state = await readScheduleState(io);
  const mechanism =
    state?.mechanism ?? (io.platform === 'darwin' ? 'launchd' : io.platform === 'win32' ? 'schtasks' : null);
  const removed: string[] = [];
  const warnings: string[] = [];
  let loaded = false;
  // no Linux sem anotação, procura nos dois (unidades do systemd e linha do crontab)
  const mechanisms: Mechanism[] = mechanism === null ? ['systemd', 'cron'] : [mechanism];
  for (const each of mechanisms) {
    if (each === 'systemd' && mechanism === null && !(await exists(unitDir(io)))) continue;
    const outcome = await removeWith(io, each, names);
    removed.push(...outcome.removed);
    warnings.push(...outcome.warnings);
    if (outcome.wasLoaded === true) loaded = true;
  }
  await rm(stateFile(io), { force: true });
  return {
    status: removed.length > 0 || loaded ? 'removed' : 'absent',
    mechanism: removed.length > 0 || loaded ? (mechanism ?? mechanisms[0] ?? null) : null,
    removed,
    warnings,
  };
}

async function probeWith(io: ScheduleIo, mechanism: Mechanism, names: ScheduleNames): Promise<Probe> {
  try {
    switch (mechanism) {
      case 'launchd':
        return await launchdProbe(io, names);
      case 'systemd':
        return await systemdProbe(io, names);
      case 'cron':
        return await cronProbe(io);
      case 'schtasks':
        return await schtasksProbe(io, names);
    }
  } catch {
    return { loaded: null, detail: null };
  }
}

/**
 * O que está registrado, pela anotação do Cabeção. Com a anotação, confere no agendador (executa `launchctl print`,
 * `systemctl --user is-active`, `crontab -l` ou `schtasks /Query`) e se o Node e o bin ainda existem. Sem ela, só
 * executa algo com `probeWithoutState` (o `schedule status` usa; o `doctor`, não).
 */
export async function scheduleStatus(
  io: ScheduleIo,
  options: { probeWithoutState: boolean; names?: ScheduleNames },
): Promise<ScheduleStatus> {
  const names = options.names ?? DEFAULT_NAMES;
  const state = await readScheduleState(io);
  if (state === null) {
    const empty: ScheduleStatus = {
      registered: false,
      mechanism: null,
      interval_min: null,
      program: null,
      args: [],
      brain: null,
      loaded: null,
      detail: null,
      missing: [],
      files: [],
    };
    if (!options.probeWithoutState) return empty;
    // registro sem anotação (anotação apagada à mão): procura o que o Cabeção teria criado
    const candidates: Mechanism[] =
      io.platform === 'darwin' ? ['launchd'] : io.platform === 'win32' ? ['schtasks'] : ['systemd', 'cron'];
    for (const mechanism of candidates) {
      if (mechanism === 'launchd' && (await readOptional(plistPath(io, names))) === null) continue;
      if (mechanism === 'systemd' && (await readOptional(join(unitDir(io), `${names.systemd}.timer`))) === null)
        continue;
      const probe = await probeWith(io, mechanism, names);
      if (probe.loaded === true) return { ...empty, registered: true, mechanism, loaded: true, detail: probe.detail };
    }
    return empty;
  }
  const probe = await probeWith(io, state.mechanism, names);
  const missing: string[] = [];
  for (const path of [state.program, state.args[0]]) {
    if (path !== undefined && !(await exists(path))) missing.push(path);
  }
  return {
    registered: true,
    mechanism: state.mechanism,
    interval_min: state.interval_min,
    program: state.program,
    args: state.args,
    brain: state.brain === '' ? null : state.brain,
    loaded: probe.loaded,
    detail: probe.detail,
    missing,
    files: state.files,
  };
}
