import { describe, expect, it } from 'vitest';
import { classifyGitError, GitError, type GitErrorCategory, redactCredentials } from '../../src/git/errors.ts';

const SSH_TAIL =
  'fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n';

/** Mensagens reais do git, do ssh e do curl diante de GitHub, GitLab, Bitbucket, Gitea e remotos locais. */
const SAMPLES: [name: string, stderr: string, expected: GitErrorCategory][] = [
  [
    'https sem credencial e sem terminal',
    "fatal: could not read Username for 'https://bitbucket.org': terminal prompts disabled\n",
    'auth',
  ],
  [
    'https com senha recusada (GitLab)',
    "remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password.\nfatal: Authentication failed for 'https://gitlab.com/eu/cerebro.git/'\n",
    'auth',
  ],
  [
    'https com token inválido (GitHub)',
    "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/eu/cerebro.git/'\n",
    'auth',
  ],
  [
    'https 403 sem permissão de escrita (GitHub)',
    "remote: Permission to eu/cerebro.git denied to outra-pessoa.\nfatal: unable to access 'https://github.com/eu/cerebro.git/': The requested URL returned error: 403\n",
    'auth',
  ],
  [
    'https 401 em servidor simples',
    "fatal: unable to access 'http://127.0.0.1:8080/repo.git/': The requested URL returned error: 401\n",
    'auth',
  ],
  ['ssh sem chave aceita', `git@github.com: Permission denied (publickey).\n${SSH_TAIL}`, 'auth'],
  ['ssh com servidor desconhecido em BatchMode', `Host key verification failed.\n${SSH_TAIL}`, 'auth'],
  [
    'https com host que não resolve',
    "fatal: unable to access 'https://cabecao-nao-existe.invalid/eu/cerebro.git/': Could not resolve host: cabecao-nao-existe.invalid\n",
    'network',
  ],
  [
    'ssh com host que não resolve (macOS)',
    `ssh: Could not resolve hostname gitea.exemplo: nodename nor servname provided, or not known\n${SSH_TAIL}`,
    'network',
  ],
  [
    'ssh com host que não resolve (Linux)',
    `ssh: Could not resolve hostname gitea.exemplo: Temporary failure in name resolution\n${SSH_TAIL}`,
    'network',
  ],
  [
    'https com porta fechada',
    "fatal: unable to access 'http://127.0.0.1:1/repo.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server\n",
    'network',
  ],
  ['ssh com porta fechada', `ssh: connect to host 127.0.0.1 port 1: Connection refused\n${SSH_TAIL}`, 'network'],
  ['ssh sem resposta', `ssh: connect to host exemplo.com port 22: Operation timed out\n${SSH_TAIL}`, 'network'],
  [
    'ssh derrubado no aperto de mão',
    `kex_exchange_identification: Connection closed by remote host\nConnection closed by 203.0.113.7 port 22\n${SSH_TAIL}`,
    'network',
  ],
  [
    'https interrompido no meio',
    'error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: the remote end hung up unexpectedly\n',
    'network',
  ],
  [
    'https repositório inexistente (GitHub)',
    "remote: Repository not found.\nfatal: repository 'https://github.com/eu/sumiu.git/' not found\n",
    'not-found',
  ],
  ['ssh repositório inexistente (GitHub)', `ERROR: Repository not found.\n${SSH_TAIL}`, 'not-found'],
  [
    'caminho local inexistente',
    `fatal: '/tmp/sumiu.git' does not appear to be a git repository\n${SSH_TAIL}`,
    'not-found',
  ],
  ['remoto sem nome configurado', `fatal: 'origin' does not appear to be a git repository\n${SSH_TAIL}`, 'not-found'],
  ['branch inexistente no remoto', "fatal: couldn't find remote ref trunk\n", 'not-found'],
  [
    'push atrás do remoto',
    " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:eu/cerebro.git'\nhint: Updates were rejected because the remote contains work that you do not have locally.\n",
    'rejected',
  ],
  [
    'push divergente',
    " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://gitlab.com/eu/cerebro.git'\n",
    'rejected',
  ],
  [
    'branch protegida (GitLab)',
    "remote: GitLab: You are not allowed to force push code to a protected branch on this project.\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to 'gitlab.com:eu/cerebro.git'\n",
    'rejected',
  ],
  [
    'branch protegida (GitHub)',
    "remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to 'github.com:eu/cerebro.git'\n",
    'rejected',
  ],
  ['push atômico recusado', ' ! [rejected]        cabecao/index -> cabecao/index (atomic push failed)\n', 'rejected'],
  ['fora de um repositório', 'fatal: not a git repository (or any of the parent directories): .git\n', 'unknown'],
  ['vazio', '', 'unknown'],
];

describe('classifyGitError', () => {
  it.each(SAMPLES)('%s', (_name, stderr, expected) => {
    expect(classifyGitError(stderr)).toBe(expected);
  });

  it('aceita o próprio GitError e expõe a categoria nele', () => {
    const error = new GitError({ args: ['fetch'], exitCode: 128, stderr: SAMPLES[0]?.[1] ?? '' });
    expect(classifyGitError(error)).toBe('auth');
    expect(error.category).toBe('auth');
  });

  it('tempo limite conta como falta de rede, diga o stderr o que disser', () => {
    const error = new GitError({ args: ['fetch'], exitCode: null, stderr: 'Authentication failed', timedOut: true });
    expect(error.category).toBe('network');
  });
});

describe('GitError', () => {
  it('guarda código de saída, stderr e argumentos', () => {
    const error = new GitError({ args: ['push', 'origin', 'main'], exitCode: 1, stderr: 'fatal: algo\n', stdout: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GitError');
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toBe('fatal: algo\n');
    expect(error.stdout).toBe('x');
    expect(error.args).toEqual(['push', 'origin', 'main']);
    expect(error.timedOut).toBe(false);
    expect(error.message).toBe('git push origin main falhou (código 1): fatal: algo');
  });

  it('não põe credenciais de URL na mensagem', () => {
    const error = new GitError({
      args: ['fetch', 'https://eu:ghp_segredo@github.com/eu/cerebro.git'],
      exitCode: 128,
      stderr: "fatal: unable to access 'https://ghp_segredo@github.com/eu/cerebro.git/'",
    });
    expect(error.message).not.toContain('ghp_segredo');
    expect(error.message).toContain('https://***@github.com/eu/cerebro.git');
  });
});

describe('redactCredentials', () => {
  it('só mexe em URLs http(s) com usuário', () => {
    expect(redactCredentials('https://token@host/x.git e http://u:p@h/y')).toBe(
      'https://***@host/x.git e http://***@h/y',
    );
    expect(redactCredentials('git@github.com:eu/cerebro.git https://github.com/eu/x.git')).toBe(
      'git@github.com:eu/cerebro.git https://github.com/eu/x.git',
    );
  });
});
