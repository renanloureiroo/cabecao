/**
 * Apoio dos testes do sync: um remoto bare local e "máquinas" que são clones dele, tudo em `os.tmpdir()`. Nenhum
 * teste toca na configuração global do git: identidade, assinatura e fim de linha ficam no repositório.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../../src/git/index.ts';
import { type SyncOptions, type SyncResult, syncBrain } from '../../src/sync/index.ts';

/** Muitos processos git por teste; no Windows cada um custa dezenas de milissegundos. */
export const TEST_TIMEOUT_MS = 60_000;

const LOCAL_CONFIG: [string, string][] = [
  ['user.name', 'Teste Cabeção'],
  ['user.email', 'teste@cabecao.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['core.autocrlf', 'false'],
  // nenhum gerenciador de credenciais do sistema entra nos testes
  ['credential.helper', ''],
];

export const BRAIN_CONFIG = `${JSON.stringify({ schemaVersion: 1, noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' }, null, 2)}\n`;

export function note(title: string, extra = ''): string {
  return `---\ntype: fact\ntags: [a]\nstatus: rascunho\n---\n# ${title}\n\nPrimeiro parágrafo original.\n\nSegundo parágrafo original.\n\nTerceiro parágrafo original.\n${extra}`;
}

export async function git(dir: string, args: string[], input?: string): Promise<string> {
  return (await runGit(args, { cwd: dir, ...(input === undefined ? {} : { input }) })).stdout.trimEnd();
}

export function write(dir: string, path: string, content: string | Buffer): void {
  const file = join(dir, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function read(dir: string, path: string): string {
  return readFileSync(join(dir, ...path.split('/')), 'utf8');
}

export function exists(dir: string, path: string): boolean {
  return existsSync(join(dir, ...path.split('/')));
}

export function remove(dir: string, path: string): void {
  rmSync(join(dir, ...path.split('/')), { force: true });
}

/** Todos os arquivos versionáveis de uma pasta do cérebro, com conteúdo (para conferir que nada se perdeu). */
export function snapshot(dir: string, sub = 'wiki'): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    const abs = join(dir, ...rel.split('/'));
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else out.set(child, read(dir, child));
    }
  };
  walk(sub);
  return out;
}

/** O conteúdo aparece, byte a byte, em algum arquivo da pasta. */
export function contentKept(dir: string, content: string, sub = 'wiki'): boolean {
  return [...snapshot(dir, sub).values()].includes(content);
}

export async function head(dir: string): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Sem mudança pendente, sem diário, sem trava e sem operação do git pela metade. */
export async function leftovers(dir: string): Promise<string[]> {
  const found: string[] = [];
  const status = await git(dir, ['status', '--porcelain']);
  if (status !== '') found.push(`status: ${status}`);
  for (const path of [
    '.cabecao/sync/journal.json',
    '.cabecao/locks/sync.lock',
    '.cabecao/locks/worktree.lock',
    '.git/index.lock',
    '.git/MERGE_HEAD',
    '.git/rebase-merge',
  ]) {
    if (exists(dir, path)) found.push(path);
  }
  return found;
}

export interface Machine {
  readonly name: string;
  readonly dir: string;
  sync(options?: SyncOptions): Promise<SyncResult>;
}

export interface World {
  readonly root: string;
  readonly remote: string;
  /** Cria uma máquina nova clonando o remoto. */
  clone(name: string): Promise<Machine>;
  machine(name: string, dir: string): Machine;
  cleanup(): void;
}

export function machineOf(name: string, dir: string): Machine {
  return {
    name,
    dir,
    sync: (options = {}) =>
      syncBrain(dir, { machine: name, client: 'cli', staleGitLockMs: 2_000, networkTimeoutMs: 20_000, ...options }),
  };
}

/** Grava a configuração local direto no `.git/config` (um processo git a menos por chave). */
export function configureLocal(dir: string): void {
  const sections = new Map<string, string[]>();
  for (const [key, value] of LOCAL_CONFIG) {
    const dot = key.indexOf('.');
    const lines = sections.get(key.slice(0, dot)) ?? [];
    lines.push(`\t${key.slice(dot + 1)} = ${value === '' ? '""' : `"${value}"`}`);
    sections.set(key.slice(0, dot), lines);
  }
  const text = [...sections].map(([section, lines]) => `[${section}]\n${lines.join('\n')}\n`).join('');
  appendFileSync(join(dir, '.git', 'config'), text);
}

/**
 * Remoto bare e a primeira máquina (`a`), que cria o cérebro, faz o primeiro commit e o primeiro sync. As demais
 * máquinas entram com `clone`.
 */
export async function createWorld(
  options: { branch?: string; files?: Record<string, string>; seed?: boolean } = {},
): Promise<{ world: World; a: Machine }> {
  const branch = options.branch ?? 'main';
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cabeção sync ')));
  const remote = join(root, 'remote.git');
  await runGit([
    '-c',
    `init.defaultBranch=${branch}`,
    'init',
    '--bare',
    '--quiet',
    `--initial-branch=${branch}`,
    remote,
  ]);
  const world: World = {
    root,
    remote,
    async clone(name) {
      const dir = join(root, name);
      const config = LOCAL_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
      await runGit(['clone', '--quiet', ...config, remote, dir], { cwd: root });
      return machineOf(name, dir);
    },
    machine: machineOf,
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  const dir = join(root, 'a');
  mkdirSync(dir);
  await runGit(['-c', `init.defaultBranch=${branch}`, 'init', '--quiet', `--initial-branch=${branch}`], { cwd: dir });
  configureLocal(dir);
  const files = options.files ?? {
    'wiki/x.md': note('Nota X'),
    'wiki/y.md': note('Nota Y'),
    'memory/z.md': note('Nota Z'),
  };
  write(dir, '.cabecao.json', BRAIN_CONFIG);
  write(dir, '.gitignore', '.cabecao/\n');
  write(dir, '.gitattributes', 'log.md merge=union\n');
  write(dir, 'log.md', '# Diário\n\n- 2026-11-01 · add fact: início\n');
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'início']);
  await git(dir, ['remote', 'add', 'origin', remote]);
  await git(dir, ['push', '--quiet', '-u', 'origin', branch]);
  const a = machineOf('a', dir);
  if (options.seed !== false) {
    const first = await a.sync();
    if (first.status !== 'ok') throw new Error(`primeiro sync falhou: ${first.message}`);
  }
  return { world, a };
}

/** Os scripts de apoio importam o TypeScript direto; no Node 22.16 e 22.17 isso pede a opção abaixo. */
const TYPE_FLAGS = process.features.typescript ? [] : ['--experimental-strip-types'];

export function spawnSyncChild(args: string[]): ChildProcess {
  const script = fileURLToPath(new URL('sync-child.mjs', import.meta.url));
  return spawn(process.execPath, ['--no-warnings', ...TYPE_FLAGS, script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function waitChild(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
