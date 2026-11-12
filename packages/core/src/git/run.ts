/**
 * Execução do binário `git` do usuário, sempre sem terminal.
 *
 * O Cabeção roda como processo filho de um cliente MCP, de um hook ou do agendador: não há ninguém para digitar
 * usuário, senha ou frase da chave. Por isso todo comando sai com um ambiente que impede qualquer pergunta; a
 * credencial ausente vira erro imediato em vez de processo parado.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { GitError } from './errors.ts';

/** Tempo limite padrão de um comando, em milissegundos. */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export interface RunGitOptions {
  /** Pasta onde o git roda. Padrão: a pasta atual do processo. */
  cwd?: string;
  /** Conteúdo enviado à entrada padrão. Sem ele, a entrada padrão fica fechada. */
  input?: string | Uint8Array;
  /** Tempo limite em milissegundos; `0` desliga. Padrão: {@link DEFAULT_GIT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Variáveis somadas ao ambiente do processo; `undefined` remove a variável. As de não interação sempre vencem. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Devolve o resultado mesmo com código de saída diferente de zero. Tempo limite e falha ao iniciar ainda lançam. */
  allowFailure?: boolean;
}

export interface GitResult {
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Variáveis que impedem o git de perguntar qualquer coisa.
 *
 * - `GIT_TERMINAL_PROMPT=0`: o git não pede usuário nem senha no terminal.
 * - `GIT_ASKPASS=''`: valor vazio, e não um programa como `true`, porque não existe um `true` garantido no
 *   Windows. O git trata a variável vazia como "sem programa de senha" e, por ela estar definida, também não
 *   cai para `core.askPass` nem para `SSH_ASKPASS`.
 * - `SSH_ASKPASS=''` e `SSH_ASKPASS_REQUIRE=never`: o ssh não abre janela de senha.
 * - `GCM_INTERACTIVE=never`: o Git Credential Manager (padrão no Windows) não abre janela.
 * - `GIT_EDITOR=:`: nenhum comando abre editor.
 * - `GIT_OPTIONAL_LOCKS=0`: comandos de leitura não disputam o `index.lock` com o Obsidian Git ou outro cliente.
 * - `LC_ALL=C`: mensagens em inglês e estáveis, das quais a classificação de erros depende.
 */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  SSH_ASKPASS_REQUIRE: 'never',
  GCM_INTERACTIVE: 'never',
  GIT_EDITOR: ':',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

const BATCH_MODE = '-o BatchMode=yes';
const DEFAULT_SSH_COMMAND = `ssh ${BATCH_MODE}`;

/** Subcomandos que podem abrir conexão com um remoto. */
const NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule', 'archive']);
/** Opções globais do git cujo valor vem no argumento seguinte. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
  '--attr-source',
]);

/** Primeiro argumento que não é opção global: o subcomando (`fetch`, `commit`...). */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('-')) return arg;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) i++;
  }
  return undefined;
}

function isOpenSsh(command: string): boolean {
  const first = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const program = first?.[1] ?? first?.[2] ?? first?.[3] ?? '';
  const base = program.split(/[\\/]/).pop() ?? '';
  return /^ssh(\.exe)?$/i.test(base);
}

/**
 * Decide o valor de `GIT_SSH_COMMAND`, preservando o comando ssh que o usuário já configurou.
 *
 * O git escolhe o ssh nesta ordem: `GIT_SSH_COMMAND`, `core.sshCommand`, `GIT_SSH`, `ssh`. Definir a variável
 * às cegas apagaria um `core.sshCommand` (por exemplo `ssh -i ~/.ssh/chave_do_cerebro`) e quebraria a
 * autenticação de quem depende dele. A regra:
 *
 * 1. Parte do comando do usuário: a variável de ambiente, senão `core.sshCommand`.
 * 2. Se o programa é o OpenSSH (`ssh` ou `ssh.exe`), acrescenta `-o BatchMode=yes` ao fim, a menos que o comando
 *    já fale em `BatchMode`.
 * 3. Se é outro programa (plink, um script), o comando fica como está: não há como saber se ele aceita `-o`.
 * 4. Sem comando do usuário, usa `ssh -o BatchMode=yes`; mas se existir `GIT_SSH` (que aponta um programa e não
 *    aceita argumentos), nada é definido, para não passar por cima dele.
 *
 * Devolve `undefined` quando a variável não deve ser definida. Nos casos 3 e 4 (com `GIT_SSH`) o modo sem
 * perguntas depende só de `SSH_ASKPASS` neutro e do tempo limite.
 */
export function resolveSshCommand(sources: {
  envCommand?: string | undefined;
  configCommand?: string | undefined;
  envGitSsh?: string | undefined;
}): string | undefined {
  const user = sources.envCommand?.trim() || sources.configCommand?.trim();
  if (!user) return sources.envGitSsh?.trim() ? undefined : DEFAULT_SSH_COMMAND;
  if (/batchmode/i.test(user) || !isOpenSsh(user)) return user;
  return `${user} ${BATCH_MODE}`;
}

/** No Windows o nome com extensão evita que um `git.cmd` ou `git.bat` do PATH seja escolhido (exigiriam shell). */
function gitBinary(): string {
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

function mergeEnv(extra: RunGitOptions['env']): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Ambiente com que `runGit` executaria estes argumentos: o do processo, mais `options.env`, mais o modo sem
 * perguntas. Exposto para diagnóstico (`doctor`) e para os testes.
 */
export async function buildGitEnv(
  args: readonly string[],
  options: Pick<RunGitOptions, 'cwd' | 'env'> = {},
): Promise<Record<string, string | undefined>> {
  const env = mergeEnv(options.env);
  const envCommand = env.GIT_SSH_COMMAND;
  const subcommand = gitSubcommand(args);
  let configCommand: string | undefined;
  // `core.sshCommand` só é consultado (um `git config` a mais) em comandos que falam com o remoto. Nos demais o
  // ssh nunca é chamado; o padrão fica definido só como proteção, caso a lista de subcomandos esteja incompleta.
  if (!envCommand?.trim() && subcommand !== undefined && NETWORK_SUBCOMMANDS.has(subcommand)) {
    const lookup = await spawnGit(
      ['config', '--get', 'core.sshCommand'],
      { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: 10_000, allowFailure: true },
      { ...env, ...NON_INTERACTIVE_ENV },
    );
    if (lookup.exitCode === 0) configCommand = lookup.stdout.trim();
  }
  const sshCommand = resolveSshCommand({ envCommand, configCommand, envGitSsh: env.GIT_SSH });
  if (sshCommand === undefined) delete env.GIT_SSH_COMMAND;
  else env.GIT_SSH_COMMAND = sshCommand;
  return { ...env, ...NON_INTERACTIVE_ENV };
}

/** Mata o git e o que ele tiver iniciado. No Windows, `kill` sozinho deixaria o ssh ou o auxiliar de http vivos. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => {});
  }
  child.kill('SIGKILL');
}

function spawnGit(
  args: readonly string[],
  options: Pick<RunGitOptions, 'cwd' | 'input' | 'timeoutMs' | 'allowFailure'>,
  env: Record<string, string | undefined>,
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // Sem shell: os argumentos chegam ao git como estão, com espaços, acentos e aspas, em qualquer sistema.
    const child = spawn(gitBinary(), [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (cause: NodeJS.ErrnoException) => {
      settle(() => {
        const missingDir = options.cwd !== undefined && !existsSync(options.cwd);
        const summary = missingDir
          ? `a pasta não existe: ${options.cwd}`
          : cause.code === 'ENOENT'
            ? 'o programa git não foi encontrado no PATH; o Cabeção precisa do git instalado'
            : `não foi possível iniciar o git: ${cause.message}`;
        reject(new GitError({ args, exitCode: null, stdout: text(stdout), stderr: text(stderr), summary, cause }));
      });
    });
    child.on('close', (code, signal) => {
      settle(() => {
        const result: GitResult = { args: [...args], exitCode: code ?? -1, stdout: text(stdout), stderr: text(stderr) };
        if (code === 0 || (code !== null && options.allowFailure)) resolve(result);
        else reject(new GitError({ args, exitCode: code, signal, stdout: result.stdout, stderr: result.stderr }));
      });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // A promessa é encerrada aqui, sem esperar o `close`: um processo neto (ssh, auxiliar de http) pode
        // continuar segurando a saída aberta, e o `close` nunca chegaria.
        settle(() => {
          killTree(child);
          child.stdout?.destroy();
          child.stderr?.destroy();
          const partial = text(stderr);
          reject(
            new GitError({
              args,
              exitCode: null,
              signal: 'SIGKILL',
              stdout: text(stdout),
              stderr: `${partial}${partial && !partial.endsWith('\n') ? '\n' : ''}cabecao: operation timed out after ${timeoutMs} ms`,
              timedOut: true,
            }),
          );
        });
      }, timeoutMs);
    }
    if (options.input !== undefined && child.stdin) {
      // Um git que sai antes de ler a entrada fecha o cano; o erro que importa é o do código de saída.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
  });
}

/**
 * Executa `git` com os argumentos dados, sem shell e sem interação, e devolve a saída.
 *
 * Lança {@link GitError} quando o código de saída não é zero (a menos de `allowFailure`), quando o tempo limite
 * estoura ou quando o git não pôde ser iniciado.
 */
export async function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<GitResult> {
  return spawnGit(args, options, await buildGitEnv(args, options));
}

/** Opções comuns às operações de alto nível. */
export type GitOpOptions = Pick<RunGitOptions, 'env' | 'timeoutMs'>;

export interface GitVersion {
  /** Saída completa de `git --version`. */
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

/**
 * Versão mínima do git. A 2.38 trouxe o `git merge-tree --write-tree`, que a integração em memória usa.
 */
export const MIN_GIT_VERSION = { major: 2, minor: 38 } as const;

/** O git instalado é mais antigo que o mínimo, ou a versão não pôde ser lida. */
export class GitVersionError extends Error {
  override readonly name = 'GitVersionError';
  readonly found: GitVersion | null;

  constructor(message: string, found: GitVersion | null) {
    super(message);
    this.found = found;
  }
}

/** Lê a versão de textos como `git version 2.54.0 (Apple Git-157)` e `git version 2.45.1.windows.1`. */
export function parseGitVersion(text: string): GitVersion | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return { raw: text.trim(), major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

/** Versão do git instalado. */
export async function gitVersion(options: GitOpOptions = {}): Promise<GitVersion> {
  const { stdout } = await runGit(['--version'], options);
  const version = parseGitVersion(stdout);
  if (!version) throw new GitVersionError(`Não foi possível ler a versão do git em "${stdout.trim()}".`, null);
  return version;
}

/** `true` quando a versão atende ao mínimo. */
export function isGitVersionSupported(
  version: Pick<GitVersion, 'major' | 'minor'>,
  minimum: { major: number; minor: number } = MIN_GIT_VERSION,
): boolean {
  return version.major > minimum.major || (version.major === minimum.major && version.minor >= minimum.minor);
}

/** Lança {@link GitVersionError}, com uma mensagem que diz o que fazer, se a versão for mais antiga que o mínimo. */
export function ensureGitVersionSupported(version: GitVersion): void {
  if (isGitVersionSupported(version)) return;
  const found = `${version.major}.${version.minor}.${version.patch}`;
  throw new GitVersionError(
    `O Cabeção precisa do git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} ou mais novo, e o instalado é o ${found}. Atualize o git e tente de novo.`,
    version,
  );
}

/** Lê a versão do git instalado, confere o mínimo e a devolve. */
export async function assertGitVersion(options: GitOpOptions = {}): Promise<GitVersion> {
  const version = await gitVersion(options);
  ensureGitVersionSupported(version);
  return version;
}
