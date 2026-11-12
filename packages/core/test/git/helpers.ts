/** Apoio aos testes da camada de git: repositórios temporários reais, sem tocar na configuração global. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatCommitMessage } from '../../src/git/commit-message.ts';
import { runGit } from '../../src/git/run.ts';

/** Os testes criam vários processos git; no Windows cada um custa dezenas de milissegundos. */
export const TEST_TIMEOUT_MS = 60_000;

export const SESSION_A = '01JD3K7M2A8B4C6D9E1F3G5H7J';
export const SESSION_B = '01JD4ZZZZA8B4C6D9E1F3G5H7J';

export interface Sandbox {
  /** Pasta temporária, com espaço e acento no nome de propósito. */
  root: string;
  /** Cria um repositório com identidade e assinatura configuradas só nele. */
  initRepo(name: string, branch?: string): Promise<string>;
  /** Cria um repositório sem pasta de trabalho, para servir de remoto. */
  initBare(name: string, branch?: string): Promise<string>;
  cleanup(): void;
}

export async function configureRepo(repo: string): Promise<void> {
  const settings: [string, string][] = [
    ['user.name', 'Teste Cabeção'],
    ['user.email', 'teste@cabecao.invalid'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ];
  for (const [key, value] of settings) await runGit(['config', '--local', key, value], { cwd: repo });
}

export function createSandbox(): Sandbox {
  // `realpath` desfaz o /var -> /private/var do macOS e os nomes curtos (RUNNER~1) do Windows.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cabeção git ')));
  return {
    root,
    async initRepo(name, branch = 'main') {
      const repo = join(root, name);
      mkdirSync(repo, { recursive: true });
      await runGit(['-c', `init.defaultBranch=${branch}`, 'init', `--initial-branch=${branch}`], { cwd: repo });
      await configureRepo(repo);
      return repo;
    },
    async initBare(name, branch = 'main') {
      const bare = join(root, name);
      await runGit(['-c', `init.defaultBranch=${branch}`, 'init', '--bare', `--initial-branch=${branch}`, bare], {
        cwd: root,
      });
      return bare;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export function write(repo: string, path: string, content: string): void {
  const file = join(repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

/** Mensagem no padrão do projeto, com identificadores fixos. */
export function message(op: string, extra: { session?: string; reverts?: string | string[] } = {}): string {
  return formatCommitMessage({
    date: new Date(2026, 10, 12, 14, 32, 10, 482),
    body: [{ action: 'add', noteType: 'fact', title: `nota da operação ${op}` }],
    trailers: { op, machine: 'macbook', client: 'cli', ...extra },
  });
}

/** Saída de um comando git no repositório, sem a quebra de linha final. */
export async function out(repo: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd: repo })).stdout.trimEnd();
}
