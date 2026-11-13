import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitError } from '../../src/git/errors.ts';
import {
  assertGitVersion,
  buildGitEnv,
  ensureGitVersionSupported,
  GitVersionError,
  gitSubcommand,
  gitVersion,
  isGitVersionSupported,
  NON_INTERACTIVE_ENV,
  parseGitVersion,
  resolveSshCommand,
  runGit,
} from '../../src/git/run.ts';
import { createSandbox, type Sandbox, TEST_TIMEOUT_MS, write } from './helpers.ts';

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });

/** Sem proxy e sem gerenciador de credenciais: os testes de http falam só com 127.0.0.1. */
const LOOPBACK_ENV = { NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const NO_HELPER = ['-c', 'credential.helper=', '-c', 'http.proxy='];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

let sandbox: Sandbox;
let repo: string;

beforeAll(async () => {
  sandbox = createSandbox();
  repo = await sandbox.initRepo('repositório com espaço');
});

afterAll(() => {
  sandbox.cleanup();
});

describe('runGit', () => {
  it('devolve saída, stderr e código tipados', async () => {
    const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repo });
    expect(result).toEqual({
      args: ['rev-parse', '--is-inside-work-tree'],
      exitCode: 0,
      stdout: 'true\n',
      stderr: '',
    });
  });

  it('lança GitError com código de saída, stderr e argumentos', async () => {
    const error = await runGit(['rev-parse', '--verify', 'refs/heads/nao-existe'], { cwd: repo }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.exitCode).toBe(128);
    expect(error.args).toEqual(['rev-parse', '--verify', 'refs/heads/nao-existe']);
    // Mensagem em inglês mesmo em máquina configurada em outro idioma: LC_ALL=C.
    expect(error.stderr).toContain('fatal: Needed a single revision');
    expect(error.message).toContain('git rev-parse --verify refs/heads/nao-existe falhou (código 128)');
  });

  it('com allowFailure devolve o resultado em vez de lançar', async () => {
    const result = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/nao-existe'], {
      cwd: repo,
      allowFailure: true,
    });
    expect(result.exitCode).toBe(1);
  });

  it('envia a entrada padrão e preserva acentos na ida e na volta', async () => {
    const content = 'ação, coração e 日本語\n';
    const { stdout: sha } = await runGit(['hash-object', '-w', '--stdin'], { cwd: repo, input: content });
    const { stdout } = await runGit(['cat-file', 'blob', sha.trim()], { cwd: repo });
    expect(stdout).toBe(content);
  });

  it('não usa shell: metacaracteres, aspas, espaços e acentos chegam ao git como argumento', async () => {
    const value = 'a; echo "x" && $(whoami) `id` | > %PATH% ^ ação \'aspas\'';
    await runGit(['config', '--local', 'cabecao.teste', value], { cwd: repo });
    const { stdout } = await runGit(['config', '--local', '--get', 'cabecao.teste'], { cwd: repo });
    expect(stdout).toBe(`${value}\n`);
  });

  it('funciona com espaço e acento no caminho da pasta e dos arquivos', async () => {
    write(repo, 'pasta com espaço/anotação [1].md', 'x\n');
    await runGit(['add', '--', 'pasta com espaço/anotação [1].md'], { cwd: repo });
    const { stdout } = await runGit(['ls-files', '-z'], { cwd: repo });
    expect(stdout.split('\0')).toContain('pasta com espaço/anotação [1].md');
    const { stdout: top } = await runGit(['rev-parse', '--show-toplevel'], { cwd: repo });
    expect(top.trim().endsWith('repositório com espaço')).toBe(true);
  });

  it('pasta inexistente vira GitError com explicação, e não um ENOENT cru', async () => {
    const error = await runGit(['status'], { cwd: join(sandbox.root, 'não existe') }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.exitCode).toBeNull();
    expect(error.message).toContain('a pasta não existe');
  });

  it('o processo filho recebe o ambiente sem perguntas, e options.env não o desfaz', async () => {
    const { stdout } = await runGit(
      [
        '-c',
        'alias.cabecao-env=!echo "$GIT_TERMINAL_PROMPT|$GIT_ASKPASS|$SSH_ASKPASS|$LC_ALL|$GIT_EDITOR|$CABECAO_TESTE|$GIT_SSH_COMMAND"',
        'cabecao-env',
      ],
      {
        cwd: repo,
        env: {
          GIT_TERMINAL_PROMPT: '1',
          GIT_ASKPASS: 'pergunta',
          LC_ALL: 'pt_BR.UTF-8',
          CABECAO_TESTE: 'ok',
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
        },
      },
    );
    expect(stdout.trim()).toBe('0|||C|:|ok|ssh -o BatchMode=yes');
  });

  it('mata o comando que estoura o tempo limite e classifica como falta de rede', async () => {
    const sockets = new Set<Socket>();
    // Aceita a conexão e nunca responde.
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    const port = await listen(server);
    try {
      const started = Date.now();
      const error = await runGit([...NO_HELPER, 'ls-remote', `http://127.0.0.1:${port}/repo.git`], {
        cwd: repo,
        timeoutMs: 1500,
        env: LOOPBACK_ENV,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(GitError);
      expect(error.timedOut).toBe(true);
      expect(error.exitCode).toBeNull();
      expect(error.category).toBe('network');
      expect(error.message).toContain('tempo limite');
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('credencial ausente vira erro de autenticação imediato, sem pergunta', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cabecao"' });
      response.end();
    });
    const port = await listen(server);
    try {
      const started = Date.now();
      const error = await runGit([...NO_HELPER, 'ls-remote', `http://127.0.0.1:${port}/repo.git`], {
        cwd: repo,
        timeoutMs: 30_000,
        env: LOOPBACK_ENV,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(GitError);
      expect(error.timedOut).toBe(false);
      expect(error.stderr).toMatch(/terminal prompts disabled|Authentication failed/);
      expect(error.category).toBe('auth');
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('buildGitEnv', () => {
  it('define todas as variáveis de não interação', async () => {
    const env = await buildGitEnv(['status'], { cwd: repo });
    for (const [key, value] of Object.entries(NON_INTERACTIVE_ENV)) expect(env[key]).toBe(value);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.LC_ALL).toBe('C');
  });

  it('em comando de rede, parte do core.sshCommand do repositório', async () => {
    const other = await sandbox.initRepo('com-ssh-proprio');
    await runGit(['config', '--local', 'core.sshCommand', 'ssh -i "/chaves/do cérebro"'], { cwd: other });
    const clean = { GIT_SSH_COMMAND: undefined, GIT_SSH: undefined };
    const fetchEnv = await buildGitEnv(['-c', 'x.y=z', 'fetch', 'origin'], { cwd: other, env: clean });
    expect(fetchEnv.GIT_SSH_COMMAND).toBe('ssh -i "/chaves/do cérebro" -o BatchMode=yes');
    // Fora dos comandos de rede o ssh não roda, e a consulta à configuração é poupada.
    const statusEnv = await buildGitEnv(['status'], { cwd: other, env: clean });
    expect(statusEnv.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });

  it('a variável de ambiente do usuário vence o core.sshCommand, como no git', async () => {
    const other = await sandbox.initRepo('com-ssh-env');
    await runGit(['config', '--local', 'core.sshCommand', 'ssh -i /da/config'], { cwd: other });
    const env = await buildGitEnv(['push'], { cwd: other, env: { GIT_SSH_COMMAND: 'ssh -p 2222' } });
    expect(env.GIT_SSH_COMMAND).toBe('ssh -p 2222 -o BatchMode=yes');
  });
});

describe('resolveSshCommand', () => {
  it('sem nada configurado usa o ssh em BatchMode', () => {
    expect(resolveSshCommand({})).toBe('ssh -o BatchMode=yes');
    expect(resolveSshCommand({ envCommand: '  ', configCommand: '' })).toBe('ssh -o BatchMode=yes');
  });

  it('acrescenta BatchMode ao OpenSSH do usuário', () => {
    expect(resolveSshCommand({ envCommand: 'ssh -i ~/.ssh/cerebro' })).toBe('ssh -i ~/.ssh/cerebro -o BatchMode=yes');
    expect(resolveSshCommand({ configCommand: '/usr/bin/ssh -F /dev/null' })).toBe(
      '/usr/bin/ssh -F /dev/null -o BatchMode=yes',
    );
    expect(resolveSshCommand({ configCommand: '"C:\\Program Files\\OpenSSH\\ssh.exe" -v' })).toBe(
      '"C:\\Program Files\\OpenSSH\\ssh.exe" -v -o BatchMode=yes',
    );
    expect(resolveSshCommand({ envCommand: 'ssh -p 1', configCommand: 'ssh -p 2' })).toBe('ssh -p 1 -o BatchMode=yes');
  });

  it('não repete BatchMode nem mexe em programas que não são o OpenSSH', () => {
    expect(resolveSshCommand({ envCommand: 'ssh -oBatchMode=yes -oConnectTimeout=10' })).toBe(
      'ssh -oBatchMode=yes -oConnectTimeout=10',
    );
    expect(resolveSshCommand({ configCommand: 'plink.exe -batch' })).toBe('plink.exe -batch');
    expect(resolveSshCommand({ envCommand: '/opt/meu-ssh.sh --perfil x' })).toBe('/opt/meu-ssh.sh --perfil x');
  });

  it('com GIT_SSH e sem comando, não define nada para não passar por cima', () => {
    expect(resolveSshCommand({ envGitSsh: '/usr/local/bin/plink' })).toBeUndefined();
    expect(resolveSshCommand({ envGitSsh: '/x/plink', configCommand: 'ssh -4' })).toBe('ssh -4 -o BatchMode=yes');
  });
});

describe('gitSubcommand', () => {
  it('pula as opções globais e seus valores', () => {
    expect(gitSubcommand(['fetch', 'origin'])).toBe('fetch');
    expect(gitSubcommand(['-c', 'a.b=c', '-C', '/x', '--literal-pathspecs', 'push'])).toBe('push');
    expect(gitSubcommand(['--git-dir', '/x/.git', '--work-tree=/x', 'status'])).toBe('status');
    expect(gitSubcommand(['--version'])).toBeUndefined();
  });
});

describe('versão do git', () => {
  it('lê os formatos de cada sistema', () => {
    expect(parseGitVersion('git version 2.54.0 (Apple Git-157)\n')).toEqual({
      raw: 'git version 2.54.0 (Apple Git-157)',
      major: 2,
      minor: 54,
      patch: 0,
    });
    expect(parseGitVersion('git version 2.45.1.windows.1')).toMatchObject({ major: 2, minor: 45, patch: 1 });
    expect(parseGitVersion('git version 2.38.0-rc1')).toMatchObject({ major: 2, minor: 38, patch: 0 });
    expect(parseGitVersion('git version 3.0')).toMatchObject({ major: 3, minor: 0, patch: 0 });
    expect(parseGitVersion('nada')).toBeNull();
  });

  it('compara com o mínimo 2.38', () => {
    expect(isGitVersionSupported({ major: 2, minor: 38 })).toBe(true);
    expect(isGitVersionSupported({ major: 2, minor: 54 })).toBe(true);
    expect(isGitVersionSupported({ major: 3, minor: 0 })).toBe(true);
    expect(isGitVersionSupported({ major: 2, minor: 37 })).toBe(false);
    expect(isGitVersionSupported({ major: 1, minor: 99 })).toBe(false);
  });

  it('o git desta máquina responde e atende ao mínimo', async () => {
    const version = await gitVersion();
    expect(version.raw).toMatch(/^git version \d+\.\d+/);
    await expect(assertGitVersion()).resolves.toEqual(version);
  });

  it('git antigo gera uma mensagem que diz o que fazer', () => {
    const old = parseGitVersion('git version 2.37.4');
    if (!old) throw new Error('versão de teste inválida');
    expect(() => ensureGitVersionSupported(old)).toThrow(GitVersionError);
    expect(() => ensureGitVersionSupported(old)).toThrow(
      'O Cabeção precisa do git 2.38 ou mais novo, e o instalado é o 2.37.4. Atualize o git e tente de novo.',
    );
    const current = parseGitVersion('git version 2.38.0');
    if (!current) throw new Error('versão de teste inválida');
    expect(() => ensureGitVersionSupported(current)).not.toThrow();
  });
});
