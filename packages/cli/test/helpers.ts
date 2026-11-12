/**
 * Apoio dos testes dos comandos que mexem num cérebro de verdade: cópias de `fixtures/vault` em `os.tmpdir()`, cada
 * uma num repositório git próprio, remotos bare locais e um ambiente injetado (`HOME`, `USERPROFILE`, `APPDATA`,
 * `XDG_CONFIG_HOME`, `CABECAO_CONFIG_DIR`, `PATH`) todo apontando para pastas temporárias.
 *
 * O núcleo roda o git com o ambiente do processo; por isso o isolamento do git vai no `process.env` deste processo de
 * teste (`GIT_CONFIG_GLOBAL` temporário, `GIT_CONFIG_NOSYSTEM`). Os arquivos de teste rodam em processos separados
 * (`pool: 'forks'`), então isso não vaza para outros arquivos. Nenhum teste lê ou escreve em `~/cabecao`,
 * `~/.config/cabecao` ou na configuração real dos clientes de IA, e nenhum executa o `claude`: o `PATH` injetado é
 * uma pasta vazia e o executor de comandos é um falso que só registra as chamadas.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brain } from '@cabecao/core';
import { openBrain, runGit } from '@cabecao/core';
import type { CliResult, RunOptions } from '../src/main.ts';
import { run } from '../src/main.ts';
import type { CliIo, Env, Exec, ExecResult } from '../src/types.ts';

/** Muitos processos git por teste; no Windows cada um custa dezenas de milissegundos. */
export const TEST_TIMEOUT_MS = 120_000;

export const FIXTURE_VAULT = fileURLToPath(new URL('../../../fixtures/vault', import.meta.url));

/** Pasta temporária do arquivo de teste inteiro, com espaço e acento no nome de propósito. */
export const SANDBOX = realpathSync.native(mkdtempSync(join(tmpdir(), 'cabeção cli ')));

const gitconfig = join(SANDBOX, 'gitconfig');
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
// Só vale para o que o núcleo resolve sozinho, sem receber o ambiente injetado; os comandos usam o de cada máquina.
process.env.CABECAO_CONFIG_DIR = join(SANDBOX, 'config do processo');

let counter = 0;

/** Uma pasta nova dentro da caixa de areia. */
export function freshDir(name: string): string {
  const dir = join(SANDBOX, `${++counter} ${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd })).stdout.trimEnd();
}

/** Uma "máquina": pasta do usuário, configuração do Cabeção e `PATH`, todos temporários. */
export interface Machine {
  readonly home: string;
  readonly configDir: string;
  readonly pathDir: string;
  readonly env: Env;
  readonly calls: Array<{ file: string; args: readonly string[] }>;
  readonly replies: ExecResult[];
  readonly exec: Exec;
  /** O que um comando enxerga do processo nesta máquina, para chamar as funções internas direto. */
  readonly io: Pick<CliIo, 'env' | 'platform' | 'homedir' | 'execPath' | 'binPath' | 'exec' | 'stderr'>;
  /** Roda a CLI nesta máquina (o `cwd` padrão é a pasta do usuário). */
  cabecao(args: readonly string[], extra?: Partial<RunOptions>): Promise<CliResult>;
}

export function machine(name = 'maquina'): Machine {
  const root = freshDir(name);
  const home = join(root, 'casa');
  const configDir = join(root, 'config-cabecao');
  const pathDir = join(root, 'path');
  mkdirSync(home, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  const env: Env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    CABECAO_CONFIG_DIR: configDir,
    PATH: pathDir,
  };
  const calls: Machine['calls'] = [];
  const replies: ExecResult[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return replies.shift() ?? { code: 0, stdout: '', stderr: '' };
  };
  return {
    home,
    configDir,
    pathDir,
    env,
    calls,
    replies,
    exec,
    io: {
      env,
      platform: process.platform,
      homedir: home,
      execPath: process.execPath,
      exec,
      stderr: { write: () => true },
    },
    cabecao: (args, extra = {}) =>
      run(args, {
        env,
        cwd: home,
        platform: process.platform,
        homedir: home,
        execPath: process.execPath,
        exec,
        ...extra,
      }),
  };
}

/** Cópia do cérebro de exemplo num repositório com um commit inicial. */
export async function brainRepo(name = 'cerebro'): Promise<string> {
  const dir = join(freshDir(name), name);
  await cp(FIXTURE_VAULT, dir, { recursive: true });
  await runGit(['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'início']);
  return dir;
}

/** Remoto bare vazio. */
export async function bareRemote(name = 'remoto.git'): Promise<string> {
  const path = join(freshDir('remoto'), name);
  await runGit(['init', '--bare', '--quiet', '--initial-branch=main', path]);
  return path;
}

/** Cérebro de exemplo com um remoto bare e um segundo clone, como duas máquinas. */
export async function twoClones(): Promise<{ a: string; b: string; remote: string }> {
  const a = await brainRepo('a');
  const remote = await bareRemote();
  await git(a, ['remote', 'add', 'origin', remote]);
  await git(a, ['push', '--quiet', '-u', 'origin', 'main']);
  const b = join(dirname(a), 'b');
  await runGit(['clone', '--quiet', remote, b], { cwd: dirname(a) });
  return { a, b, remote };
}

export async function writeNote(root: string, rel: string, content: string): Promise<void> {
  const path = join(root, ...rel.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function readNote(root: string, rel: string): Promise<string> {
  return readFile(join(root, ...rel.split('/')), 'utf8');
}

/** Nota no formato que o Obsidian gravaria, com frontmatter mínimo. */
export function obsidianNote(title: string, body: string): string {
  return `---\ntype: concept\ntitle: ${title}\n---\n${body}\n`;
}

const opened: Brain[] = [];

/** Abre o cérebro como um agente (para criar operações que o `undo` desfaz). Fechado em `closeOpened`. */
export async function openAsAgent(root: string): Promise<Brain> {
  const brain = await openBrain(root, { client: 'teste', machine: 'maquina-teste' });
  opened.push(brain);
  return brain;
}

export async function closeOpened(): Promise<void> {
  for (const brain of opened.splice(0)) await brain.close();
}

/** Apaga a caixa de areia (no `afterAll`, depois de fechar os cérebros). */
export function disposeSandbox(): void {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Saída de `--json` como os testes leem: os campos de `data` e `error` são conferidos um a um. */
export interface JsonOutput {
  ok: boolean;
  command: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: o formato de `data` varia por comando e cada teste confere o seu
  data: any;
  // biome-ignore lint/suspicious/noExplicitAny: idem
  error?: any;
}

/** Lê o JSON de `--json`. */
export function parseJson(result: CliResult): JsonOutput {
  return JSON.parse(result.stdout) as JsonOutput;
}
