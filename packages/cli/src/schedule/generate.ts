// Geradores PUROS do agendamento (spike 14, seção 7): o arquivo do LaunchAgent (macOS), as unidades do
// `systemd --user` (Linux), a linha do `crontab` (Linux sem systemd de usuário) e os argumentos do `schtasks`
// (Windows). Nada aqui toca em disco nem executa programa; `system.ts` usa estas funções.
//
// O comando agendado é sempre curto: `<node> <bin do cabecao> sync --log`. A pasta do cérebro vem da configuração da
// máquina (o cérebro padrão do `init`), não da linha de comando: o `/TR` do `schtasks` aceita no máximo 261 caracteres.

/** Marca do que o Cabeção gravou: só arquivo ou linha com ela é alterado ou removido. */
export const SCHEDULE_MARKER = 'Gerado pelo Cabeção (cabecao schedule)';
/** Fim de linha que identifica a linha do Cabeção no crontab. */
export const CRON_MARKER = '# cabecao-schedule';

export const LAUNCHD_LABEL = 'dev.cabecao.sync';
export const SYSTEMD_NAME = 'cabecao-sync';
export const SCHTASKS_NAME = 'Cabecao Sync';
/** Limite do `/TR` do `schtasks`, medido no spike 14 (um comando de 464 caracteres foi recusado). */
export const SCHTASKS_TR_MAX = 261;

export const DEFAULT_INTERVAL_MIN = 30;
export const MIN_INTERVAL_MIN = 5;
export const MAX_INTERVAL_MIN = 1440;

/** O que o agendador roda. */
export interface ScheduledCommand {
  /** Caminho absoluto do Node. */
  readonly program: string;
  /** `[<bin do cabecao>, 'sync', '--log']`. */
  readonly args: readonly string[];
  /** Variáveis de ambiente do processo agendado (o `PATH` do registro, para achar o git). */
  readonly env: Readonly<Record<string, string>>;
}

/** Intervalo em minutos a partir da opção `--interval`. Lança `RangeError` com a mensagem em português. */
export function parseInterval(value: unknown): number {
  if (value === undefined) return DEFAULT_INTERVAL_MIN;
  const text = typeof value === 'string' ? value.trim() : '';
  const minutes = Number(text);
  if (!/^\d+$/.test(text) || minutes < MIN_INTERVAL_MIN || minutes > MAX_INTERVAL_MIN) {
    throw new RangeError(`--interval deveria ser um número de minutos entre ${MIN_INTERVAL_MIN} e ${MAX_INTERVAL_MIN}`);
  }
  return minutes;
}

/** O comando como aparece para o usuário (cada argumento entre aspas quando precisa). */
export function displayCommand(command: Pick<ScheduledCommand, 'program' | 'args'>): string {
  return [command.program, ...command.args].map((arg) => (/[\s"'$\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// macOS: LaunchAgent

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `~/Library/LaunchAgents/<label>.plist`. `stderrPath`: onde o launchd grava o stderr (um erro antes do log). */
export function launchdPlist(
  command: ScheduledCommand,
  intervalMin: number,
  options: { label: string; stderrPath: string },
): string {
  const args = [command.program, ...command.args].map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  const env = Object.entries(command.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${SCHEDULE_MARKER}. Remova com "cabecao schedule off". -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${intervalMin * 60}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.stderrPath)}</string>${env === '' ? '' : `\n  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>`}
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Linux: systemd --user

/**
 * Uma palavra de `ExecStart=` sempre entre aspas: `\` e `"` com escape, `%` (especificador) dobrado e `$` (variável)
 * dobrado. Assim um caminho com espaço, `%` ou `$` chega literal ao programa.
 */
export function systemdExecWord(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** Uma atribuição de `Environment=` entre aspas (sem expansão de `$` ali; `%` ainda é especificador). */
export function systemdEnvAssignment(key: string, value: string): string {
  return `"${`${key}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** `cabecao-sync.service` e `cabecao-sync.timer`, em `~/.config/systemd/user/`. */
export function systemdUnits(command: ScheduledCommand, intervalMin: number, name: string): Record<string, string> {
  const header = `# ${SCHEDULE_MARKER}. Remova com "cabecao schedule off".`;
  const env = Object.entries(command.env).map(([key, value]) => `Environment=${systemdEnvAssignment(key, value)}\n`);
  return {
    [`${name}.service`]: `${header}
[Unit]
Description=Cabeção: sync do segundo cérebro

[Service]
Type=oneshot
ExecStart=${[command.program, ...command.args].map(systemdExecWord).join(' ')}
${env.join('')}Nice=10
`,
    [`${name}.timer`]: `${header}
[Unit]
Description=Cabeção: sync a cada ${intervalMin} min

[Timer]
OnActiveSec=2min
OnUnitActiveSec=${intervalMin}min
RandomizedDelaySec=30
Unit=${name}.service

[Install]
WantedBy=timers.target
`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Linux sem systemd de usuário: crontab

/** Aspas simples do `sh`: nada dentro delas é interpretado, e `'` vira `'\''`. */
export function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Expressão do cron e o intervalo que ela de fato dá (o cron só divide a hora e o dia). */
export function cronSchedule(intervalMin: number): { expression: string; effectiveMin: number } {
  if (intervalMin < 60) return { expression: `*/${intervalMin} * * * *`, effectiveMin: intervalMin };
  const hours = Math.min(24, Math.max(1, Math.round(intervalMin / 60)));
  if (hours >= 24) return { expression: '17 3 * * *', effectiveMin: 1440 };
  return { expression: `7 */${hours} * * *`, effectiveMin: hours * 60 };
}

/**
 * A linha do Cabeção no crontab: o `sh` do cron roda o comando com as variáveis na frente (só para ele), descarta a
 * saída (o sync grava o próprio log) e manda o stderr para `stderrPath`. No crontab, `%` vira quebra de linha: vai com
 * barra antes.
 */
export function cronLine(command: ScheduledCommand, intervalMin: number, stderrPath: string): string {
  const { expression } = cronSchedule(intervalMin);
  const env = Object.entries(command.env).map(([key, value]) => `${key}=${shQuote(value)} `);
  const words = [command.program, ...command.args].map(shQuote).join(' ');
  const line = `${expression} ${env.join('')}${words} >/dev/null 2>>${shQuote(stderrPath)} ${CRON_MARKER}`;
  return line.replace(/%/g, '\\%');
}

/** A linha (ou linhas) do Cabeção num crontab. */
export function isCabecaoCronLine(line: string): boolean {
  return line.trimEnd().endsWith(CRON_MARKER);
}

/**
 * Crontab novo: o atual sem as linhas do Cabeção e, se `line` vier, com ela no fim. As linhas de outros programas
 * ficam como estavam, na mesma ordem.
 */
export function mergeCrontab(current: string, line: string | null): string {
  const kept = current
    .split(/\r?\n/)
    .filter((entry) => !isCabecaoCronLine(entry))
    .join('\n')
    .replace(/\n+$/, '');
  const parts = [kept, line ?? ''].filter((part) => part !== '');
  return parts.length === 0 ? '' : `${parts.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Windows: Agendador de Tarefas

/** O `/TR` do `schtasks`: o programa e o bin sempre entre aspas (caminhos com espaço), o resto como está. */
export function schtasksTaskRun(command: Pick<ScheduledCommand, 'program' | 'args'>): string {
  return [command.program, ...command.args]
    .map((arg, index) => (index < 2 || /[\s"]/.test(arg) || arg === '' ? `"${arg}"` : arg))
    .join(' ');
}

/** Frequência no `schtasks`: a cada N minutos (até 1439) ou uma vez por dia. */
export function schtasksSchedule(intervalMin: number): string[] {
  return intervalMin >= 1440 ? ['/SC', 'DAILY'] : ['/SC', 'MINUTE', '/MO', String(intervalMin)];
}

/**
 * Argumentos de `schtasks /Create`, para rodar SEM shell (lista de argumentos). Tarefa do usuário atual, sem `/RU`:
 * roda só com o usuário logado e dispensa senha e administrador. Lança `RangeError` quando o `/TR` passa de 261
 * caracteres (caminhos do Node ou do cabecao compridos demais).
 */
export function schtasksCreateArgs(
  command: Pick<ScheduledCommand, 'program' | 'args'>,
  intervalMin: number,
  name: string,
): string[] {
  const taskRun = schtasksTaskRun(command);
  if (taskRun.length > SCHTASKS_TR_MAX) {
    throw new RangeError(
      `o comando agendado tem ${taskRun.length} caracteres e o Agendador de Tarefas aceita no máximo ${SCHTASKS_TR_MAX}`,
    );
  }
  return ['/Create', '/F', '/TN', name, ...schtasksSchedule(intervalMin), '/TR', taskRun];
}
