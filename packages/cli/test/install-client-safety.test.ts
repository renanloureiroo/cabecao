// Regressão da revisão adversária do marco 1 em `install-client`: arquivo de configuração somente leitura (antes,
// era sobrescrito por cima da proteção) e entrada `cabecao` que apontava para OUTRO cérebro (antes, trocada em
// silêncio). Mesmo isolamento de install-client.test.ts: HOME, PATH e executor injetados, nada real é tocado.
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Location, Target } from '../src/install-client/clients.ts';
import { CLIENTS } from '../src/install-client/clients.ts';
import { tomlTable } from '../src/install-client/toml.ts';
import { run } from '../src/main.ts';
import type { Env, Exec, ExecResult } from '../src/types.ts';

const FAKE_NODE = '/opt/node-de-teste/bin/node';

interface Box {
  root: string;
  home: string;
  brain: string;
  bin: string;
  pathDir: string;
  env: Env;
  location: Location;
  calls: Array<{ file: string; args: readonly string[] }>;
  replies: ExecResult[];
  cabecao: (args: readonly string[]) => ReturnType<typeof run>;
}

let box: Box;

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cabecao-install-seg-')));
  const home = join(root, 'casa');
  const brain = join(root, 'meu cérebro');
  const pathDir = join(root, 'path');
  const bin = join(root, 'global', 'node_modules', 'cabecao', 'dist', 'cabecao.mjs');
  for (const dir of [home, brain, pathDir, dirname(bin)]) await mkdir(dir, { recursive: true });
  await writeFile(bin, '// bin de mentira\n');
  const env: Env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, 'appdata'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    CABECAO_CONFIG_DIR: join(root, 'config-cabecao'),
    PATH: pathDir,
  };
  const calls: Box['calls'] = [];
  const replies: ExecResult[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return replies.shift() ?? { code: 0, stdout: '', stderr: '' };
  };
  box = {
    root,
    home,
    brain,
    bin,
    pathDir,
    env,
    location: { platform: process.platform, env, home },
    calls,
    replies,
    cabecao: (args) =>
      run(['install-client', ...args], {
        env,
        cwd: root,
        platform: process.platform,
        homedir: home,
        execPath: FAKE_NODE,
        binPath: bin,
        exec,
      }),
  };
});

afterEach(async () => {
  await rm(box.root, { recursive: true, force: true });
});

function mainTarget(id: keyof typeof CLIENTS): Target {
  const [target] = CLIENTS[id].targets(box.location);
  if (target === undefined) throw new Error(`sem arquivo para ${id}`);
  return target;
}

/** Arquivo do cliente com uma entrada `cabecao` apontando para `brain`. */
function configWith(target: Target, brain: string, command = FAKE_NODE): string {
  const args = [box.bin, 'mcp', '--brain', brain];
  if (target.format === 'toml') return tomlTable(['mcp_servers', 'cabecao'], { command, args });
  const entry = target.section === 'servers' ? { type: 'stdio', command, args } : { command, args };
  return `${JSON.stringify({ [target.section]: { cabecao: entry } }, null, 2)}\n`;
}

const CLIENTS_BY_FILE = ['claude-desktop', 'codex', 'cursor', 'gemini'] as const;

describe.each(CLIENTS_BY_FILE)('%s', (id) => {
  it('arquivo somente leitura (0400): recusa com erro claro, código 1, e o arquivo fica como estava', async () => {
    const target = mainTarget(id);
    const original = configWith(target, join(box.root, 'outro cérebro'));
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, original);
    await chmod(target.path, 0o400);
    try {
      const result = await box.cabecao([id, '--brain', box.brain]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(target.path);
      expect(result.stderr).toContain('somente leitura');
      expect(await readFile(target.path, 'utf8')).toBe(original);
      expect(existsSync(`${target.path}.bak`)).toBe(false);
    } finally {
      await chmod(target.path, 0o600);
    }
  });

  it('entrada que apontava para outro cérebro: troca, mas avisa na saída o que havia antes', async () => {
    const target = mainTarget(id);
    const other = join(box.root, 'outro cérebro');
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, configWith(target, other));
    const result = await box.cabecao([id, '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('registro atualizado');
    expect(result.stdout).toContain('ATENÇÃO');
    expect(result.stdout).toContain(other);

    // em --json, o que havia vai no relatório do arquivo
    await writeFile(target.path, configWith(target, other));
    const json = JSON.parse((await box.cabecao([id, '--brain', box.brain, '--json'])).stdout);
    expect(json.data.clients[0].files[0].replaced).toMatchObject({ brain: other });
  });

  it('mesmo cérebro, só outro caminho do Node: atualiza sem o aviso', async () => {
    const target = mainTarget(id);
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, configWith(target, box.brain, '/outro/node'));
    const result = await box.cabecao([id, '--brain', box.brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('registro atualizado');
    expect(result.stdout).not.toContain('ATENÇÃO');
  });
});

describe('Claude Code pelo comando claude', () => {
  it('entrada antiga de outro cérebro: avisa na saída', async () => {
    const claude = join(box.pathDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    await writeFile(claude, '');
    await chmod(claude, 0o755);
    const target = mainTarget('claude-code');
    const other = join(box.root, 'outro cérebro');
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(
      target.path,
      `${JSON.stringify({ mcpServers: { cabecao: { type: 'stdio', command: FAKE_NODE, args: [box.bin, 'mcp', '--brain', other] } } })}\n`,
    );
    const result = await box.cabecao(['claude-code', '--brain', box.brain]);
    // no Windows sem `claude.exe` executável de verdade, o registro pode recuar para a edição do arquivo
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ATENÇÃO');
    expect(result.stdout).toContain(other);
  });
});
