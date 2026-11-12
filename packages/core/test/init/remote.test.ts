import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRemoteVisibility,
  knownHttpsProvider,
  normalizeRemoteUrl,
  parseLsRemote,
  publicRemoteWarning,
  remoteFailureMessage,
  remoteUrlProblem,
  resolveRemoteArg,
} from '../../src/init/index.ts';

describe('remoteUrlProblem', () => {
  it('aceita os formatos do doc 08', () => {
    for (const url of [
      'git@github.com:voce/cerebro.git',
      'https://gitlab.com/voce/cerebro.git',
      'git@bitbucket.org:voce/cerebro.git',
      'ssh://servidor/git/cerebro.git',
      '/Volumes/backup/cerebro.git',
      'C:\\backup\\cerebro.git',
    ]) {
      expect(remoteUrlProblem(url), url).toBeNull();
    }
  });

  it('recusa o que nunca é URL ou seria perigoso', () => {
    for (const url of ['', '   ', '-uhack', 'ext::sh -c touch% /tmp/x', 'fd::17', 'a\nb', 'a\0b']) {
      expect(remoteUrlProblem(url), JSON.stringify(url)).not.toBeNull();
    }
  });
});

describe('resolveRemoteArg e normalizeRemoteUrl', () => {
  it('caminho local relativo vira absoluto; URL fica como está', () => {
    const cwd = resolve('/tmp/base');
    expect(resolveRemoteArg('remoto.git', cwd)).toBe(join(cwd, 'remoto.git'));
    expect(resolveRemoteArg('  git@github.com:voce/c.git ', cwd)).toBe('git@github.com:voce/c.git');
    expect(resolveRemoteArg('https://x.invalid/a.git', cwd)).toBe('https://x.invalid/a.git');
  });

  it('duas grafias do mesmo remoto ficam iguais', () => {
    expect(normalizeRemoteUrl('https://token@github.com/voce/c.git')).toBe(
      normalizeRemoteUrl('https://github.com/voce/c/'),
    );
    expect(normalizeRemoteUrl('git@github.com:voce/c.git')).toBe('git@github.com:voce/c');
    const cwd = resolve('/tmp/base');
    expect(normalizeRemoteUrl('r.git', cwd)).toBe(normalizeRemoteUrl(join(cwd, 'r.git/'), cwd));
  });
});

describe('parseLsRemote', () => {
  it('lê a branch apontada pelo HEAD (trunk)', () => {
    const probe = parseLsRemote(
      ['ref: refs/heads/trunk\tHEAD', 'abc\tHEAD', 'abc\trefs/heads/trunk', 'def\trefs/heads/feature', ''].join('\n'),
    );
    expect(probe).toEqual({
      branches: ['feature', 'trunk'],
      empty: false,
      defaultBranch: 'trunk',
      headTarget: 'trunk',
    });
  });

  it('remoto vazio', () => {
    expect(parseLsRemote('')).toEqual({ branches: [], empty: true, defaultBranch: null, headTarget: null });
  });

  it('HEAD apontando para branch que não existe: cai em main, master, trunk, nessa ordem', () => {
    const probe = parseLsRemote(
      ['ref: refs/heads/main\tHEAD', 'abc\trefs/heads/master', 'def\trefs/heads/x'].join('\n'),
    );
    expect(probe.defaultBranch).toBe('master');
    expect(probe.headTarget).toBe('main');
  });

  it('ignora as branches do próprio Cabeção (índice) e as tags', () => {
    const probe = parseLsRemote(['abc\trefs/heads/cabecao/index', 'abc\trefs/tags/v1'].join('\n'));
    expect(probe.empty).toBe(true);
  });
});

describe('knownHttpsProvider', () => {
  it('reconhece HTTPS dos provedores conhecidos, com ou sem credencial na URL', () => {
    expect(knownHttpsProvider('https://github.com/voce/cerebro.git')).toBe('GitHub');
    expect(knownHttpsProvider('https://token@gitlab.com/voce/cerebro.git')).toBe('GitLab');
    expect(knownHttpsProvider('https://www.bitbucket.org/voce/cerebro.git')).toBe('Bitbucket');
    expect(knownHttpsProvider('https://codeberg.org/voce/cerebro.git')).toBe('Codeberg');
  });

  it('SSH, HTTP sem TLS, caminho local e servidor próprio: não verifica', () => {
    for (const url of [
      'git@github.com:voce/cerebro.git',
      'ssh://git@github.com/voce/cerebro.git',
      'http://github.com/voce/cerebro.git',
      '/srv/git/cerebro.git',
      'https://git.minhaempresa.invalid/voce/cerebro.git',
    ]) {
      expect(knownHttpsProvider(url), url).toBeNull();
    }
  });
});

describe('checkRemoteVisibility (sem rede)', () => {
  it('público quando a leitura anônima responde', async () => {
    const seen: string[] = [];
    const check = await checkRemoteVisibility('https://github.com/voce/cerebro.git', async (url) => {
      seen.push(url);
      return true;
    });
    expect(check).toEqual({ visibility: 'public', provider: 'GitHub' });
    expect(seen).toEqual(['https://github.com/voce/cerebro.git']);
    expect(publicRemoteWarning('https://github.com/voce/cerebro.git', 'GitHub')).toMatch(/parece público/);
  });

  it('privado (ou inexistente) quando a leitura anônima é recusada', async () => {
    for (const outcome of ['auth', 'not-found'] as const) {
      const check = await checkRemoteVisibility('https://gitlab.com/voce/cerebro.git', async () => outcome);
      expect(check.visibility).toBe('private-or-missing');
    }
    const offline = await checkRemoteVisibility('https://gitlab.com/voce/cerebro.git', async () => 'network');
    expect(offline.visibility).toBe('unknown');
  });

  it('não consulta nada quando a URL não é HTTPS de provedor conhecido', async () => {
    let called = false;
    const check = await checkRemoteVisibility('git@github.com:voce/cerebro.git', async () => {
      called = true;
      return true;
    });
    expect(check).toEqual({ visibility: 'unknown', provider: null });
    expect(called).toBe(false);
  });
});

describe('remoteFailureMessage', () => {
  it('uma mensagem por categoria, sem credenciais', () => {
    const url = 'https://usuario:segredo@github.com/voce/c.git';
    const messages = (['auth', 'network', 'not-found', 'rejected', 'unknown', 'invalid-url'] as const).map((category) =>
      remoteFailureMessage(category, url),
    );
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message).not.toContain('segredo');
    expect(remoteFailureMessage('auth', url)).toMatch(/nunca pede senha/);
  });
});
