// `cabecao schedule on|off|status` e os geradores do agendamento. NENHUM teste registra nada no agendador de verdade:
// o executor de comandos é um falso que imita `launchctl`, `systemctl`, `crontab` e `schtasks`, e a pasta do usuário,
// o XDG_CONFIG_HOME, o APPDATA e a configuração do Cabeção são temporários. O único teste que registra de verdade só
// roda com CABECAO_TEST_REAL_SCHEDULER=1 (e usa nomes próprios de teste).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeMachineConfig } from '@cabecao/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runSchedule } from '../src/commands/schedule.ts';
import { systemExec } from '../src/exec.ts';
import {
  CRON_MARKER,
  cronLine,
  cronSchedule,
  launchdPlist,
  mergeCrontab,
  parseInterval,
  SCHEDULE_MARKER,
  SCHTASKS_TR_MAX,
  schtasksCreateArgs,
  shQuote,
  systemdExecWord,
  systemdUnits,
} from '../src/schedule/generate.ts';
import type { CommandContext, Exec, ExecResult } from '../src/types.ts';
import { brainRepo, disposeSandbox, freshDir, machine, parseJson, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(() => {
  disposeSandbox();
});

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (code: number, stderr: string): ExecResult => ({ code, stdout: '', stderr });

/** Agendador de mentira: guarda o estado e responde como os programas de verdade. */
function fakeScheduler(options: { systemd?: boolean; crontab?: string | null; task?: string | null } = {}) {
  const state = {
    loaded: false,
    systemd: options.systemd ?? true,
    crontab: options.crontab === undefined ? null : options.crontab,
    task: options.task ?? null,
  };
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args].join(' '));
    const [first, second] = args;
    switch (file) {
      case 'id':
        return ok('501\n');
      case 'launchctl':
        if (first === 'print')
          return state.loaded ? ok('\tstate = waiting\n\tlast exit code = 0\n') : fail(113, 'Could not find service');
        if (first === 'bootstrap') {
          state.loaded = true;
          return ok();
        }
        if (first === 'bootout') {
          const was = state.loaded;
          state.loaded = false;
          return was ? ok() : fail(3, 'No such process');
        }
        return fail(1, 'comando inesperado');
      case 'systemctl':
        if (second === 'show-environment')
          return state.systemd ? ok('PATH=/usr/bin\n') : fail(1, 'Failed to connect to bus');
        if (second === 'is-active')
          return state.loaded ? ok('active\n') : { code: 3, stdout: 'inactive\n', stderr: '' };
        if (second === 'restart') state.loaded = true;
        if (second === 'disable') state.loaded = false;
        if (second === 'show') return ok('success\n');
        return ok();
      case 'loginctl':
        return ok('no\n');
      case 'crontab':
        if (first === '-l') return state.crontab === null ? fail(1, 'no crontab for ana') : ok(state.crontab);
        state.crontab = readFileSync(first ?? '', 'utf8');
        return ok();
      case 'schtasks': {
        if (first === '/Query') return state.task === null ? fail(1, 'ERRO: arquivo não encontrado.') : ok(state.task);
        if (first === '/Delete') {
          state.task = null;
          return ok('ÊXITO');
        }
        if (first === '/Create') {
          const tr = args[args.indexOf('/TR') + 1] ?? '';
          const mo = args.includes('/MO') ? args[args.indexOf('/MO') + 1] : null;
          const program = /^"([^"]+)"/.exec(tr)?.[1] ?? '';
          const rest = tr.slice(program.length + 3);
          state.task = `<?xml version="1.0" encoding="UTF-16"?>\n<Task><Triggers><TimeTrigger><Repetition>${
            mo === null ? '' : `<Interval>PT${mo}M</Interval>`
          }</Repetition></TimeTrigger>${mo === null ? '<ScheduleByDay>' : ''}</Triggers><Actions><Exec><Command>${program}</Command><Arguments>${rest}</Arguments></Exec></Actions></Task>`;
          return ok('ÊXITO');
        }
        return fail(1, 'comando inesperado');
      }
      default:
        return fail(-2, `spawn ${file} ENOENT`);
    }
  };
  return { state, calls, exec };
}

interface Setup {
  m: ReturnType<typeof machine>;
  brain: string;
  bin: string;
}

/** Máquina com cérebro padrão configurado e um cabecao "instalado globalmente" (arquivo estável). */
async function setup(): Promise<Setup> {
  const m = machine();
  const brain = await brainRepo();
  await writeMachineConfig({ machine: 'maquina-teste', defaultBrain: brain }, m.configDir);
  const dir = join(m.home, '.npm-global', 'lib', 'node_modules', 'cabecao', 'dist');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'cabecao.mjs');
  writeFileSync(bin, '// bin\n');
  return { m, brain, bin };
}

describe('geradores', () => {
  const command = {
    program: '/opt/node & cia/bin/node',
    args: ['/home/ana/<lib>/cabecao.mjs', 'sync', '--log'],
    env: { PATH: '/usr/bin:/bin' },
  };

  it('intervalo: padrão 30, de 5 a 1440', () => {
    expect(parseInterval(undefined)).toBe(30);
    expect(parseInterval('5')).toBe(5);
    expect(parseInterval('1440')).toBe(1440);
    for (const bad of ['4', '1441', 'x', '1.5', '']) expect(() => parseInterval(bad)).toThrow(RangeError);
  });

  it('LaunchAgent: XML escapado, intervalo em segundos, marca do Cabeção e o PATH', () => {
    const plist = launchdPlist(command, 30, { label: 'dev.cabecao.sync', stderrPath: '/c/.cabecao/logs/e.log' });
    expect(plist).toContain(SCHEDULE_MARKER);
    expect(plist).toContain('<string>/opt/node &amp; cia/bin/node</string>');
    expect(plist).toContain('<string>/home/ana/&lt;lib&gt;/cabecao.mjs</string>');
    expect(plist).toContain('<integer>1800</integer>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/usr/bin:/bin</string>');
    expect(plist).not.toContain('--brain');
  });

  it('systemd: cada palavra entre aspas, com %, $ e aspas escapados', () => {
    expect(systemdExecWord('/a b/%h$x"\\')).toBe('"/a b/%%h$$x\\"\\\\"');
    const units = systemdUnits(command, 45, 'cabecao-sync');
    expect(units['cabecao-sync.service']).toContain(
      'ExecStart="/opt/node & cia/bin/node" "/home/ana/<lib>/cabecao.mjs" "sync" "--log"',
    );
    expect(units['cabecao-sync.service']).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(units['cabecao-sync.timer']).toContain('OnUnitActiveSec=45min');
    expect(units['cabecao-sync.timer']).toContain('WantedBy=timers.target');
  });

  it('cron: aspas simples do sh, % com barra, marca no fim; o merge preserva o resto e é idempotente', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    const line = cronLine({ ...command, program: "/opt/no'de 100%/node" }, 15, '/c/err.log');
    expect(line.startsWith('*/15 * * * * ')).toBe(true);
    expect(line).toContain(`'/opt/no'\\''de 100\\%/node'`);
    expect(line.endsWith(CRON_MARKER)).toBe(true);
    const other = 'MAILTO=ana@exemplo.com\n0 1 * * * /usr/bin/backup\n';
    const merged = mergeCrontab(other, line);
    expect(merged).toBe(`${other}${line}\n`);
    expect(mergeCrontab(merged, line)).toBe(merged);
    expect(mergeCrontab(merged, null)).toBe(other);
    expect(mergeCrontab(`${line}\n`, null)).toBe('');
    expect(cronSchedule(90)).toEqual({ expression: '7 */2 * * *', effectiveMin: 120 });
    expect(cronSchedule(1440)).toEqual({ expression: '17 3 * * *', effectiveMin: 1440 });
  });

  it('schtasks: lista de argumentos sem shell, /TR curto, e recusa acima de 261 caracteres', () => {
    const args = schtasksCreateArgs(
      { program: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\ana\\npm\\cabecao.mjs', 'sync', '--log'] },
      30,
      'Cabecao Sync',
    );
    expect(args).toEqual([
      '/Create',
      '/F',
      '/TN',
      'Cabecao Sync',
      '/SC',
      'MINUTE',
      '/MO',
      '30',
      '/TR',
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ana\\npm\\cabecao.mjs" sync --log',
    ]);
    expect(schtasksCreateArgs({ program: 'node.exe', args: ['x.mjs'] }, 1440, 'T')).toContain('DAILY');
    const long = { program: `C:\\${'pasta comprida\\'.repeat(20)}node.exe`, args: ['C:\\x.mjs', 'sync', '--log'] };
    expect(() => schtasksCreateArgs(long, 30, 'T')).toThrow(new RegExp(`no máximo ${SCHTASKS_TR_MAX}`));
  });
});

describe('schedule no macOS (launchd falso)', { timeout: TEST_TIMEOUT_MS }, () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('on registra, on de novo não mexe em nada, --interval atualiza, status mostra, off remove', async () => {
    const fake = fakeScheduler();
    const opts = { platform: 'darwin' as const, exec: fake.exec, binPath: s.bin };
    const first = await s.m.cabecao(['schedule', 'on'], opts);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Sync periódico registrado: a cada 30 min, pelo LaunchAgent do macOS.');
    expect(first.stdout).toContain(`Log: ${join(s.brain, '.cabecao', 'logs', 'sync.log')}`);
    const plistPath = join(s.m.home, 'Library', 'LaunchAgents', 'dev.cabecao.sync.plist');
    const plist = await readFile(plistPath, 'utf8');
    expect(plist).toContain(`<string>${s.bin}</string>`);
    expect(plist).toContain('<string>--log</string>');
    expect(fake.calls).toContain(`launchctl bootstrap gui/501 ${plistPath}`);
    expect(existsSync(join(s.m.configDir, 'schedule.json'))).toBe(true);

    fake.calls.length = 0;
    const again = parseJson(await s.m.cabecao(['schedule', 'on', '--json'], opts));
    expect(again.data.status).toBe('unchanged');
    expect(fake.calls.filter((call) => /bootstrap|bootout/.test(call))).toEqual([]);

    const updated = parseJson(await s.m.cabecao(['schedule', 'on', '--interval', '60', '--json'], opts));
    expect(updated.data).toMatchObject({ status: 'updated', interval_min: 60, mechanism: 'launchd' });
    expect(await readFile(plistPath, 'utf8')).toContain('<integer>3600</integer>');
    expect(fake.calls.filter((call) => /bootstrap|bootout/.test(call)).map((call) => call.split(' ')[1])).toEqual([
      'bootout',
      'bootstrap',
    ]);

    const status = await s.m.cabecao(['schedule', 'status'], opts);
    expect(status.stdout).toContain('Sync periódico: ligado, a cada 60 min, pelo LaunchAgent do macOS.');
    expect(status.stdout).toContain('No agendador: estado waiting, último código 0');

    const doctor = parseJson(await s.m.cabecao(['doctor', '--offline', '--json', '--brain', s.brain], opts));
    expect(doctor.data.checks.find((check: { id: string }) => check.id === 'schedule')).toMatchObject({
      status: 'ok',
      message: 'ligado a cada 60 min (launchd)',
    });

    const off = await s.m.cabecao(['schedule', 'off'], opts);
    expect(off.stdout).toContain('Sync periódico removido do LaunchAgent do macOS.');
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(join(s.m.configDir, 'schedule.json'))).toBe(false);
    expect((await s.m.cabecao(['schedule', 'off'], opts)).stdout).toContain('nada a remover');
    expect((await s.m.cabecao(['schedule', 'status'], opts)).stdout).toContain('Sync periódico: desligado.');
  });

  it('não sobrescreve um arquivo que não é do Cabeção', async () => {
    const fake = fakeScheduler();
    const plistPath = join(s.m.home, 'Library', 'LaunchAgents', 'dev.cabecao.sync.plist');
    mkdirSync(join(s.m.home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plistPath, '<plist>de outra pessoa</plist>');
    const result = await s.m.cabecao(['schedule', 'on'], { platform: 'darwin', exec: fake.exec, binPath: s.bin });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('não foi criado pelo Cabeção');
    expect(await readFile(plistPath, 'utf8')).toBe('<plist>de outra pessoa</plist>');
    expect(fake.calls.filter((call) => call.includes('bootstrap'))).toEqual([]);
  });

  it('o doctor avisa quando o bin agendado sumiu', async () => {
    const fake = fakeScheduler();
    const opts = { platform: 'darwin' as const, exec: fake.exec, binPath: s.bin };
    expect((await s.m.cabecao(['schedule', 'on'], opts)).code).toBe(0);
    writeFileSync(
      join(s.m.configDir, 'schedule.json'),
      readFileSync(join(s.m.configDir, 'schedule.json'), 'utf8').replace(s.bin, join(s.m.home, 'sumiu.mjs')),
    );
    const doctor = parseJson(await s.m.cabecao(['doctor', '--offline', '--json', '--brain', s.brain], opts));
    expect(doctor.data.checks.find((check: { id: string }) => check.id === 'schedule')).toMatchObject({
      status: 'warn',
      items: [join(s.m.home, 'sumiu.mjs')],
    });
  });
});

describe('schedule no Linux (systemd e crontab falsos)', { timeout: TEST_TIMEOUT_MS }, () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('systemd --user: grava as unidades no XDG_CONFIG_HOME, habilita o timer, avisa do linger, off desfaz', async () => {
    const fake = fakeScheduler();
    const opts = { platform: 'linux' as const, exec: fake.exec, binPath: s.bin, env: { ...s.m.env, USER: 'ana' } };
    const result = await s.m.cabecao(['schedule', 'on', '--interval', '15'], opts);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('pelo timer do systemd --user');
    expect(result.stdout).toContain('loginctl enable-linger');
    const dir = join(s.m.env.XDG_CONFIG_HOME ?? '', 'systemd', 'user');
    const service = await readFile(join(dir, 'cabecao-sync.service'), 'utf8');
    expect(service).toContain(
      `ExecStart=${systemdExecWord(process.execPath)} ${systemdExecWord(s.bin)} "sync" "--log"`,
    );
    expect(await readFile(join(dir, 'cabecao-sync.timer'), 'utf8')).toContain('OnUnitActiveSec=15min');
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        'systemctl --user daemon-reload',
        'systemctl --user enable cabecao-sync.timer',
        'systemctl --user restart cabecao-sync.timer',
      ]),
    );
    fake.calls.length = 0;
    expect(parseJson(await s.m.cabecao(['schedule', 'on', '--interval', '15', '--json'], opts)).data.status).toBe(
      'unchanged',
    );
    expect(fake.calls.some((call) => /daemon-reload|enable|restart/.test(call))).toBe(false);

    const off = await s.m.cabecao(['schedule', 'off'], opts);
    expect(off.code).toBe(0);
    expect(fake.calls).toContain('systemctl --user disable --now cabecao-sync.timer');
    expect(existsSync(join(dir, 'cabecao-sync.service'))).toBe(false);
  });

  it('sem systemd de usuário cai para o crontab, sem tocar nas linhas dos outros', async () => {
    const other = 'MAILTO=ana@exemplo.com\n0 1 * * * /usr/bin/backup\n';
    const fake = fakeScheduler({ systemd: false, crontab: other });
    const opts = { platform: 'linux' as const, exec: fake.exec, binPath: s.bin };
    const result = await s.m.cabecao(['schedule', 'on'], opts);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('pelo crontab');
    expect(fake.state.crontab?.startsWith(other)).toBe(true);
    expect(fake.state.crontab).toContain(`*/30 * * * * PATH=`);
    expect(fake.state.crontab).toContain(`${shQuote(s.bin)} 'sync' '--log' >/dev/null 2>>`);
    expect(fake.state.crontab?.trimEnd().endsWith(CRON_MARKER)).toBe(true);
    const before = fake.state.crontab;
    expect(parseJson(await s.m.cabecao(['schedule', 'on', '--json'], opts)).data.status).toBe('unchanged');
    expect(fake.state.crontab).toBe(before);
    expect((await s.m.cabecao(['schedule', 'off'], opts)).code).toBe(0);
    expect(fake.state.crontab).toBe(other);
    // o arquivo temporário do crontab não fica para trás
    expect(readdirSync(s.m.configDir).filter((name) => name.startsWith('crontab-'))).toEqual([]);
  });
});

// As pastas do Windows só se resolvem num Windows de verdade (`CABECAO_CONFIG_DIR` passa pelo `path.win32`): esta parte
// roda nos runners do Windows; os geradores do `schtasks` são conferidos em todo sistema, acima.
describe.runIf(process.platform === 'win32')(
  'schedule no Windows (schtasks falso)',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let s: Setup;
    beforeEach(async () => {
      s = await setup();
    });

    it('cria a tarefa do usuário com /TR curto, é idempotente e remove só a do Cabeção', async () => {
      const fake = fakeScheduler();
      const opts = { platform: 'win32' as const, exec: fake.exec, binPath: s.bin };
      const result = await s.m.cabecao(['schedule', 'on'], opts);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('pelo Agendador de Tarefas do Windows');
      expect(result.stdout).toContain('Interactive only');
      const create = fake.calls.find((call) => call.startsWith('schtasks /Create')) ?? '';
      expect(create).toContain('/TN Cabecao Sync /SC MINUTE /MO 30 /TR');
      expect(create).not.toContain('--brain');
      fake.calls.length = 0;
      expect(parseJson(await s.m.cabecao(['schedule', 'on', '--json'], opts)).data.status).toBe('unchanged');
      expect(fake.calls.some((call) => call.startsWith('schtasks /Create'))).toBe(false);
      expect((await s.m.cabecao(['schedule', 'off'], opts)).stdout).toContain('Removido: tarefa "Cabecao Sync"');
      expect(fake.state.task).toBeNull();
    });

    it('não substitui uma tarefa com o mesmo nome que não é do Cabeção', async () => {
      const fake = fakeScheduler({
        task: '<Task><Actions><Exec><Command>backup.exe</Command></Exec></Actions></Task>',
      });
      const result = await s.m.cabecao(['schedule', 'on'], { platform: 'win32', exec: fake.exec, binPath: s.bin });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('não foi criada pelo Cabeção');
      expect(fake.calls.some((call) => call.startsWith('schtasks /Create'))).toBe(false);
    });

    it('caminho comprido demais para o /TR: recusa com a conta', async () => {
      const fake = fakeScheduler();
      const execPath = `C:\\${'Pasta Bem Comprida\\'.repeat(14)}node.exe`;
      const result = await s.m.cabecao(['schedule', 'on'], {
        platform: 'win32',
        exec: fake.exec,
        binPath: s.bin,
        execPath,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/aceita no máximo 261/);
    });
  },
);

describe('schedule recusa antes de executar qualquer coisa', { timeout: TEST_TIMEOUT_MS }, () => {
  it('rodando por npx, sem cérebro padrão, com --brain de outro cérebro, intervalo inválido', async () => {
    const s = await setup();
    const fake = fakeScheduler();
    const ephemeral = join(s.m.home, '.npm', '_npx', 'abc123', 'node_modules', 'cabecao', 'dist', 'cabecao.mjs');
    mkdirSync(join(ephemeral, '..'), { recursive: true });
    writeFileSync(ephemeral, '//');
    const npx = await s.m.cabecao(['schedule', 'on'], { platform: 'darwin', exec: fake.exec, binPath: ephemeral });
    expect(npx.code).toBe(1);
    expect(npx.stderr).toContain('instalação estável');
    expect(npx.stderr).toContain('npm i -g cabecao');

    const other = await brainRepo('outro');
    const wrongBrain = await s.m.cabecao(['schedule', 'on', '--brain', other], {
      platform: 'darwin',
      exec: fake.exec,
      binPath: s.bin,
    });
    expect(wrongBrain.code).toBe(1);
    expect(wrongBrain.stderr).toContain('cérebro padrão desta máquina');

    const bad = await s.m.cabecao(['schedule', 'on', '--interval', '2'], { platform: 'darwin', exec: fake.exec });
    expect(bad.code).toBe(2);
    expect((await s.m.cabecao(['schedule'], { exec: fake.exec })).code).toBe(2);
    expect((await s.m.cabecao(['schedule', 'liga'], { exec: fake.exec })).code).toBe(2);

    const fresh = machine();
    const noBrain = await fresh.cabecao(['schedule', 'on'], { platform: 'darwin', exec: fake.exec, binPath: s.bin });
    expect(noBrain.code).toBe(1);
    expect(noBrain.stderr).toContain('cabecao init');
    expect(fake.calls).toEqual([]);
  });
});

// Registra DE VERDADE no agendador desta máquina, com nomes de teste, e remove no fim. Só com a variável explícita;
// nunca roda no CI nem por padrão.
describe.skipIf(process.env.CABECAO_TEST_REAL_SCHEDULER !== '1')('agendador de verdade (opcional)', () => {
  it('registra, consulta e remove', { timeout: 60_000 }, async () => {
    const configDir = freshDir('config real');
    const brain = await brainRepo('cerebro-real');
    await writeMachineConfig({ machine: 'teste-real', defaultBrain: brain }, configDir);
    const bin = join(freshDir('bin real'), 'cabecao.mjs');
    writeFileSync(bin, '// teste\n');
    const env = { ...process.env, CABECAO_CONFIG_DIR: configDir };
    const out: string[] = [];
    const ctx = (positionals: string[]): CommandContext => ({
      argv: [],
      env,
      cwd: process.cwd(),
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => out.push(chunk) },
      platform: process.platform,
      execPath: process.execPath,
      binPath: bin,
      exec: systemExec,
      command: 'schedule',
      values: {},
      positionals,
      json: false,
      brain: undefined,
      version: '0.0.0',
    });
    const names = { launchd: 'dev.cabecao.sync.teste', systemd: 'cabecao-sync-teste', schtasks: 'Cabecao Sync Teste' };
    try {
      expect((await runSchedule(ctx(['on']), names)).text).toContain('registrado');
      expect((await runSchedule(ctx(['status']), names)).text).toContain('ligado');
    } finally {
      await runSchedule(ctx(['off']), names);
    }
    expect((await runSchedule(ctx(['status']), names)).text).toContain('desligado');
  });
});
