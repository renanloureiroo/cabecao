// O plugin do Claude Code em `integrations/claude-code/` e o marketplace na raiz do repositório. O bundle da CLI e as
// skills vão commitados dentro do plugin (o Claude Code instala clonando o repositório, sem passo de build) e são
// refeitos SÓ no passo de versão (`pnpm version-packages`): o plugin corresponde à versão PUBLICADA, não ao código do
// meio do desenvolvimento. Por isso este teste NÃO exige que o bundle bata com o código atual: confere que o que está
// commitado é íntegro (cada arquivo bate com o `build.json`), é da versão declarada no `plugin.json`, e roda os hooks
// com o bundle embutido, do jeito que o Claude Code roda.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { HOOK_USAGE_RULES } from '../src/hook/rules.ts';
import { brainRepo, disposeSandbox, freshDir, TEST_TIMEOUT_MS } from './helpers.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PLUGIN = join(REPO, 'integrations', 'claude-code');
const SERVER = join(PLUGIN, 'server');
/** `${CLAUDE_PLUGIN_ROOT}` e `${user_config.brain_dir}`, literais: o Claude Code é quem substitui. */
const ROOT_VAR = ['$', '{CLAUDE_PLUGIN_ROOT}'].join('');
const BRAIN_OPTION = ['$', '{user_config.brain_dir}'].join('');

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const version: string = readJson(join(REPO, 'packages', 'cli', 'package.json')).version;

/** Tools que existem hoje no servidor; o texto do plugin não pode mandar o agente atrás de outra. */
const TOOLS = [
  'recall',
  'search',
  'read',
  'graph',
  'facts',
  'status',
  'remember',
  'write_page',
  'patch_page',
  'relate',
  'sync',
  'undo',
  'handoff_save',
  'ingest',
  'lint',
  'forget',
  'consolidate',
];
/** Nomes que não são tools (as mesmas da lista de `packages/core/test/messages.test.ts`). */
const MISSING = /\b(?:listOperations|purge|forget_all|handoff_load)\b/;

interface HookCommand {
  type: string;
  command: string;
  args?: string[];
  timeout?: number;
}

function hooksOf(event: string): HookCommand[] {
  const hooks = readJson(join(PLUGIN, 'hooks', 'hooks.json')).hooks[event] as Array<{ hooks: HookCommand[] }>;
  return hooks.flatMap((entry) => entry.hooks);
}

afterAll(() => {
  disposeSandbox();
});

describe('manifestos do plugin e do marketplace', () => {
  it('o marketplace da raiz aponta para a pasta do plugin', () => {
    const marketplace = readJson(join(REPO, '.claude-plugin', 'marketplace.json'));
    expect(marketplace.name).toBe('cabecao');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: 'cabecao', source: './integrations/claude-code' }),
    ]);
    expect(marketplace.plugins[0].version).toBeUndefined(); // a versão mora só no plugin.json
    expect(existsSync(join(REPO, marketplace.plugins[0].source, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('plugin.json: versão igual à do pacote cabecao e a pasta do cérebro como opção do usuário', () => {
    const manifest = readJson(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    expect(manifest.name).toBe('cabecao');
    expect(manifest.version).toBe(version);
    expect(manifest.userConfig.brain_dir).toMatchObject({ type: 'directory', required: false });
  });

  it('o servidor MCP é o bundle embutido, sem npx, com a pasta do cérebro da opção do plugin', () => {
    const { mcpServers } = readJson(join(PLUGIN, '.mcp.json'));
    expect(mcpServers.cabecao).toEqual({
      command: 'node',
      args: [`${ROOT_VAR}/server/cabecao.mjs`, 'mcp'],
      env: { CABECAO_BRAIN: BRAIN_OPTION },
    });
  });

  it('hooks: recall --hook no início, sync --hook no fim, só o bundle embutido e nada de captura da conversa', () => {
    expect(Object.keys(readJson(join(PLUGIN, 'hooks', 'hooks.json')).hooks).sort()).toEqual([
      'SessionEnd',
      'SessionStart',
    ]);
    const [start] = hooksOf('SessionStart');
    const [end] = hooksOf('SessionEnd');
    expect(start).toMatchObject({
      type: 'command',
      command: 'node',
      args: [`${ROOT_VAR}/server/cabecao.mjs`, 'recall', '--hook'],
    });
    expect(end).toMatchObject({
      type: 'command',
      command: 'node',
      args: [`${ROOT_VAR}/server/cabecao.mjs`, 'sync', '--hook'],
    });
    for (const file of [
      readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'),
      readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'),
    ]) {
      expect(file).not.toMatch(/\bnpx\b/);
      for (const match of file.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/g)) {
        expect(existsSync(join(PLUGIN, match[1] ?? ''))).toBe(true);
      }
    }
  });

  it('as skills do plugin têm nome igual ao da pasta, descrição curta e só citam tools que existem', () => {
    const dir = join(PLUGIN, 'skills');
    const names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const skill = readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
      expect(new RegExp(`^name: ${name}$`, 'm').test(front), name).toBe(true);
      const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
      expect(description.length).toBeGreaterThan(50);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(skill).not.toMatch(MISSING);
      for (const tool of skill.matchAll(/\*\*`(\w+)`\*\*/g)) expect(TOOLS).toContain(tool[1]);
    }
    const rules = HOOK_USAGE_RULES.join('\n');
    expect(rules).not.toMatch(MISSING);
    for (const tool of rules.matchAll(/`([a-z_]+)`/g)) {
      if (!['rule', 'as_of', 'session_handle'].includes(tool[1] ?? '')) expect(TOOLS).toContain(tool[1]);
    }
    expect(rules).toContain('`handoff_save`');
  });
});

describe('bundle embutido no plugin', () => {
  it('é íntegro: cada arquivo bate com o build.json, da versão declarada no plugin.json', () => {
    const build = readJson(join(SERVER, 'build.json'));
    const declared: string = readJson(join(PLUGIN, '.claude-plugin', 'plugin.json')).version;
    expect(build.version).toBe(declared);
    const listed = Object.keys(build.files).sort();
    const present = readdirSync(SERVER)
      .filter((name) => name.endsWith('.mjs'))
      .sort();
    expect(present).toEqual(listed);
    for (const name of listed) {
      const hash = createHash('sha256')
        .update(readFileSync(join(SERVER, name)))
        .digest('hex');
      expect(hash, `${name} mudou desde o build.json`).toBe(build.files[name]);
    }
    // a versão vai embutida em algum pedaço do bundle (o `--version` do teste abaixo confere que é a que ele mostra)
    expect(listed.some((name) => readFileSync(join(SERVER, name), 'utf8').includes(declared))).toBe(true);
    // as skills copiadas no passo de versão (a partir de então, o build.json traz o hash de cada arquivo)
    for (const [rel, hash] of Object.entries((build.skills ?? {}) as Record<string, string>)) {
      const file = join(PLUGIN, 'skills', ...rel.split('/'));
      expect(existsSync(file), rel).toBe(true);
      expect(createHash('sha256').update(readFileSync(file)).digest('hex'), `${rel} mudou desde o build.json`).toBe(
        hash,
      );
    }
  });

  it('roda como o Claude Code roda: --version, recall --hook e sync --hook', { timeout: TEST_TIMEOUT_MS }, async () => {
    const brain = await brainRepo();
    const home = freshDir('casa do plugin');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      CABECAO_CONFIG_DIR: join(home, 'config'),
      CLAUDE_PLUGIN_ROOT: PLUGIN,
      CLAUDE_PLUGIN_OPTION_BRAIN_DIR: brain,
      CLAUDE_PROJECT_DIR: join(freshDir('projetos'), 'atlas'),
    };
    delete env.CABECAO_BRAIN;
    const bin = join(SERVER, 'cabecao.mjs');
    const run = (args: string[], input = '') =>
      spawnSync(process.execPath, [bin, ...args], { env, input, encoding: 'utf8', timeout: 60_000, windowsHide: true });

    expect(run(['--version']).stdout).toBe(`${version}\n`);

    const start = run(
      ['recall', '--hook'],
      JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }),
    );
    expect(start.status).toBe(0);
    const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('Escopo: project:atlas');
    expect(context).toContain('Nunca commitar segredos');

    // sem cérebro (opção vazia e nenhum padrão na máquina): {} e código 0
    const empty = spawnSync(process.execPath, [bin, 'recall', '--hook'], {
      env: { ...env, CLAUDE_PLUGIN_OPTION_BRAIN_DIR: '' },
      input: '{}',
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe('{}\n');

    const end = run(['sync', '--hook'], JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }));
    expect(end.status).toBe(0);
    expect(end.stdout).toBe('');
    // o sync destacado termina e grava o log; o teste espera para não deixar processo para trás
    const log = join(brain, '.cabecao', 'logs', 'sync.log');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(existsSync(log) && /· sync · código \d ---/.test(readFileSync(log, 'utf8')))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readFileSync(log, 'utf8')).toMatch(
      /hook SessionEnd do Claude Code, motivo other[\s\S]*· sync · código 0 ---/,
    );
  });
});
