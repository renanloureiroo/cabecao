import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientId, JsonTarget, Location, Target } from '../src/install-client/clients.ts';
import { CLIENT_IDS, CLIENTS } from '../src/install-client/clients.ts';
import { parseJsonc, toValue } from '../src/install-client/jsonc.ts';
import { resolveLaunch } from '../src/install-client/launch.ts';
import { hasTomlTable, tomlTable } from '../src/install-client/toml.ts';
import type { RunOptions } from '../src/main.ts';
import { run } from '../src/main.ts';
import type { Env, Exec, ExecResult } from '../src/types.ts';

// Todos os caminhos de cliente saem de HOME/USERPROFILE, APPDATA e XDG_CONFIG_HOME injetados: nenhum teste lê ou
// grava a configuração real da máquina. O PATH aponta para uma pasta vazia (ou com um `claude` de mentira) e o
// executor de comandos é injetado: nenhum programa externo roda.

const FAKE_NODE = '/opt/node-de-teste/bin/node';

interface Sandbox {
  root: string;
  home: string;
  brain: string;
  bin: string;
  pathDir: string;
  env: Env;
  location: Location;
  calls: Array<{ file: string; args: readonly string[] }>;
  replies: ExecResult[];
  exec: Exec;
  cabecao: (args: readonly string[], extra?: Partial<RunOptions>) => ReturnType<typeof run>;
}

let box: Sandbox;

async function makeSandbox(): Promise<Sandbox> {
  // realpath: no macOS o tmpdir é um link (/var -> /private/var) e o bin é resolvido pelo realpath.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cabecao-install-')));
  const home = join(root, 'casa');
  const brain = join(root, 'meu cérebro');
  const pathDir = join(root, 'path');
  const bin = join(root, 'global', 'node_modules', 'cabecao', 'dist', 'cabecao.mjs');
  await mkdir(home, { recursive: true });
  await mkdir(brain, { recursive: true });
  await mkdir(pathDir, { recursive: true });
  await mkdir(dirname(bin), { recursive: true });
  await writeFile(bin, '// bin de mentira\n');
  const env: Env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, 'appdata'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    CABECAO_CONFIG_DIR: join(root, 'config-cabecao'),
    PATH: pathDir,
  };
  const calls: Sandbox['calls'] = [];
  const replies: ExecResult[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return replies.shift() ?? { code: 0, stdout: '', stderr: '' };
  };
  const location: Location = { platform: process.platform, env, home };
  const sandbox: Sandbox = {
    root,
    home,
    brain,
    bin,
    pathDir,
    env,
    location,
    calls,
    replies,
    exec,
    cabecao: (args, extra = {}) =>
      run(['install-client', ...args], {
        env,
        cwd: root,
        platform: process.platform,
        homedir: home,
        execPath: FAKE_NODE,
        binPath: bin,
        exec,
        ...extra,
      }),
  };
  return sandbox;
}

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await rm(box.root, { recursive: true, force: true });
});

function targetsOf(id: ClientId): Target[] {
  return CLIENTS[id].targets(box.location);
}

function mainTarget(id: ClientId): Target {
  const [target] = targetsOf(id);
  if (target === undefined) throw new Error(`sem arquivo para ${id}`);
  return target;
}

function expectedArgs(): string[] {
  return [box.bin, 'mcp', '--brain', box.brain];
}

/** Lista todos os arquivos da caixa de areia com o conteúdo, para provar que nada mudou. */
async function snapshot(dir: string = box.root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    result[path] = await readFile(path, 'utf8');
  }
  return result;
}

function entryIn(target: JsonTarget, text: string): unknown {
  const document = toValue(parseJsonc(text)) as Record<string, Record<string, unknown> | undefined>;
  return document[target.section]?.cabecao;
}

/** Arquivo do cliente com outro servidor, um comentário e uma chave a mais. */
function existingConfig(target: Target): string {
  if (target.format === 'toml') {
    return '# meu Codex\nmodel = "o4"\n\n[mcp_servers.outro]\ncommand = "outro"\nargs = ["--x"]\n';
  }
  return `{\n  // meu comentário\n  "tema": "escuro",\n  "${target.section}": {\n    "outro": { "command": "outro", "args": ["--x"] }\n  }\n}\n`;
}

const FILE_CLIENTS = ['claude-desktop', 'codex', 'cursor', 'vscode', 'antigravity', 'gemini', 'claude-code'] as const;

describe.each(FILE_CLIENTS)('%s, editando o arquivo', (id) => {
  // Sem `claude` no PATH, o Claude Code também é registrado editando o arquivo.

  it('arquivo inexistente: cria com o registro e sem .bak', async () => {
    const target = mainTarget(id);
    const result = await box.cabecao([id, '--brain', box.brain]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('registrado');
    const text = await readFile(target.path, 'utf8');
    if (target.format === 'json') {
      const entry = entryIn(target, text) as Record<string, unknown>;
      expect(entry.command).toBe(FAKE_NODE);
      expect(entry.args).toEqual(expectedArgs());
    } else {
      expect(text).toBe(tomlTable(['mcp_servers', 'cabecao'], { command: FAKE_NODE, args: expectedArgs() }));
    }
    expect(existsSync(`${target.path}.bak`)).toBe(false);
  });

  it('arquivo com outros servidores: preserva tudo, guarda .bak e é idempotente', async () => {
    const target = mainTarget(id);
    const original = existingConfig(target);
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, original);

    const first = await box.cabecao([id, '--brain', box.brain]);
    expect(first.code).toBe(0);
    const text = await readFile(target.path, 'utf8');
    expect(await readFile(`${target.path}.bak`, 'utf8')).toBe(original);
    if (target.format === 'json') {
      expect(text).toContain('// meu comentário');
      const document = toValue(parseJsonc(text)) as Record<string, Record<string, unknown>>;
      expect(document.tema).toBe('escuro');
      expect(document[target.section]?.outro).toEqual({ command: 'outro', args: ['--x'] });
      expect((entryIn(target, text) as Record<string, unknown>).args).toEqual(expectedArgs());
    } else {
      expect(text.startsWith(original)).toBe(true);
      expect(hasTomlTable(text, ['mcp_servers', 'cabecao'])).toBe(true);
    }

    const before = await snapshot();
    const second = await box.cabecao([id, '--brain', box.brain]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('já estava registrado');
    expect(await snapshot()).toEqual(before);
  });

  it('--print mostra a configuração e não grava nada', async () => {
    const target = mainTarget(id);
    const before = await snapshot();
    const result = await box.cabecao([id, '--print', '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(target.path);
    expect(result.stdout).toContain(JSON.stringify(box.bin).slice(1, -1));
    expect(await snapshot()).toEqual(before);
    expect(box.calls).toEqual([]);
  });

  it('--remove tira só o registro; repetir não muda nada', async () => {
    const target = mainTarget(id);
    const original = existingConfig(target);
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, original);
    await box.cabecao([id, '--brain', box.brain]);

    const removed = await box.cabecao([id, '--remove']);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain('registro removido');
    expect(await readFile(target.path, 'utf8')).toBe(original);

    const again = await box.cabecao([id, '--remove']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('não estava registrado');
    expect(await readFile(target.path, 'utf8')).toBe(original);
  });

  it('--remove sem arquivo não cria nada', async () => {
    const before = await snapshot();
    const result = await box.cabecao([id, '--remove']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('não estava registrado');
    expect(await snapshot()).toEqual(before);
  });

  it('arquivo malformado: erro claro, código 1 e nada gravado', async () => {
    const target = mainTarget(id);
    const broken = target.format === 'json' ? '{\n  "mcpServers": {\n    "outro": \n' : '[mcp_servers.outro\n';
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, broken);
    const before = await snapshot();
    const result = await box.cabecao([id, '--brain', box.brain]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(target.path);
    expect(result.stderr).toContain(target.format === 'json' ? 'não é JSON válido' : 'não é TOML válido');
    expect(result.stderr).toContain('Nada foi gravado');
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(await snapshot()).toEqual(before);
  });

  it('com --json devolve o relatório estruturado', async () => {
    const result = await box.cabecao([id, '--brain', box.brain, '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('install-client');
    expect(parsed.data.action).toBe('install');
    expect(parsed.data.launch).toEqual({ command: FAKE_NODE, args: expectedArgs(), via: 'node' });
    expect(parsed.data.clients[0]).toMatchObject({ client: id, status: 'installed', method: 'file' });
  });
});

describe('detalhes por cliente', () => {
  it('o .bak guarda o estado de antes do cabecao, não o da última execução', async () => {
    const target = mainTarget('cursor');
    const original = existingConfig(target);
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, original);
    await box.cabecao(['cursor', '--brain', box.brain]);
    const other = join(box.root, 'outro cérebro');
    const updated = await box.cabecao(['cursor', '--brain', other]);
    expect(updated.stdout).toContain('registro atualizado');
    expect((entryIn(target as JsonTarget, await readFile(target.path, 'utf8')) as { args: string[] }).args).toEqual([
      box.bin,
      'mcp',
      '--brain',
      other,
    ]);
    expect(await readFile(`${target.path}.bak`, 'utf8')).toBe(original);
  });

  it('chaves que o usuário pôs na entrada (env) ficam; command e args são do cabecao', async () => {
    const target = mainTarget('gemini') as JsonTarget;
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(
      target.path,
      JSON.stringify({ mcpServers: { cabecao: { command: 'npx', args: ['-y', 'cabecao'], env: { A: '1' } } } }),
    );
    await box.cabecao(['gemini', '--brain', box.brain]);
    expect(entryIn(target, await readFile(target.path, 'utf8'))).toEqual({
      command: FAKE_NODE,
      args: expectedArgs(),
      env: { A: '1' },
    });
  });

  it('formato da entrada: type stdio onde o cliente usa, sem type onde não usa', async () => {
    for (const id of ['claude-desktop', 'cursor', 'antigravity', 'gemini', 'claude-code', 'vscode'] as const) {
      await box.cabecao([id, '--brain', box.brain]);
    }
    const read = async (id: ClientId) => {
      const target = mainTarget(id) as JsonTarget;
      return entryIn(target, await readFile(target.path, 'utf8'));
    };
    const plain = { command: FAKE_NODE, args: expectedArgs() };
    expect(await read('claude-desktop')).toEqual(plain);
    expect(await read('gemini')).toEqual(plain);
    expect(await read('antigravity')).toEqual(plain);
    expect(await read('cursor')).toEqual({ type: 'stdio', ...plain });
    expect(await read('claude-code')).toEqual({ type: 'stdio', ...plain });
    expect(await read('vscode')).toEqual({ type: 'stdio', ...plain, tools: ['*'] });
  });

  it('VS Code: o mcp.json do perfil (raiz "servers") só é gravado se a pasta do perfil existe', async () => {
    const [copilot, legacy] = targetsOf('vscode') as JsonTarget[];
    if (copilot === undefined || legacy === undefined) throw new Error('VS Code deveria ter dois arquivos');
    await box.cabecao(['vscode', '--brain', box.brain]);
    expect(existsSync(copilot.path)).toBe(true);
    expect(existsSync(legacy.path)).toBe(false);

    await mkdir(dirname(legacy.path), { recursive: true });
    await box.cabecao(['vscode', '--brain', box.brain]);
    expect(legacy.section).toBe('servers');
    expect(entryIn(legacy, await readFile(legacy.path, 'utf8'))).toEqual({
      type: 'stdio',
      command: FAKE_NODE,
      args: expectedArgs(),
    });

    await box.cabecao(['vscode', '--remove']);
    expect(entryIn(legacy, await readFile(legacy.path, 'utf8'))).toBeUndefined();
    expect(entryIn(copilot, await readFile(copilot.path, 'utf8'))).toBeUndefined();
  });

  it('Antigravity: o caminho antigo do IDE e do App só é gravado se a pasta existe', async () => {
    const [current, legacy] = targetsOf('antigravity') as JsonTarget[];
    if (current === undefined || legacy === undefined) throw new Error('Antigravity deveria ter dois arquivos');
    await box.cabecao(['antigravity', '--brain', box.brain]);
    expect(entryIn(current, await readFile(current.path, 'utf8'))).toEqual({
      command: FAKE_NODE,
      args: expectedArgs(),
    });
    expect(existsSync(legacy.path)).toBe(false);

    await mkdir(dirname(legacy.path), { recursive: true });
    await box.cabecao(['antigravity', '--brain', box.brain]);
    expect(entryIn(legacy, await readFile(legacy.path, 'utf8'))).toEqual({ command: FAKE_NODE, args: expectedArgs() });

    await box.cabecao(['antigravity', '--remove']);
    expect(entryIn(current, await readFile(current.path, 'utf8'))).toBeUndefined();
    expect(entryIn(legacy, await readFile(legacy.path, 'utf8'))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'Antigravity: o mcp_config.json antigo como link para o novo continua link, e a escrita vai para o alvo',
    async () => {
      const [current, legacy] = targetsOf('antigravity') as JsonTarget[];
      if (current === undefined || legacy === undefined) throw new Error('Antigravity deveria ter dois arquivos');
      await mkdir(dirname(current.path), { recursive: true });
      await mkdir(dirname(legacy.path), { recursive: true });
      await writeFile(current.path, '{\n  "mcpServers": { "outro": { "command": "outro" } }\n}\n');
      const { symlink, lstat } = await import('node:fs/promises');
      await symlink(current.path, legacy.path);
      const result = await box.cabecao(['antigravity', '--brain', box.brain]);
      expect(result.code).toBe(0);
      expect((await lstat(legacy.path)).isSymbolicLink()).toBe(true);
      const document = toValue(parseJsonc(await readFile(current.path, 'utf8'))) as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(document.mcpServers ?? {}).sort()).toEqual(['cabecao', 'outro']);
    },
  );

  it('Gemini CLI: registra como antes, com o aviso de que contas pessoais migraram para o Antigravity', async () => {
    const result = await box.cabecao(['gemini', '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Gemini CLI: registrado');
    expect(result.stdout).toContain('cabecao install-client antigravity');
    const printed = await box.cabecao(['--print', 'gemini', '--brain', box.brain]);
    expect(printed.stdout).toContain('# aviso: o Gemini CLI deixou de atender contas pessoais');
    const removed = await box.cabecao(['gemini', '--remove']);
    expect(removed.stdout).not.toContain('aviso');
  });

  it('um cliente com arquivo quebrado não impede os outros', async () => {
    const cursor = mainTarget('cursor');
    await mkdir(dirname(cursor.path), { recursive: true });
    await writeFile(cursor.path, '{ quebrado');
    const result = await box.cabecao(['cursor', 'gemini', '--brain', box.brain, '--json']);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.data.clients.map((client: { status: string }) => client.status)).toEqual(['failed', 'installed']);
    expect(existsSync(mainTarget('gemini').path)).toBe(true);
    expect(await readFile(cursor.path, 'utf8')).toBe('{ quebrado');
  });

  it('seção de servidores que não é objeto: recusa sem gravar', async () => {
    const target = mainTarget('cursor');
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, '{"mcpServers": []}');
    const result = await box.cabecao(['cursor', '--brain', box.brain]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"mcpServers" deveria ser um objeto');
    expect(await readFile(target.path, 'utf8')).toBe('{"mcpServers": []}');
  });

  it('Codex: tabela inline recusada com dica de --print', async () => {
    const target = mainTarget('codex');
    await mkdir(dirname(target.path), { recursive: true });
    const text = 'mcp_servers = { cabecao = { command = "x" } }\n';
    await writeFile(target.path, text);
    const result = await box.cabecao(['codex', '--brain', box.brain]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--print');
    expect(await readFile(target.path, 'utf8')).toBe(text);
  });

  it('arquivo novo é criado só para o dono (0600) fora do Windows', async () => {
    if (process.platform === 'win32') return;
    await box.cabecao(['cursor', '--brain', box.brain]);
    const { stat } = await import('node:fs/promises');
    expect((await stat(mainTarget('cursor').path)).mode & 0o077).toBe(0);
  });
});

describe('Claude Code pelo comando claude', () => {
  let claudePath: string;

  beforeEach(async () => {
    claudePath = join(box.pathDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    await writeFile(claudePath, '');
    await chmod(claudePath, 0o755);
  });

  function claudeJson(): JsonTarget {
    return mainTarget('claude-code') as JsonTarget;
  }

  async function writeClaudeJson(entry: unknown): Promise<string> {
    const text = `${JSON.stringify({ numStartups: 3, mcpServers: { outro: { command: 'x' }, cabecao: entry } }, null, 2)}\n`;
    await writeFile(claudeJson().path, text);
    return text;
  }

  it('sem registro: chama claude mcp add-json com escopo user e não toca no arquivo', async () => {
    const result = await box.cabecao(['claude-code', '--brain', box.brain, '--json']);
    expect(result.code).toBe(0);
    expect(box.calls).toHaveLength(1);
    const [call] = box.calls;
    // o Windows devolve a extensão como está no PATHEXT (`.EXE`)
    expect(call?.file.toLowerCase()).toBe(claudePath.toLowerCase());
    expect(call?.args.slice(0, 5)).toEqual(['mcp', 'add-json', 'cabecao', '--scope', 'user']);
    expect(JSON.parse(call?.args[5] ?? '')).toEqual({ type: 'stdio', command: FAKE_NODE, args: expectedArgs() });
    expect(JSON.parse(result.stdout).data.clients[0]).toMatchObject({ status: 'installed', method: 'cli' });
    expect(existsSync(claudeJson().path)).toBe(false);
  });

  it('registro igual: não chama nada', async () => {
    await writeClaudeJson({ type: 'stdio', command: FAKE_NODE, args: expectedArgs() });
    const result = await box.cabecao(['claude-code', '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('já estava registrado');
    expect(box.calls).toEqual([]);
  });

  it('registro diferente: remove e adiciona de novo, mantendo o env do usuário', async () => {
    const before = await writeClaudeJson({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'cabecao', 'mcp'],
      env: { A: '1' },
    });
    const result = await box.cabecao(['claude-code', '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('registro atualizado');
    expect(box.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['mcp', 'remove'],
      ['mcp', 'add-json'],
    ]);
    expect(JSON.parse(box.calls[1]?.args[5] ?? '')).toEqual({
      type: 'stdio',
      command: FAKE_NODE,
      args: expectedArgs(),
      env: { A: '1' },
    });
    expect(await readFile(claudeJson().path, 'utf8')).toBe(before);
  });

  it('add-json falhando depois do remove devolve o registro antigo e sai com 1', async () => {
    const old = { type: 'stdio', command: 'npx', args: ['-y', 'cabecao', 'mcp'] };
    await writeClaudeJson(old);
    box.replies.push({ code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'deu ruim' });
    const result = await box.cabecao(['claude-code', '--brain', box.brain]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"claude mcp add-json" falhou: deu ruim');
    expect(box.calls).toHaveLength(3);
    expect(JSON.parse(box.calls[2]?.args[5] ?? '')).toEqual(old);
  });

  it('--remove: só chama remove quando há registro', async () => {
    const absent = await box.cabecao(['claude-code', '--remove']);
    expect(absent.stdout).toContain('não estava registrado');
    expect(box.calls).toEqual([]);

    await writeClaudeJson({ command: 'x' });
    const removed = await box.cabecao(['claude-code', '--remove']);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain('registro removido');
    expect(box.calls.map((call) => call.args)).toEqual([['mcp', 'remove', 'cabecao', '--scope', 'user']]);
  });

  it('claude que não chega a rodar: recua para a edição do arquivo', async () => {
    box.replies.push({ code: null, stdout: '', stderr: 'spawn EACCES' });
    const result = await box.cabecao(['claude-code', '--brain', box.brain, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.clients[0]).toMatchObject({ status: 'installed', method: 'file' });
    expect(entryIn(claudeJson(), await readFile(claudeJson().path, 'utf8'))).toEqual({
      type: 'stdio',
      command: FAKE_NODE,
      args: expectedArgs(),
    });
  });

  it('--print mostra o comando claude mcp add-json e a alternativa no arquivo', async () => {
    const result = await box.cabecao(['claude-code', '--print', '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claude mcp add-json cabecao --scope user '{");
    expect(result.stdout).toContain(claudeJson().path);
    expect(box.calls).toEqual([]);
  });
});

describe('seleção de clientes e erros de uso', () => {
  it.each([
    [[], 'diga o cliente'],
    [['nao-existe'], 'cliente desconhecido: nao-existe'],
    [['cursor', '--print', '--remove'], '--print e --remove não combinam'],
    [['cursor', '--all'], 'use --all ou o nome dos clientes'],
  ])('%j sai com código 2', async (args, message) => {
    const before = await snapshot();
    const result = await box.cabecao([...args, '--brain', box.brain]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(await snapshot()).toEqual(before);
  });

  it('--all registra só os clientes detectados', async () => {
    await mkdir(join(box.home, '.cursor'));
    await mkdir(join(box.home, '.gemini'));
    await writeFile(join(box.home, '.gemini', 'settings.json'), '{}\n');
    const result = await box.cabecao(['--all', '--brain', box.brain, '--json']);
    expect(result.code).toBe(0);
    const clients = JSON.parse(result.stdout).data.clients.map((client: { client: string }) => client.client);
    expect(clients).toEqual(['cursor', 'gemini']);
    expect(existsSync(mainTarget('codex').path)).toBe(false);
  });

  it('--all: a pasta ~/.gemini do Antigravity não faz o Gemini CLI parecer instalado', async () => {
    await mkdir(join(box.home, '.gemini', 'antigravity-cli'), { recursive: true });
    const result = await box.cabecao(['--all', '--brain', box.brain, '--json']);
    const clients = JSON.parse(result.stdout).data.clients.map((client: { client: string }) => client.client);
    expect(clients).toEqual(['antigravity']);
    expect(existsSync(join(box.home, '.gemini', 'config', 'mcp_config.json'))).toBe(true);
    expect(existsSync(join(box.home, '.gemini', 'settings.json'))).toBe(false);
  });

  it('--all detecta o Antigravity pelo executável agy', async () => {
    const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
    await writeFile(join(box.pathDir, name), '');
    await chmod(join(box.pathDir, name), 0o755);
    const result = await box.cabecao(['--all', '--brain', box.brain, '--json']);
    const clients = JSON.parse(result.stdout).data.clients.map((client: { client: string }) => client.client);
    expect(clients).toEqual(['antigravity']);
  });

  it('--all detecta pelo executável no PATH', async () => {
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
    await writeFile(join(box.pathDir, name), '');
    await chmod(join(box.pathDir, name), 0o755);
    const result = await box.cabecao(['--all', '--brain', box.brain, '--json']);
    const clients = JSON.parse(result.stdout).data.clients.map((client: { client: string }) => client.client);
    expect(clients).toEqual(['codex']);
  });

  it('--all sem nenhum cliente detectado avisa e não grava nada', async () => {
    const before = await snapshot();
    const result = await box.cabecao(['--all', '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nenhum cliente de IA foi detectado');
    expect(await snapshot()).toEqual(before);
  });

  it('--print sem nome mostra todos os clientes', async () => {
    const result = await box.cabecao(['--print', '--brain', box.brain]);
    expect(result.code).toBe(0);
    for (const id of CLIENT_IDS) expect(result.stdout).toContain(`# ${CLIENTS[id].label}`);
  });

  it('sem --brain usa o cérebro padrão da configuração da máquina', async () => {
    const configDir = box.env.CABECAO_CONFIG_DIR as string;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ machine: 'teste', defaultBrain: box.brain }));
    const result = await box.cabecao(['cursor', '--print', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.brain).toBe(box.brain);
  });

  it('sem --brain e sem cérebro configurado: erro de execução com a dica', async () => {
    const result = await box.cabecao(['cursor']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nenhum cérebro configurado');
    expect(result.stderr).toContain('--brain');
  });

  it('CABECAO_BRAIN vale como --brain', async () => {
    const result = await box.cabecao(['cursor', '--print', '--json'], {
      env: { ...box.env, CABECAO_BRAIN: box.brain },
    });
    expect(JSON.parse(result.stdout).data.brain).toBe(box.brain);
  });

  it('pasta do cérebro inexistente: grava e avisa', async () => {
    const missing = join(box.root, 'ainda-nao');
    const result = await box.cabecao(['cursor', '--brain', missing]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('a pasta do cérebro ainda não existe');
  });
});

describe('como o servidor é referenciado', () => {
  const io = (binPath: string | undefined, platform: NodeJS.Platform = 'linux') => ({
    execPath: FAKE_NODE,
    binPath,
    platform,
  });

  it('instalação estável: node direto no arquivo do bin', async () => {
    expect(await resolveLaunch(io(box.bin), '/b', false)).toEqual({
      command: FAKE_NODE,
      args: [box.bin, 'mcp', '--brain', '/b'],
      via: 'node',
    });
  });

  it('segue o link do bin global até o arquivo de verdade', async () => {
    if (process.platform === 'win32') return; // criar link simbólico exige privilégio no Windows
    const { symlink } = await import('node:fs/promises');
    const link = join(box.root, 'cabecao-link');
    await symlink(box.bin, link);
    expect((await resolveLaunch(io(link), '/b', false)).args[0]).toBe(box.bin);
  });

  it.each([
    ['npm', ['.npm', '_npx', 'abc', 'node_modules', 'cabecao', 'dist', 'cabecao.mjs']],
    ['pnpm dlx', ['pnpm', 'dlx', 'abc', 'node_modules', 'cabecao', 'dist', 'cabecao.mjs']],
    ['código-fonte', ['src', 'bin.ts']],
  ])('rodando por %s: npx -y cabecao mcp', async (_name, parts) => {
    const bin = join(box.root, ...parts);
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, '');
    expect(await resolveLaunch(io(bin), '/b', false)).toEqual({
      command: 'npx',
      args: ['-y', 'cabecao', 'mcp', '--brain', '/b'],
      via: 'npx',
    });
  });

  it('--npx força o npx; no Windows ele vai por cmd /c', async () => {
    expect((await resolveLaunch(io(box.bin), '/b', true)).command).toBe('npx');
    expect(await resolveLaunch(io(box.bin, 'win32'), 'C:\\b', true)).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'cabecao', 'mcp', '--brain', 'C:\\b'],
      via: 'npx',
    });
    expect((await resolveLaunch(io(undefined), '/b', false)).via).toBe('npx');
  });

  it('install-client --npx grava a forma com npx', async () => {
    await box.cabecao(['cursor', '--brain', box.brain, '--npx']);
    const entry = entryIn(mainTarget('cursor') as JsonTarget, await readFile(mainTarget('cursor').path, 'utf8'));
    // no Windows o npx é chamado por `cmd /c npx`; o fim dos argumentos é igual nos três sistemas
    const args = (entry as { args: string[] }).args;
    expect(args.slice(-5)).toEqual(['-y', 'cabecao', 'mcp', '--brain', box.brain]);
  });
});

describe('caminhos dos arquivos nos três sistemas', () => {
  const paths = (location: Location) =>
    Object.fromEntries(CLIENT_IDS.map((id) => [id, CLIENTS[id].targets(location).map((target) => target.path)]));

  it('macOS', () => {
    expect(paths({ platform: 'darwin', env: {}, home: '/Users/ze' })).toEqual({
      'claude-code': ['/Users/ze/.claude.json'],
      'claude-desktop': ['/Users/ze/Library/Application Support/Claude/claude_desktop_config.json'],
      codex: ['/Users/ze/.codex/config.toml'],
      cursor: ['/Users/ze/.cursor/mcp.json'],
      vscode: ['/Users/ze/.copilot/mcp-config.json', '/Users/ze/Library/Application Support/Code/User/mcp.json'],
      antigravity: ['/Users/ze/.gemini/config/mcp_config.json', '/Users/ze/.gemini/antigravity/mcp_config.json'],
      gemini: ['/Users/ze/.gemini/settings.json'],
    });
  });

  it('Linux, com e sem XDG_CONFIG_HOME', () => {
    const plain = paths({ platform: 'linux', env: {}, home: '/home/ze' });
    expect(plain['claude-desktop']).toEqual(['/home/ze/.config/Claude/claude_desktop_config.json']);
    expect(plain.vscode).toEqual(['/home/ze/.copilot/mcp-config.json', '/home/ze/.config/Code/User/mcp.json']);
    const xdg = paths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/ze' });
    expect(xdg['claude-desktop']).toEqual(['/xdg/Claude/claude_desktop_config.json']);
    // XDG relativo é ignorado, como manda a especificação.
    const relative = paths({ platform: 'linux', env: { XDG_CONFIG_HOME: 'rel' }, home: '/home/ze' });
    expect(relative['claude-desktop']).toEqual(plain['claude-desktop']);
  });

  it('Windows', () => {
    const win = paths({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\ze\\AppData\\Roaming' },
      home: 'C:\\Users\\ze',
    });
    expect(win).toEqual({
      'claude-code': ['C:\\Users\\ze\\.claude.json'],
      'claude-desktop': ['C:\\Users\\ze\\AppData\\Roaming\\Claude\\claude_desktop_config.json'],
      codex: ['C:\\Users\\ze\\.codex\\config.toml'],
      cursor: ['C:\\Users\\ze\\.cursor\\mcp.json'],
      vscode: ['C:\\Users\\ze\\.copilot\\mcp-config.json', 'C:\\Users\\ze\\AppData\\Roaming\\Code\\User\\mcp.json'],
      antigravity: [
        'C:\\Users\\ze\\.gemini\\config\\mcp_config.json',
        'C:\\Users\\ze\\.gemini\\antigravity\\mcp_config.json',
      ],
      gemini: ['C:\\Users\\ze\\.gemini\\settings.json'],
    });
  });

  it('variáveis dos clientes: CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME', () => {
    const custom = paths({
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', COPILOT_HOME: '/p' },
      home: '/home/ze',
    });
    expect(custom['claude-code']).toEqual(['/c/.claude.json']);
    expect(custom.codex).toEqual(['/x/config.toml']);
    expect(custom.vscode?.[0]).toBe('/p/mcp-config.json');
  });
});
