// A primeira leva da auditoria de UX: ajuda com exemplos, grupos e largura do terminal, "você quis dizer", erros de
// sistema traduzidos, a dica de atualização pela forma de instalação, e o doctor mais preciso (identidade implícita do
// git, Node do registro que sumiu, plugin do Claude Code junto com o registro direto). Tudo com pasta de usuário falsa.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands.ts';
import type { DoctorFacts } from '../src/doctor/checks.ts';
import { checkClaudePlugin, checkClients, checkIdentity } from '../src/doctor/checks.ts';
import { CliError } from '../src/errors.ts';
import { EXAMPLES, GROUPS } from '../src/help.ts';
import { claudePlugin } from '../src/install-client/plugin.ts';
import { goneLaunchPaths } from '../src/install-client/register.ts';
import { channel, installMethod, upgradeCommand } from '../src/install-method.ts';
import { commandHelp, GLOBAL_OPTIONS } from '../src/router.ts';
import { closest } from '../src/suggest.ts';
import { systemError } from '../src/syserr.ts';
import { brainRepo, disposeSandbox, freshDir, machine, parseJson, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(disposeSandbox);

const width = (text: string) => Math.max(...text.split('\n').map((line) => [...line].length));

describe('ajuda', () => {
  it('todo comando tem ao menos um exemplo, e cada exemplo usa um comando e opções que existem', () => {
    for (const command of COMMANDS) {
      const examples = EXAMPLES[command.name] ?? [];
      expect(examples.length, command.name).toBeGreaterThan(0);
      for (const example of examples) {
        const words = example.slice(example.indexOf('cabecao ')).split(' ');
        expect(words[1], example).toBe(command.name);
        for (const word of words) {
          const option = /^--([a-z][a-z-]*)/.exec(word)?.[1];
          if (option !== undefined) expect({ ...command.options, ...GLOBAL_OPTIONS }, example).toHaveProperty(option);
        }
      }
    }
    // os grupos da ajuda geral só citam comandos que existem, e cada comando está em um grupo
    const grouped = GROUPS.flatMap((group) => group.commands);
    expect(grouped.filter((name) => !COMMANDS.some((command) => command.name === name))).toEqual([]);
    expect(COMMANDS.map((command) => command.name).filter((name) => !grouped.includes(name))).toEqual([]);
  });

  it('num terminal de 80 colunas (ou sem terminal), nenhuma linha da ajuda passa de 80', async () => {
    const m = machine();
    for (const args of [['--help'], ...COMMANDS.map((command) => [command.name, '--help'])]) {
      const out = await m.cabecao(args, { columns: 80 });
      expect(width(out.stdout), args.join(' ')).toBeLessThanOrEqual(80);
      // sem cor (nenhum ESC), com ou sem NO_COLOR
      expect(out.stdout.includes(String.fromCharCode(27))).toBe(false);
    }
    const piped = await m.cabecao(['sync', '--help']); // sem terminal: 80 colunas
    expect(width(piped.stdout)).toBeLessThanOrEqual(80);
    const narrow = await m.cabecao(['sync', '--help'], { env: { ...m.env, COLUMNS: '60' } });
    expect(width(narrow.stdout)).toBeLessThanOrEqual(60);
  });

  it('ajuda geral em grupos e ajuda de comando com exemplos e as opções globais numa linha', async () => {
    const m = machine();
    const general = (await m.cabecao(['--help'])).stdout;
    const order = ['Uso diário:', 'Configuração:', 'Notas e grafo:', 'Manutenção:'].map((title) =>
      general.indexOf(title),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const sync = commandHelp(COMMANDS.find((command) => command.name === 'sync') ?? (COMMANDS[0] as never));
    expect(sync).toContain('Exemplos:\n  cabecao sync\n');
    expect(sync).toContain('Opções globais: --brain <pasta>, --json, --as <cliente>, -h, -v');
  });

  it('você quis dizer: comando, opção, subcomando e cliente', async () => {
    const m = machine();
    const typo = await m.cabecao(['statsu']);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('comando desconhecido: statsu. Você quis dizer "cabecao status"?');
    expect((await m.cabecao(['doctor', '--ofline'])).stderr).toContain('Você quis dizer "--offline"?');
    expect((await m.cabecao(['schedule', 'stauts'])).stderr).toContain('Você quis dizer "schedule status"?');
    expect((await m.cabecao(['install-client', 'claude'])).stderr).toContain('Você quis dizer "claude-code"?');
    expect((await m.cabecao(['install-client', 'cursr'])).stderr).toContain('Você quis dizer "cursor"?');
    expect((await m.cabecao(['xyzzy'])).stderr).not.toContain('Você quis dizer');
    expect(closest('stat', ['status', 'sync'])).toBe('status');
    expect(closest('zz', ['status', 'sync'])).toBeUndefined();
  });
});

describe('erros de borda', () => {
  const errno = (code: string, syscall: string, path: string) =>
    Object.assign(new Error(`${code}: x, ${syscall} '${path}'`), { code, syscall, path });

  it('permissão negada, disco só de leitura e disco cheio: o que houve e o que fazer, sem o texto cru', () => {
    const denied = systemError(errno('EACCES', 'open', '/home/ana/.config/cabecao/config.json'));
    expect(denied).toBeInstanceOf(CliError);
    expect(denied?.message).toBe('sem permissão para abrir /home/ana/.config/cabecao/config.json');
    expect(denied?.hint).toMatch(/chmod u\+rw/);
    expect(denied?.message).not.toMatch(/EACCES/);
    expect(systemError(errno('EROFS', 'open', '/mnt/x'))?.message).toBe(
      'o disco de /mnt/x está montado só para leitura',
    );
    expect(systemError(errno('ENOSPC', 'write', '/x'))?.code).toBe('disk_full');
    expect(systemError(new Error('outra coisa'))).toBeUndefined();
  });

  it('configuração da máquina sem permissão: mensagem traduzida, sem "Error:" nem CABECAO_DEBUG', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod não vale no Windows nem como root
    const m = machine();
    await mkdir(m.configDir, { recursive: true });
    await writeFile(join(m.configDir, 'config.json'), '{}', { mode: 0o000 });
    const out = await m.cabecao(['status']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('sem permissão para abrir');
    expect(out.stderr).not.toMatch(/EACCES|Error:|CABECAO_DEBUG/);
  });

  it('banco local e .git sem permissão de escrita: o que houve e o que fazer; o sync não diz que commitou', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod não vale no Windows nem como root
    const { chmod } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    const m = machine();
    const brain = await brainRepo();
    expect((await m.cabecao(['status', '--brain', brain])).code).toBe(0);
    execFileSync('chmod', ['-R', 'a-w', join(brain, '.cabecao')]);
    try {
      const search = await m.cabecao(['search', 'atlas', '--brain', brain]);
      expect(search.code).toBe(1);
      expect(search.stderr).toContain('não consegui gravar no banco local');
      expect(search.stderr).toContain('chmod -R u+w');
      expect(search.stderr).not.toMatch(/readonly database|Error:/);
    } finally {
      execFileSync('chmod', ['-R', 'u+w', join(brain, '.cabecao')]);
    }
    await writeFile(join(brain, 'wiki', 'concepts', 'nova.md'), '---\ntype: concept\ntitle: Nova\n---\nNova.\n');
    execFileSync('chmod', ['-R', 'a-w', join(brain, '.git')]);
    try {
      const sync = await m.cabecao(['sync', '--brain', brain, '--json']);
      expect(sync.code).toBe(1);
      const data = JSON.parse(sync.stdout).data;
      expect(data).toMatchObject({ status: 'error', reason: 'permission' });
      expect(data.message).toContain('ainda NÃO estão em nenhum commit');
      expect(data.message).not.toContain('estão em commits locais');
      expect(data.next_step).toContain('Libere a escrita');
    } finally {
      execFileSync('chmod', ['-R', 'u+w', join(brain, '.git')]);
      await chmod(brain, 0o755);
    }
  });

  it('um cérebro de versão mais nova: a dica traz o comando de atualização desta instalação e do canal', async () => {
    const m = machine();
    const brain = await brainRepo();
    const config = join(brain, '.cabecao.json');
    const { readFile } = await import('node:fs/promises');
    const json = JSON.parse(await readFile(config, 'utf8'));
    await writeFile(config, JSON.stringify({ ...json, schemaVersion: 99 }));
    const bin = join(freshDir('global'), 'lib', 'node_modules', 'cabecao', 'dist', 'cabecao.mjs');
    const out = await m.cabecao(['status', '--brain', brain], { binPath: bin });
    expect(out.code).toBe(1);
    // o canal vem da versão que está rodando: `beta` num pré-lançamento, `latest` numa versão final
    expect(out.stderr).toContain(`atualize com "npm i -g cabecao@${channel()}"`);
  });
});

describe('forma de instalação e canal', () => {
  it('detecta npm global, pnpm global, npx, projeto, plugin e código-fonte; o canal segue a versão', () => {
    const io = (binPath: string, env: Record<string, string> = {}) => ({ binPath, env });
    expect(installMethod(io('/usr/local/lib/node_modules/cabecao/dist/cabecao.mjs'))).toBe('npm-global');
    expect(installMethod(io('C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\cabecao\\dist\\cabecao.mjs'))).toBe(
      'npm-global',
    );
    expect(installMethod(io('/home/ana/.local/share/pnpm/global/5/node_modules/cabecao/dist/cabecao.mjs'))).toBe(
      'pnpm-global',
    );
    expect(installMethod(io('/home/ana/.npm/_npx/abc/node_modules/cabecao/dist/cabecao.mjs'))).toBe('npx');
    expect(installMethod(io('/home/ana/projeto/node_modules/cabecao/dist/cabecao.mjs'))).toBe('local');
    expect(installMethod(io('/home/ana/.claude/plugins/cache/cabecao/server/cabecao.mjs'))).toBe('plugin');
    expect(installMethod(io('/home/ana/src/cabecao/packages/cli/dist/cabecao.mjs'))).toBe('source');
    expect(channel('0.1.0-beta.3')).toBe('beta');
    expect(channel('1.0.0')).toBe('latest');
    expect(upgradeCommand(io('/home/ana/.npm/_npx/abc/node_modules/cabecao/dist/cabecao.mjs'), '0.1.0-beta.3')).toBe(
      'npx cabecao@beta <comando>',
    );
    expect(upgradeCommand(io('/usr/local/lib/node_modules/cabecao/dist/cabecao.mjs'), '1.2.0')).toBe(
      'npm i -g cabecao@latest',
    );
  });
});

/** Fatos mínimos para as verificações puras. */
const base: DoctorFacts = {
  platform: 'linux',
  nodeVersion: '24.1.0',
  git: { kind: 'ok', version: '2.50.1', supported: true, minimum: '2.38' },
  brain: { kind: 'resolved', root: '/home/ana/cabecao' },
};

describe('doctor mais preciso', { timeout: TEST_TIMEOUT_MS }, () => {
  it('identidade implícita do git (sem user.email) é aviso, com o comando', () => {
    const implicit = checkIdentity({
      ...base,
      identity: { kind: 'ok', ident: 'Ana <ana@MacBook.local>', explicit: false },
    });
    expect(implicit).toMatchObject({ status: 'warn', fix: expect.stringContaining('git config --global user.email') });
    expect(checkIdentity({ ...base, identity: { kind: 'ok', ident: 'Ana <ana@x.com>', explicit: true } })?.status).toBe(
      'ok',
    );
  });

  it('identidade implícita num cérebro de verdade: o doctor avisa', async () => {
    const brain = await brainRepo();
    const m = machine();
    const gitconfig = join(freshDir('git sem identidade'), 'gitconfig');
    await writeFile(gitconfig, '[init]\n\tdefaultBranch = main\n');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    try {
      const out = parseJson(await m.cabecao(['doctor', '--offline', '--brain', brain, '--json']));
      const identity = out.data.checks.find((check: { id: string }) => check.id === 'identity');
      // num Linux sem domínio o git pode recusar inventar: aí já é falha
      expect(['warn', 'fail']).toContain(identity.status);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  it('o Node gravado no registro não existe mais: falha, com install-client', () => {
    const gone = '/home/ana/.nvm/versions/node/v20.0.0/bin/node';
    expect(goneLaunchPaths({ command: gone, args: ['/nao/existe/cabecao.mjs', 'mcp'] })).toEqual([
      gone,
      '/nao/existe/cabecao.mjs',
    ]);
    expect(goneLaunchPaths({ command: 'npx', args: ['-y', 'cabecao@1.0.0', 'mcp'] })).toEqual([]);
    const result = checkClients({
      ...base,
      clients: {
        kind: 'read',
        detected: ['cursor'],
        registrations: [
          {
            client: 'cursor',
            label: 'Cursor',
            files: [{ path: '/home/ana/.cursor/mcp.json', state: 'different', gone: [gone] }],
          },
        ],
      },
    });
    expect(result).toMatchObject({
      status: 'fail',
      message: expect.stringContaining(gone),
      fix: expect.stringContaining('cabecao install-client cursor'),
    });
  });

  it('plugin do Claude Code e registro direto ao mesmo tempo: aviso com a remoção; só o plugin: ok', async () => {
    const m = machine();
    const plugins = join(m.home, '.claude', 'plugins');
    await mkdir(plugins, { recursive: true });
    await writeFile(
      join(plugins, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'cabecao@cabecao': [{ scope: 'user', version: '0.1.0-beta.1' }] } }),
    );
    const location = { platform: process.platform, env: m.env, home: m.home };
    const plugin = await claudePlugin(location);
    expect(plugin).toMatchObject({ installed: true, enabled: null, version: '0.1.0-beta.1', key: 'cabecao@cabecao' });
    const registrations = (state: 'current' | 'missing') => [
      { client: 'claude-code' as const, label: 'Claude Code', files: [{ path: '/x/.claude.json', state }] },
    ];
    const both = checkClaudePlugin({
      ...base,
      clients: { kind: 'read', detected: ['claude-code'], registrations: registrations('current'), plugin },
    });
    expect(both).toMatchObject({ status: 'warn', fix: expect.stringContaining('install-client --remove claude-code') });
    const only = {
      kind: 'read' as const,
      detected: ['claude-code' as const],
      registrations: registrations('missing'),
      plugin,
    };
    expect(checkClaudePlugin({ ...base, clients: only })?.status).toBe('ok');
    // sem o registro direto, o Claude Code não conta como "sem registro": o servidor vem do plugin
    expect(checkClients({ ...base, clients: only })?.status).toBe('ok');

    await writeFile(
      join(m.home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'cabecao@cabecao': false } }),
    );
    expect((await claudePlugin(location)).enabled).toBe(false);

    // pelo doctor de verdade, com o registro direto no ~/.claude.json
    await writeFile(join(m.home, '.claude', 'settings.json'), '{}');
    const brain = await brainRepo();
    expect((await m.cabecao(['install-client', 'claude-code', '--brain', brain])).code).toBe(0);
    const out = parseJson(await m.cabecao(['doctor', '--offline', '--brain', brain, '--json']));
    expect(out.data.checks.find((check: { id: string }) => check.id === 'claude-plugin')?.status).toBe('warn');
  });
});
