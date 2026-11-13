/**
 * Apoio dos testes da camada de operações: cópias do cérebro de exemplo (`fixtures/vault`) em `os.tmpdir()`, cada uma
 * num repositório git próprio, com o git isolado da configuração real.
 *
 * `GIT_CONFIG_GLOBAL` aponta para um arquivo temporário (identidade, sem assinatura, sem conversão de fim de linha),
 * `GIT_CONFIG_NOSYSTEM` desliga a configuração do sistema e `CABECAO_CONFIG_DIR` isola a configuração da máquina. Os
 * arquivos de teste rodam em processos separados (`pool: 'forks'`), então mexer no `process.env` aqui não afeta
 * outros arquivos; os processos filhos herdam o mesmo isolamento.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brain, OpenBrainOptions } from '../../src/brain/index.ts';
import { BrainError, openBrain } from '../../src/brain/index.ts';
import { runGit } from '../../src/git/index.ts';

/** Muitos processos git por teste; no Windows cada um custa dezenas de milissegundos. */
export const TEST_TIMEOUT_MS = 120_000;

export const FIXTURE_VAULT = fileURLToPath(new URL('../../../../fixtures/vault', import.meta.url));

/** "Hoje" fixo dos testes: o handoff do cérebro de exemplo vence em 2026-12-10. */
export const TODAY = new Date(2026, 10, 12, 14, 32, 10, 482);

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'cabeção brain ')));
const gitconfig = join(sandbox, 'gitconfig');
writeFileSync(
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
    '[credential]',
    '\thelper = ',
    '',
  ].join('\n'),
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CABECAO_CONFIG_DIR = join(sandbox, 'config da máquina');

/** Configuração local do repositório (também vale para os processos filhos, que leem o `.git/config`). */
function configureLocal(dir: string): void {
  appendFileSync(
    join(dir, '.git', 'config'),
    '[user]\n\tname = "Teste Cabeção"\n\temail = "teste@cabecao.invalid"\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
}

export async function git(dir: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd: dir })).stdout.trimEnd();
}

export interface TestBrain {
  /** Pasta do cérebro (repositório git). */
  readonly dir: string;
  readonly brains: Brain[];
  open(options?: Partial<OpenBrainOptions>): Promise<Brain>;
}

let counter = 0;

/** Cérebros abertos por teste; `cleanupAll` fecha todos e apaga as pastas (no Windows, fechar vem antes). */
const opened: Brain[] = [];
const dirs: string[] = [];

export function openTest(dir: string, options: Partial<OpenBrainOptions> = {}): Promise<Brain> {
  return openBrain(dir, { client: 'teste', machine: 'maquina-a', now: () => TODAY, ...options }).then((brain) => {
    opened.push(brain);
    return brain;
  });
}

/** Cópia do cérebro de exemplo, num repositório com um commit inicial (sem rodapés do Cabeção). */
export async function createBrainRepo(name = 'a'): Promise<string> {
  const parent = join(sandbox, `caso ${++counter}`);
  mkdirSync(parent, { recursive: true });
  dirs.push(parent);
  const dir = join(parent, name);
  await cp(FIXTURE_VAULT, dir, { recursive: true });
  await runGit(['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  configureLocal(dir);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'início']);
  return dir;
}

/** Remoto bare com o cérebro de exemplo e dois clones (`a` e `b`), como duas máquinas. */
export async function createTwoMachines(): Promise<{ a: string; b: string; remote: string }> {
  const a = await createBrainRepo('a');
  const parent = join(a, '..');
  const remote = join(parent, 'remoto.git');
  await runGit(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  await git(a, ['remote', 'add', 'origin', remote]);
  await git(a, ['push', '--quiet', '-u', 'origin', 'main']);
  const b = join(parent, 'b');
  await runGit(['clone', '--quiet', remote, b], { cwd: parent });
  configureLocal(b);
  return { a, b, remote };
}

export async function cleanupAll(): Promise<void> {
  for (const brain of opened.splice(0)) await brain.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Todos os arquivos do cérebro fora de `.git/` e `.cabecao/`, com o conteúdo em bytes. */
export async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (child === '.git' || child === '.cabecao') continue;
      if (entry.isDirectory()) await walk(child);
      else out.set(child, (await readFile(join(dir, ...child.split('/')))).toString('base64'));
    }
  };
  await walk('');
  return out;
}

export async function readText(dir: string, path: string): Promise<string> {
  return readFile(join(dir, ...path.split('/')), 'utf8');
}

export async function head(dir: string): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD']);
}

export async function commitCount(dir: string): Promise<number> {
  return Number(await git(dir, ['rev-list', '--count', 'HEAD']));
}

/** Arquivos de um commit. */
export async function commitFiles(dir: string, sha: string): Promise<string[]> {
  const out = await git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha]);
  return out.split('\0').filter(Boolean).sort();
}

export async function commitMessageOf(dir: string, sha = 'HEAD'): Promise<string> {
  return git(dir, ['log', '-1', '--format=%B', sha]);
}

export async function porcelain(dir: string): Promise<string> {
  return git(dir, ['status', '--porcelain', '--untracked-files=all']);
}

/** Os scripts filhos importam o TypeScript direto; no Node 22.16 e 22.17 isso pede a opção abaixo. */
const TYPE_FLAGS = process.features.typescript ? [] : ['--experimental-strip-types'];

export function spawnBrainChild(args: string[]): ChildProcess {
  const script = fileURLToPath(new URL('brain-child.mjs', import.meta.url));
  return spawn(process.execPath, ['--no-warnings', ...TYPE_FLAGS, script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function waitChild(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Apaga a pasta temporária inteira (chame no `afterAll`, depois de `cleanupAll`). */
export function disposeSandbox(): void {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * Ação elevada (decisão 37) sem confirmação: ou volta `confirmation_required` (nada foi feito), ou é recusada com um
 * `BrainError` por outro motivo. Devolve o status ou o código do erro; falha o teste se a ação EXECUTOU.
 */
export async function notExecuted(promise: Promise<unknown>): Promise<string> {
  let out: { status?: unknown; changed?: unknown; commit?: unknown };
  try {
    out = (await promise) as typeof out;
  } catch (error) {
    if (error instanceof BrainError) return error.code;
    throw error;
  }
  if (out.status === 'confirmation_required' && out.changed !== true && (out.commit ?? null) === null) {
    return 'confirmation_required';
  }
  throw new Error(`a ação deveria ter ficado pendente: ${JSON.stringify(out).slice(0, 400)}`);
}

/** O `confirm_token` de uma resposta `confirmation_required`. */
export function tokenOf(out: { confirm_token?: string | null | undefined }): string {
  if (typeof out.confirm_token !== 'string') throw new Error('a resposta não trouxe confirm_token');
  return out.confirm_token;
}
