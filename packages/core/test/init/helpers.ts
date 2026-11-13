/**
 * Apoio aos testes do `init`: remotos bare e clones em `os.tmpdir()`, com o git isolado da configuração real.
 *
 * `GIT_CONFIG_GLOBAL` aponta para um arquivo temporário (identidade, sem assinatura, sem conversão de fim de linha) e
 * `GIT_CONFIG_NOSYSTEM` desliga a do sistema; `CABECAO_CONFIG_DIR` isola a configuração da máquina. Os testes rodam
 * em processos separados (`pool: 'forks'`), então mexer no `process.env` aqui não afeta outros arquivos.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../../src/git/index.ts';

/** Clonar, enviar e criar repositórios custa dezenas de processos git; no Windows cada um é lento. */
export const TEST_TIMEOUT_MS = 120_000;

export const FIXTURE_VAULT = fileURLToPath(new URL('../../../../fixtures/vault', import.meta.url));
export const TEMPLATE_VAULT = fileURLToPath(new URL('../../../../templates/vault', import.meta.url));

const ISOLATED_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CABECAO_CONFIG_DIR'] as const;

export interface Sandbox {
  /** Pasta temporária, com espaço e acento no nome de propósito. */
  readonly root: string;
  /** Pasta da configuração da máquina (`CABECAO_CONFIG_DIR`). */
  readonly configDir: string;
  path(...parts: string[]): string;
  /** Remoto bare vazio cujo `HEAD` aponta para `branch`. */
  bare(name: string, branch?: string): Promise<string>;
  /** Remoto bare com um commit contendo `files`, na branch `branch` (que vira a padrão). */
  seed(name: string, branch: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<string>;
  cleanup(): Promise<void>;
}

export function removeTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export async function writeFiles(dir: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd })).stdout.trimEnd();
}

/** Cria a pasta temporária e isola o git e a configuração da máquina. Chame `cleanup` no `afterAll`. */
export async function createSandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cabeção init ')));
  const saved = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]));
  const gitconfig = join(root, 'gitconfig');
  await writeFile(
    gitconfig,
    [
      '[user]',
      '\tname = Teste Cabeção',
      '\temail = teste@cabecao.invalid',
      '[commit]',
      '\tgpgsign = false',
      '[tag]',
      '\tgpgsign = false',
      '[core]',
      '\tautocrlf = false',
      '[init]',
      '\tdefaultBranch = main',
      '',
    ].join('\n'),
  );
  const configDir = join(root, 'config da máquina');
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.CABECAO_CONFIG_DIR = configDir;

  let counter = 0;
  const sandbox: Sandbox = {
    root,
    configDir,
    path: (...parts) => join(root, ...parts),
    async bare(name, branch = 'main') {
      const path = join(root, name);
      await runGit(['init', '--quiet', '--bare', `--initial-branch=${branch}`, path], { cwd: root });
      return path;
    },
    async seed(name, branch, files) {
      const bare = await sandbox.bare(name, branch);
      counter += 1;
      const work = join(root, `semente ${counter}`);
      await mkdir(work);
      await runGit(['init', '--quiet', `--initial-branch=${branch}`], { cwd: work });
      await writeFiles(work, files);
      await runGit(['add', '-A'], { cwd: work });
      await runGit(['commit', '--quiet', '-m', 'conteúdo existente'], { cwd: work });
      await runGit(['push', '--quiet', bare, `${branch}:${branch}`], { cwd: work });
      await removeTree(work);
      return bare;
    },
    async cleanup() {
      for (const key of ISOLATED_ENV) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await removeTree(root);
    },
  };
  return sandbox;
}

/** Todos os arquivos de uma pasta (fora `.git/`), com caminho relativo em `/`, e seus bytes. */
export async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const rel = relative(dir, full).split(sep).join('/');
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    out.set(rel.normalize('NFC'), await readFile(full));
  }
  return out;
}

/** `caminho → modo e blob` de um commit, para conferir que nada mudou de lugar nem de conteúdo. */
export async function treeEntries(repo: string, ref: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const stdout = (await runGit(['ls-tree', '-r', '-z', ref], { cwd: repo })).stdout;
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    out.set(record.slice(tab + 1), record.slice(0, tab));
  }
  return out;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Copia partes do cérebro de exemplo para `dest` (nada é escrito em `fixtures/`). */
export async function copyFixtureParts(dest: string, parts: readonly string[]): Promise<void> {
  for (const part of parts) {
    await cp(join(FIXTURE_VAULT, ...part.split('/')), join(dest, ...part.split('/')), { recursive: true });
  }
}
