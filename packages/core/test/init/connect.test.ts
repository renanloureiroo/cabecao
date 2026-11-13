import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectRemote, initBrain, normalizeRemoteUrl } from '../../src/init/index.ts';
import { VaultError } from '../../src/vault/index.ts';
import { createSandbox, git, readTree, type Sandbox, TEST_TIMEOUT_MS, writeFiles } from './helpers.ts';

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });

let sandbox: Sandbox;
let counter = 0;
const fresh = (label: string): string => {
  counter += 1;
  return sandbox.path(`${label} ${counter}`);
};

beforeAll(async () => {
  sandbox = await createSandbox();
});
afterAll(async () => {
  await sandbox.cleanup();
});

async function localBrain(branch = 'main'): Promise<string> {
  const result = await initBrain({ dir: fresh('local'), initialBranch: branch, machine: 'a', configDir: fresh('cfg') });
  expect(result.case).toBe('local');
  return result.root;
}

async function addNote(root: string, name: string): Promise<void> {
  await writeFiles(root, { [`wiki/${name}.md`]: `# ${name}\n` });
  await git(root, ['add', '-A']);
  await git(root, ['commit', '--quiet', '-m', name]);
}

/** Remoto bare com a história de `root` na branch `branch` (um espelho do mesmo cérebro). */
async function mirrorOf(root: string, name: string, branch = 'main'): Promise<string> {
  const bare = await sandbox.bare(name, branch);
  await git(root, ['push', '--quiet', bare, `HEAD:refs/heads/${branch}`]);
  return bare;
}

async function rejectPushes(bare: string): Promise<void> {
  const hook = join(bare, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho "recusado pelo teste" >&2\nexit 1\n');
  await chmod(hook, 0o755);
}

describe('connectRemote: remoto vazio', () => {
  it('liga um cérebro só local, envia e configura o upstream; outra máquina entra com init', async () => {
    const root = await localBrain();
    const bare = await sandbox.bare('vazio.git');
    const result = await connectRemote(root, bare);
    expect(result).toMatchObject({
      ok: true,
      case: 'connected',
      relation: 'empty',
      pushed: true,
      branch: 'main',
      remote: bare,
      previousRemote: null,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(await git(root, ['remote', 'get-url', 'origin'])).toBe(bare);
    expect(await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/main');
    expect(await git(bare, ['rev-parse', 'main'])).toBe(await git(root, ['rev-parse', 'HEAD']));

    const other = await initBrain({ url: bare, dir: fresh('outra máquina'), machine: 'b', configDir: fresh('cfg') });
    expect(other.case).toBe('joined');
  });

  it('remoto vazio com outra branch padrão: envia e avisa que o HEAD do remoto ficou em outra branch', async () => {
    const root = await localBrain('main');
    const bare = await sandbox.bare('vazio-trunk.git', 'trunk');
    const result = await connectRemote(root, bare);
    expect(result.case).toBe('connected');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['remote-head-mismatch']);
    // mesmo assim uma segunda máquina consegue entrar: o init escolhe a branch que existe
    const other = await initBrain({ url: bare, dir: fresh('outra'), machine: 'b', configDir: fresh('cfg') });
    expect(other).toMatchObject({ case: 'joined', branch: 'main' });
  });

  it('mesmo remoto de novo: already-connected, nada muda', async () => {
    const root = await localBrain();
    const bare = await sandbox.bare('de-novo.git');
    await connectRemote(root, bare);
    const again = await connectRemote(root, `${bare}/`);
    expect(again).toMatchObject({ ok: true, case: 'already-connected', pushed: false });
  });
});

describe('connectRemote: remoto com conteúdo', () => {
  it('outra história (outro cérebro): recusa e não muda nada', async () => {
    const root = await localBrain();
    const elsewhere = await localBrain();
    const bare = await mirrorOf(elsewhere, 'outro-cerebro.git');
    const before = await readTree(join(root, '.git', 'refs'));
    const result = await connectRemote(root, bare);
    expect(result).toMatchObject({ ok: false, case: 'refused', relation: 'unrelated', pushed: false });
    expect(result.detection?.kind).toBe('brain');
    expect(result.message).toMatch(/nenhuma história em comum/);
    expect(await git(root, ['remote'])).toBe('');
    expect(await readTree(join(root, '.git', 'refs'))).toEqual(before);
    expect(await git(root, ['for-each-ref', '--format=%(refname)', 'refs/cabecao/'])).toBe('');
  });

  it('troca o remoto pelo mesmo cérebro em outro endereço (mesma história)', async () => {
    const first = await sandbox.bare('primeiro.git');
    const created = await initBrain({ url: first, dir: fresh('troca'), machine: 'a', configDir: fresh('cfg') });
    const root = created.root;
    const second = await mirrorOf(root, 'segundo.git');
    const result = await connectRemote(root, second);
    expect(result).toMatchObject({ ok: true, case: 'connected', relation: 'same', pushed: false });
    // o git pode gravar o caminho local com outras barras (Windows): compara na forma normalizada
    expect(normalizeRemoteUrl(result.previousRemote ?? '')).toBe(normalizeRemoteUrl(first));
    expect(await git(root, ['remote', 'get-url', 'origin'])).toBe(second);
    expect(await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/main');
  });

  it('local à frente: envia', async () => {
    const root = await localBrain();
    const bare = await mirrorOf(root, 'atras.git');
    await addNote(root, 'nova');
    const result = await connectRemote(root, bare);
    expect(result).toMatchObject({ case: 'connected', relation: 'ahead', pushed: true });
    expect(await git(bare, ['rev-parse', 'main'])).toBe(await git(root, ['rev-parse', 'HEAD']));
  });

  it('local atrás ou divergente: liga e pede um sync, sem enviar', async () => {
    const root = await localBrain();
    const work = fresh('trabalho');
    const bare = await mirrorOf(root, 'adiante.git');
    await git(sandbox.root, ['clone', '--quiet', bare, work]);
    await addNote(work, 'remota');
    await git(work, ['push', '--quiet']);
    const tip = await git(bare, ['rev-parse', 'main']);

    const behind = await connectRemote(root, bare);
    expect(behind).toMatchObject({ case: 'connected', relation: 'behind', pushed: false });
    expect(behind.nextSteps.join(' ')).toMatch(/cabecao sync/);
    expect(await git(root, ['rev-parse', 'origin/main'])).toBe(tip);

    const diverged = await localBrain();
    await git(diverged, ['fetch', '--quiet', bare, 'main']);
    await git(diverged, ['reset', '--quiet', '--hard', 'FETCH_HEAD~1']);
    await addNote(diverged, 'local');
    const result = await connectRemote(diverged, bare);
    expect(result).toMatchObject({ case: 'connected', relation: 'diverged', pushed: false });
    expect(await git(bare, ['rev-parse', 'main'])).toBe(tip);
  });

  it('adota o nome de branch do remoto (trunk) e avisa', async () => {
    const root = await localBrain('main');
    const bare = await mirrorOf(root, 'espelho-trunk.git', 'trunk');
    const result = await connectRemote(root, bare);
    expect(result).toMatchObject({ case: 'connected', relation: 'same', branch: 'trunk' });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['branch-renamed']);
    expect(await git(root, ['symbolic-ref', '--short', 'HEAD'])).toBe('trunk');
    expect(await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/trunk');
  });

  it('envio recusado: volta o remoto anterior, o nome da branch e o upstream', async () => {
    const first = await sandbox.bare('anterior.git');
    const created = await initBrain({ url: first, dir: fresh('recusa'), machine: 'a', configDir: fresh('cfg') });
    const root = created.root;
    const bare = await mirrorOf(root, 'recusa-trunk.git', 'trunk');
    await rejectPushes(bare);
    await addNote(root, 'nova');
    const configBefore = await git(root, ['config', '--local', '--list']);
    const result = await connectRemote(root, bare);
    expect(result).toMatchObject({ ok: false, case: 'remote-error', pushed: false });
    expect(result.error?.category).toBe('rejected');
    expect(normalizeRemoteUrl(await git(root, ['remote', 'get-url', 'origin']))).toBe(normalizeRemoteUrl(first));
    expect(await git(root, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await git(root, ['config', '--local', '--list'])).toBe(configBefore);
    expect(await git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/trunk', 'refs/cabecao/'])).toBe(
      '',
    );
  });
});

describe('connectRemote: erros', () => {
  it('remoto inexistente ou URL inválida: mensagem por categoria, nada muda', async () => {
    const root = await localBrain();
    const missing = await connectRemote(root, sandbox.path('nao-existe.git'));
    expect(missing).toMatchObject({ ok: false, case: 'remote-error' });
    expect(missing.error?.category).toBe('not-found');
    const invalid = await connectRemote(root, 'ext::sh -c touch% /tmp/x');
    expect(invalid.error?.category).toBe('invalid-url');
    expect(await git(root, ['remote'])).toBe('');
  });

  it('pasta que não é cérebro: VaultError', async () => {
    const dir = fresh('não cérebro');
    await writeFiles(dir, { 'a.md': '# a\n' });
    await expect(connectRemote(dir, sandbox.path('x.git'))).rejects.toBeInstanceOf(VaultError);
  });
});
