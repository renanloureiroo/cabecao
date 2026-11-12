import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { commitPaths, formatCommitMessage, parseCommitTrailers } from '../../src/git/index.ts';
import type { InitResult, InitStep } from '../../src/init/index.ts';
import { brainTemplateFiles, GitIdentityError, initBrain, normalizeRemoteUrl } from '../../src/init/index.ts';
import { readMachineConfig } from '../../src/util/index.ts';
import { readBrainConfig } from '../../src/vault/index.ts';
import {
  copyFixtureParts,
  createSandbox,
  exists,
  git,
  readTree,
  removeTree,
  type Sandbox,
  TEST_TIMEOUT_MS,
  treeEntries,
  writeFiles,
} from './helpers.ts';

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });

let sandbox: Sandbox;
let counter = 0;
/** Pasta nova (ainda inexistente) para um cérebro, dentro de uma subpasta que também não existe. */
const freshDir = (label: string): string => {
  counter += 1;
  return sandbox.path(`máquina ${counter}`, label);
};
/** Configuração da máquina isolada por teste, quando o teste simula outra máquina. */
const machineDir = (label: string): string => sandbox.path(`config ${label}`);

beforeAll(async () => {
  sandbox = await createSandbox();
});
afterAll(async () => {
  await sandbox.cleanup();
});

const templatePaths = brainTemplateFiles()
  .map((file) => file.path)
  .sort();

async function headMessage(repo: string): Promise<string> {
  return git(repo, ['log', '-1', '--format=%B']);
}

async function remoteHead(bare: string): Promise<string> {
  return git(bare, ['symbolic-ref', 'HEAD']);
}

async function upstreamOf(root: string): Promise<string> {
  return git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
}

describe('remoto vazio', () => {
  for (const branch of ['main', 'master', 'trunk']) {
    it(`cria a estrutura, faz o primeiro commit no padrão do doc 12, envia e configura o upstream (branch ${branch})`, async () => {
      const bare = await sandbox.bare(`vazio-${branch}.git`, branch);
      const dir = freshDir('cérebro');
      const configDir = machineDir(`vazio-${branch}`);
      const steps: InitStep[] = [];
      const result = await initBrain({
        url: bare,
        dir,
        machine: 'macbook',
        configDir,
        now: () => new Date(2026, 10, 12, 14, 32, 10, 482),
        hooks: { onStep: (step) => void steps.push(step) },
      });

      expect(result).toMatchObject({
        ok: true,
        case: 'created',
        root: dir,
        branch,
        remote: bare,
        adopted: false,
        pushed: true,
        machine: 'macbook',
        error: null,
      });
      expect(result.detection?.kind).toBe('empty');
      expect([...result.created].sort()).toEqual(templatePaths);
      expect(steps).toEqual(['probe', 'clone', 'detect', 'scaffold', 'commit', 'config', 'push']);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);

      // estrutura idêntica ao modelo
      const tree = await readTree(dir);
      for (const file of brainTemplateFiles())
        expect(tree.get(file.path)?.toString('utf8'), file.path).toBe(file.content);

      // primeiro commit no padrão do doc 12
      expect(await git(dir, ['rev-list', '--count', 'HEAD'])).toBe('1');
      const message = await headMessage(dir);
      expect(message.split('\n')[0]).toBe('vault backup: 2026-11-12 14:32:10.482');
      expect(message).toContain('init: cérebro criado');
      expect(message).toContain('- .cabecao.json');
      const trailers = parseCommitTrailers(message);
      expect(trailers).toMatchObject({ machine: 'macbook', client: 'cli' });
      expect(trailers.op).toMatch(/^[0-9A-Z]{26}$/);
      expect(trailers.session).toBeUndefined();
      expect(message).not.toMatch(/Co-Authored-By|Generated with|claude\.ai/i);

      // enviado, com upstream e HEAD do remoto na branch certa
      expect(await git(bare, ['rev-parse', `refs/heads/${branch}`])).toBe(result.commit);
      expect(await remoteHead(bare)).toBe(`refs/heads/${branch}`);
      expect(await upstreamOf(dir)).toBe(`origin/${branch}`);
      expect(await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).toBe(`refs/remotes/origin/${branch}`);
      expect(await git(dir, ['status', '--porcelain'])).toBe('');
      // marco 1: nenhuma branch de índice
      expect(await git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(`refs/heads/${branch}`);

      // configuração da máquina
      expect(await readMachineConfig(configDir)).toEqual({ machine: 'macbook', defaultBrain: dir });
    });
  }

  it('usa CABECAO_CONFIG_DIR quando nenhuma pasta de configuração é informada', async () => {
    const bare = await sandbox.bare('vazio-env.git');
    const dir = freshDir('cérebro');
    const result = await initBrain({ url: bare, dir, machine: 'pelo-ambiente' });
    expect(result.case).toBe('created');
    expect(await readMachineConfig(sandbox.configDir)).toEqual({ machine: 'pelo-ambiente', defaultBrain: dir });
  });

  it('fronteira: remoto só com README, LICENSE e .gitignore do provedor vira cérebro sem perder nada', async () => {
    const files = { 'README.md': '# meu cérebro\n', LICENSE: 'MIT\n', '.gitignore': 'node_modules/\n' };
    const bare = await sandbox.seed('com-readme.git', 'main', files);
    const before = await treeEntries(bare, 'main');
    const dir = freshDir('cérebro');
    const result = await initBrain({ url: bare, dir, machine: 'a', configDir: machineDir('readme') });
    expect(result).toMatchObject({ ok: true, case: 'created', branch: 'main', pushed: true });
    expect(result.detection?.reason).toMatch(/arquivos iniciais/);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe(files['README.md']);
    const ignore = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(ignore.startsWith(files['.gitignore'])).toBe(true);
    expect(ignore).toContain('\n.cabecao/\n');
    expect(result.created).toContain('.gitignore');
    expect(result.created).not.toContain('README.md');
    expect(await exists(join(dir, 'memory', 'rules', '.gitkeep'))).toBe(true);
    const after = await treeEntries(bare, 'main');
    expect(after.get('README.md')).toBe(before.get('README.md'));
    expect(after.get('LICENSE')).toBe(before.get('LICENSE'));
    expect(await git(bare, ['rev-list', '--count', 'main'])).toBe('2');
  });

  it('avisa, sem bloquear, quando a verificação diz que o remoto é público', async () => {
    const bare = await sandbox.bare('publico.git');
    const seen: string[] = [];
    const result = await initBrain({
      url: bare,
      dir: freshDir('cérebro'),
      machine: 'a',
      configDir: machineDir('publico'),
      visibilityCheck: async (url) => {
        seen.push(url);
        return { visibility: 'public', provider: 'GitHub' };
      },
    });
    expect(result.case).toBe('created');
    expect(result.pushed).toBe(true);
    expect(seen).toEqual([bare]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['public-remote']);
  });
});

describe('remoto com cérebro (segunda máquina)', () => {
  it('clona e pronto; a segunda máquina vê as notas da primeira, na branch trunk', async () => {
    const bare = await sandbox.bare('dois.git', 'trunk');
    const dirA = freshDir('cérebro A');
    const a = await initBrain({ url: bare, dir: dirA, machine: 'maquina-a', configDir: machineDir('A') });
    expect(a.case).toBe('created');

    // a máquina A grava uma nota e envia (o sync é de outro módulo; aqui, git puro)
    const note = '---\nid: 01JD3K8Y6Z9W2T4N5P7Q8R0S1V\ntype: gotcha\ntitle: Teste\n---\nLimpe o banco antes.\n';
    await writeFiles(dirA, { 'memory/gotchas/limpe-o-banco.md': note });
    const message = formatCommitMessage({
      date: new Date(),
      body: [{ action: 'add', noteType: 'gotcha', title: 'Teste' }],
      trailers: { op: '01JD3K8Y6Z9W2T4N5P7Q8R0S1V', machine: 'maquina-a', client: 'cli' },
    });
    await commitPaths(dirA, ['memory/gotchas/limpe-o-banco.md'], message);
    await git(dirA, ['push', '--quiet']);

    const dirB = freshDir('cérebro B');
    const configB = machineDir('B');
    const steps: InitStep[] = [];
    const b = await initBrain({
      url: bare,
      dir: dirB,
      machine: 'maquina-b',
      configDir: configB,
      hooks: { onStep: (step) => void steps.push(step) },
    });
    expect(b).toMatchObject({
      ok: true,
      case: 'joined',
      branch: 'trunk',
      created: [],
      adopted: false,
      commit: null,
      pushed: false,
      machine: 'maquina-b',
    });
    expect(b.detection?.kind).toBe('brain');
    expect(steps).toEqual(['probe', 'clone', 'detect', 'config']);
    expect(await readFile(join(dirB, 'memory', 'gotchas', 'limpe-o-banco.md'), 'utf8')).toBe(note);
    expect(await git(dirB, ['rev-parse', 'HEAD'])).toBe(await git(dirA, ['rev-parse', 'HEAD']));
    expect(await git(dirB, ['status', '--porcelain'])).toBe('');
    expect(await upstreamOf(dirB)).toBe('origin/trunk');
    expect((await readBrainConfig(dirB)).noteDirs).toEqual(['wiki', 'memory', 'raw']);
    expect(await readMachineConfig(configB)).toEqual({ machine: 'maquina-b', defaultBrain: dirB });
    // nada foi enviado pela segunda máquina
    expect(await git(bare, ['rev-list', '--count', 'trunk'])).toBe('2');
  });

  it('remoto cuja branch padrão é master e que tem outras branches: abre a do HEAD', async () => {
    const config = brainTemplateFiles().find((file) => file.path === '.cabecao.json')?.content ?? '';
    const bare = await sandbox.seed('master.git', 'master', { '.cabecao.json': config, 'wiki/a.md': '# A\n' });
    const work = sandbox.path('trabalho master');
    await git(sandbox.root, ['clone', '--quiet', bare, work]);
    await git(work, ['checkout', '--quiet', '-b', 'aaa-experimento']);
    await writeFiles(work, { 'wiki/b.md': '# B\n' });
    await git(work, ['add', '-A']);
    await git(work, ['commit', '--quiet', '-m', 'experimento']);
    await git(work, ['push', '--quiet', 'origin', 'aaa-experimento']);

    const result = await initBrain({
      url: bare,
      dir: freshDir('cérebro'),
      machine: 'b',
      configDir: machineDir('master'),
    });
    expect(result).toMatchObject({ case: 'joined', branch: 'master' });
    expect(await exists(join(result.root, 'wiki', 'b.md'))).toBe(false);
  });
});

describe('remoto com vault de Obsidian ou Markdown comum', () => {
  const FIXTURE_PARTS = ['wiki', 'memory', 'raw', 'AGENTS.md', 'CLAUDE.md', 'index.md', 'log.md'];

  it('adota: acrescenta a configuração sem mover nem alterar nenhum arquivo (byte a byte), na branch master', async () => {
    const source = sandbox.path('vault de origem');
    await copyFixtureParts(source, FIXTURE_PARTS);
    await writeFiles(source, {
      '.obsidian/app.json': '{"alwaysUpdateLinks":true}\n',
      'Diário/2026-11-01.md': '# 1 de novembro\n\nHoje estudei filas.\n',
      'anexos/foto.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]),
    });
    const original = await readTree(source);
    expect(original.has('.cabecao.json')).toBe(false);

    const bare = await sandbox.bare('vault.git', 'master');
    await git(source, ['init', '--quiet', '--initial-branch=master']);
    await git(source, ['add', '-A']);
    await git(source, ['commit', '--quiet', '-m', 'meu vault']);
    await git(source, ['push', '--quiet', bare, 'master']);
    const remoteBefore = await treeEntries(bare, 'master');

    const dir = freshDir('vault adotado');
    const result = await initBrain({ url: bare, dir, machine: 'a', configDir: machineDir('vault') });
    expect(result).toMatchObject({ ok: true, case: 'adopted', adopted: true, pushed: true, branch: 'master' });
    expect(result.detection?.kind).toBe('markdown-vault');
    expect([...result.created].sort()).toEqual(['.cabecao.json', '.gitattributes', '.gitignore']);
    // AGENTS.md e CLAUDE.md já existiam (o do exemplo importa o AGENTS.md): ficam como estão
    expect(result.warnings.map((warning) => warning.code)).toEqual(['agents-md-kept']);

    // nenhum arquivo existente mudou de lugar ou de conteúdo, na pasta e no remoto
    const after = await readTree(dir);
    for (const [path, bytes] of original) {
      if (path.startsWith('.git/')) continue;
      expect(after.get(path), path).toEqual(bytes);
    }
    const remoteAfter = await treeEntries(bare, 'master');
    for (const [path, entry] of remoteBefore) expect(remoteAfter.get(path), path).toBe(entry);
    expect([...remoteAfter.keys()].filter((path) => !remoteBefore.has(path)).sort()).toEqual([
      '.cabecao.json',
      '.gitattributes',
      '.gitignore',
    ]);

    // as pastas que já existem viram pastas de notas, mais as do Cabeção
    const config = await readBrainConfig(dir);
    expect(config.noteDirs).toEqual(['wiki', 'memory', 'raw', 'Diário']);
    // o index.md do exemplo é um catálogo do Cabeção: continua sendo o catálogo
    expect(config.indexMd).toBe('index.md');
    expect(await headMessage(dir)).toContain('init: vault adotado; nenhum arquivo foi movido');
    expect(await upstreamOf(dir)).toBe('origin/master');

    // e uma segunda máquina entra como cérebro
    const second = await initBrain({
      url: bare,
      dir: freshDir('vault 2'),
      machine: 'b',
      configDir: machineDir('vault-2'),
    });
    expect(second.case).toBe('joined');
  });

  it('mescla .gitignore e .gitattributes que já existem, mantém index.md e CLAUDE.md do usuário e avisa', async () => {
    const files = {
      '.obsidian/app.json': '{}',
      '.gitignore': '.trash/\r\n',
      '.gitattributes': '*.png binary',
      'index.md': '# Meu índice feito à mão\n',
      'CLAUDE.md': '# Minhas regras\n',
      'log.md': 'diário de bordo\n',
      'ideia solta.md': '# Ideia\n',
      'Projetos/Alfa/plano.md': '# Plano\n',
    };
    const bare = await sandbox.seed('vault-mesclar.git', 'main', files);
    const dir = freshDir('vault mesclado');
    const result = await initBrain({ url: bare, dir, machine: 'a', configDir: machineDir('mesclar') });
    expect(result.case).toBe('adopted');
    expect([...result.created].sort()).toEqual(['.cabecao.json', '.gitattributes', '.gitignore', 'AGENTS.md']);
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
      'claude-md-kept',
      'index-md-kept',
      'log-md-kept',
      'root-notes',
    ]);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe(
      '.trash/\r\n\r\n# Cabeção\r\n.cabecao/\r\n.cabecao-*.tmp\r\n',
    );
    expect(await readFile(join(dir, '.gitattributes'), 'utf8')).toBe('*.png binary\n\n# Cabeção\nlog.md merge=union\n');
    for (const name of ['index.md', 'CLAUDE.md', 'log.md'] as const) {
      expect(await readFile(join(dir, name), 'utf8')).toBe(files[name]);
    }
    const config = await readBrainConfig(dir);
    expect(config.indexMd).toBe('cabecao-index.md');
    expect(config.noteDirs).toEqual(['.']);
  });
});

describe('remoto com outra coisa', () => {
  it('recusa, explica e não deixa pasta nem toca no remoto', async () => {
    const bare = await sandbox.seed('codigo.git', 'main', {
      'package.json': '{"name":"x"}\n',
      'src/index.ts': 'export const a = 1;\n',
      'README.md': '# lib\n',
    });
    const tip = await git(bare, ['rev-parse', 'main']);
    const parent = sandbox.path(`máquina recusa`);
    const dir = join(parent, 'cérebro');
    const configDir = machineDir('recusa');
    const result = await initBrain({ url: bare, dir, machine: 'a', configDir });
    expect(result).toMatchObject({ ok: false, case: 'refused', pushed: false, canStartLocal: true, commit: null });
    expect(result.message).toMatch(/projeto de código/);
    expect(result.detection?.stats.codeMarkers).toEqual(['package.json', 'src/']);
    expect(await exists(parent)).toBe(false);
    expect(await git(bare, ['rev-parse', 'main'])).toBe(tip);
    expect(await readMachineConfig(configDir)).toBeNull();
  });

  it('pasta de destino que já existia vazia continua existindo, vazia', async () => {
    const bare = await sandbox.seed('codigo-2.git', 'main', { 'go.mod': 'module x\n', 'main.go': 'package main\n' });
    const dir = sandbox.path('destino vazio');
    await mkdir(dir);
    const result = await initBrain({ url: bare, dir, machine: 'a', configDir: machineDir('recusa-2') });
    expect(result.case).toBe('refused');
    expect((await readTree(dir)).size).toBe(0);
    expect(await exists(join(dir, '.git'))).toBe(false);
  });
});

describe('URL inválida, sem permissão ou sem rede', () => {
  let server: Server;
  let authUrl: string;
  let closedUrl: string;
  beforeAll(async () => {
    // servidor HTTP local que sempre pede credencial: simula "sem permissão" sem sair da máquina
    server = createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cabecao"' });
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    authUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/voce/cerebro.git`;
    // porta que acabou de ser liberada: conexão recusada
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    closedUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/voce/cerebro.git`;
    await new Promise<void>((done) => probe.close(() => done()));
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  async function expectNothingLeft(result: InitResult, parent: string, configDir: string) {
    expect(result.ok).toBe(false);
    expect(result.case).toBe('remote-error');
    expect(result.canStartLocal).toBe(true);
    expect(result.nextSteps.join(' ')).toMatch(/só local/);
    expect(await exists(parent)).toBe(false);
    expect(await readMachineConfig(configDir)).toBeNull();
  }

  it('caminho que não é repositório: not-found', async () => {
    const parent = sandbox.path('máquina erro 1');
    const configDir = machineDir('erro-1');
    const result = await initBrain({ url: sandbox.path('não existe.git'), dir: join(parent, 'c'), configDir });
    await expectNothingLeft(result, parent, configDir);
    expect(result.error?.category).toBe('not-found');
    expect(result.message).toMatch(/Não achei um repositório/);
  });

  it('texto que não é URL: not-found; transporte perigoso ou vazio: invalid-url, sem chamar o git', async () => {
    const parent = sandbox.path('máquina erro 2');
    const configDir = machineDir('erro-2');
    const plain = await initBrain({ url: 'isto não é uma url', dir: join(parent, 'c'), configDir });
    await expectNothingLeft(plain, parent, configDir);
    expect(plain.error?.category).toBe('not-found');
    for (const url of ['ext::sh -c touch% /tmp/cabecao-pwned', '', '--upload-pack=touch /tmp/x']) {
      const result = await initBrain({ url, dir: join(parent, 'c'), configDir });
      await expectNothingLeft(result, parent, configDir);
      expect(result.error?.category, url).toBe('invalid-url');
    }
  });

  it('servidor que exige credencial: auth, sem pedir senha', async () => {
    const parent = sandbox.path('máquina erro 3');
    const configDir = machineDir('erro-3');
    const started = Date.now();
    const result = await initBrain({ url: authUrl, dir: join(parent, 'c'), configDir });
    await expectNothingLeft(result, parent, configDir);
    expect(result.error?.category).toBe('auth');
    expect(result.message).toMatch(/nunca pede senha/);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('servidor que não responde: network', async () => {
    const parent = sandbox.path('máquina erro 4');
    const configDir = machineDir('erro-4');
    const result = await initBrain({ url: closedUrl, dir: join(parent, 'c'), configDir });
    await expectNothingLeft(result, parent, configDir);
    expect(result.error?.category).toBe('network');
  });
});

describe('sem URL', () => {
  it('cria um cérebro só local com a branch inicial do git do usuário, sem remoto', async () => {
    const dir = freshDir('local');
    const configDir = machineDir('local');
    const result = await initBrain({ dir, machine: 'notebook', configDir });
    expect(result).toMatchObject({ ok: true, case: 'local', branch: 'main', remote: null, pushed: false });
    expect([...result.created].sort()).toEqual(templatePaths);
    expect(await git(dir, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await git(dir, ['remote'])).toBe('');
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(result.commit);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    expect(parseCommitTrailers(await headMessage(dir)).machine).toBe('notebook');
    // só comandos que existem: o remoto é ligado com o git, e o sync cuida do resto
    expect(result.nextSteps.join(' ')).not.toMatch(/cabecao remote/);
    expect(result.nextSteps.join(' ')).toContain('git remote add origin <url>');
    expect(result.nextSteps.join(' ')).toContain('git push -u origin main');
    expect(result.nextSteps.join(' ')).toContain('cabecao sync');
    expect(await readMachineConfig(configDir)).toEqual({ machine: 'notebook', defaultBrain: dir });
  });

  it('branch inicial explícita', async () => {
    const result = await initBrain({
      dir: freshDir('local trunk'),
      initialBranch: 'trunk',
      configDir: machineDir('lt'),
    });
    expect(result.branch).toBe('trunk');
    expect(await git(result.root, ['symbolic-ref', '--short', 'HEAD'])).toBe('trunk');
    await expect(
      initBrain({ dir: freshDir('local ruim'), initialBranch: 'nome ruim..', configDir: machineDir('lr') }),
    ).rejects.toThrow(/branch inválido/);
  });

  it('nome de máquina inválido é ajustado e avisado', async () => {
    const result = await initBrain({
      dir: freshDir('local nome'),
      machine: 'Mac do Renan',
      configDir: machineDir('nome'),
    });
    expect(result.machine).toBe('mac-do-renan');
    expect(result.warnings.map((warning) => warning.code)).toContain('machine-name-adjusted');
  });
});

describe('pasta de destino ocupada e idempotência', () => {
  it('pasta com outra coisa: recusa sem tocar em nada', async () => {
    const dir = sandbox.path('ocupada');
    await writeFiles(dir, { 'minhas coisas.txt': 'não mexa\n', 'sub/x.md': '# x\n' });
    const before = await readTree(dir);
    const bare = await sandbox.bare('para-ocupada.git');
    const configDir = machineDir('ocupada');
    for (const url of [bare, undefined]) {
      const result = await initBrain({ ...(url === undefined ? {} : { url }), dir, configDir });
      expect(result).toMatchObject({ ok: false, case: 'target-not-empty' });
      expect(result.message).toMatch(/não está vazia/);
      expect(await readTree(dir)).toEqual(before);
      expect(await exists(join(dir, '.git'))).toBe(false);
    }
    expect(await readMachineConfig(configDir)).toBeNull();
    expect(await git(bare, ['for-each-ref'])).toBe('');
  });

  it('destino que é um arquivo: recusa', async () => {
    const file = sandbox.path('um arquivo.txt');
    await writeFile(file, 'x');
    const result = await initBrain({ dir: file, configDir: machineDir('arquivo') });
    expect(result.case).toBe('target-not-empty');
    expect(await readFile(file, 'utf8')).toBe('x');
  });

  it('mesmo cérebro, mesma URL: idempotente e diz isso', async () => {
    const bare = await sandbox.bare('idempotente.git');
    const dir = freshDir('idempotente');
    const configDir = machineDir('idempotente');
    const first = await initBrain({ url: bare, dir, machine: 'a', configDir });
    expect(first.case).toBe('created');
    const before = await readTree(dir);
    const head = await git(dir, ['rev-parse', 'HEAD']);

    const second = await initBrain({ url: `${bare}/`, dir, machine: 'a', configDir });
    expect(second).toMatchObject({ ok: true, case: 'already-initialized', branch: 'main', pushed: false });
    expect(normalizeRemoteUrl(second.remote ?? '')).toBe(normalizeRemoteUrl(bare));
    expect(second.message).toMatch(/já é este cérebro/);
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readTree(dir)).toEqual(before);
    expect(await git(bare, ['rev-list', '--count', 'main'])).toBe('1');

    // sem URL, a mesma pasta também é reconhecida
    expect((await initBrain({ dir, configDir })).case).toBe('already-initialized');
  });

  it('cérebro já existente com commits não enviados: avisa', async () => {
    const bare = await sandbox.bare('nao-enviado.git');
    const dir = freshDir('não enviado');
    await initBrain({ url: bare, dir, machine: 'a', configDir: machineDir('ne') });
    await writeFiles(dir, { 'wiki/nova.md': '# Nova\n' });
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'local']);
    const again = await initBrain({ url: bare, dir, configDir: machineDir('ne') });
    expect(again.case).toBe('already-initialized');
    expect(again.warnings.map((warning) => warning.code)).toEqual(['unpushed-commits']);
    expect(again.nextSteps.join(' ')).toMatch(/cabecao sync/);
  });

  it('mesmo cérebro, outra URL (ou cérebro só local com URL): recusa e indica como trocar o remoto com o git', async () => {
    const bare = await sandbox.bare('outro.git');
    const other = await sandbox.bare('outro-2.git');
    const dir = freshDir('outra url');
    await initBrain({ url: bare, dir, configDir: machineDir('ou') });
    const result = await initBrain({ url: other, dir, configDir: machineDir('ou') });
    expect(result.case).toBe('target-not-empty');
    expect(result.message).not.toMatch(/cabecao remote/);
    expect(result.message).toContain('git remote set-url origin <url>');

    const local = freshDir('só local');
    await initBrain({ dir: local, configDir: machineDir('ou') });
    const withUrl = await initBrain({ url: bare, dir: local, configDir: machineDir('ou') });
    expect(withUrl.case).toBe('target-not-empty');
    expect(withUrl.message).toMatch(/só local/);
    expect(withUrl.message).toContain('git remote add origin <url>');
  });
});

describe('falha no meio desfaz o que criou', () => {
  it('envio recusado pelo servidor: rejected, sem pasta, sem configuração, remoto intacto', async () => {
    const bare = await sandbox.bare('recusa-envio.git');
    const hook = join(bare, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "recusado pelo teste" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const parent = sandbox.path('máquina envio recusado');
    const configDir = machineDir('envio-recusado');
    const result = await initBrain({ url: bare, dir: join(parent, 'c'), machine: 'a', configDir });
    expect(result).toMatchObject({ ok: false, case: 'remote-error', pushed: false, canStartLocal: true });
    expect(result.error?.category).toBe('rejected');
    expect(result.message).toMatch(/remoto ficou como estava/);
    expect(await exists(parent)).toBe(false);
    expect(await readMachineConfig(configDir)).toBeNull();
    expect(await git(bare, ['for-each-ref'])).toBe('');
  });

  it('erro numa etapa (gancho de progresso): o erro sobe e nada fica para trás, nem a configuração anterior muda', async () => {
    const configDir = machineDir('etapa');
    await mkdir(configDir, { recursive: true });
    const previousConfig = '{\n  "machine": "antiga",\n  "defaultBrain": "/outro/cerebro"\n}\n';
    await writeFile(join(configDir, 'config.json'), previousConfig);
    for (const failAt of ['clone', 'scaffold', 'commit', 'push'] as const) {
      const bare = await sandbox.bare(`etapa-${failAt}.git`);
      const parent = sandbox.path(`máquina etapa ${failAt}`);
      await expect(
        initBrain({
          url: bare,
          dir: join(parent, 'c'),
          configDir,
          hooks: {
            onStep: (step) => {
              if (step === failAt) throw new Error(`falha simulada em ${step}`);
            },
          },
        }),
      ).rejects.toThrow(`falha simulada em ${failAt}`);
      expect(await exists(parent), failAt).toBe(false);
      expect(await readFile(join(configDir, 'config.json'), 'utf8'), failAt).toBe(previousConfig);
      expect(await git(bare, ['for-each-ref']), failAt).toBe('');
    }
  });

  it('sem identidade do git: GitIdentityError, sem pasta', async () => {
    const emptyConfig = sandbox.path('gitconfig sem identidade');
    await writeFile(emptyConfig, '[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = false\n');
    const parent = sandbox.path('máquina sem identidade');
    const configDir = machineDir('sem-identidade');
    await expect(
      initBrain({
        dir: join(parent, 'c'),
        configDir,
        env: {
          GIT_CONFIG_GLOBAL: emptyConfig,
          EMAIL: undefined,
          GIT_AUTHOR_EMAIL: undefined,
          GIT_COMMITTER_EMAIL: undefined,
          GIT_AUTHOR_NAME: undefined,
          GIT_COMMITTER_NAME: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(GitIdentityError);
    expect(await exists(parent)).toBe(false);
    expect(await readMachineConfig(configDir)).toBeNull();
  });
});

describe('ganchos', () => {
  it('afterInit recebe o resultado; uma falha nele vira aviso e não desfaz nada', async () => {
    const seen: InitResult[] = [];
    const ok = await initBrain({
      dir: freshDir('gancho'),
      configDir: machineDir('gancho'),
      hooks: { afterInit: (result) => void seen.push(result) },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.case).toBe('local');

    const dir = freshDir('gancho falho');
    const failed = await initBrain({
      dir,
      configDir: machineDir('gancho-falho'),
      hooks: {
        afterInit: () => {
          throw new Error('doctor quebrou');
        },
      },
    });
    expect(failed.ok).toBe(true);
    expect(failed.warnings).toEqual([
      { code: 'hook-failed', message: 'O cérebro está pronto, mas uma etapa seguinte falhou: doctor quebrou' },
    ]);
    expect(await exists(join(dir, '.cabecao.json'))).toBe(true);
    expect(ok.ok).toBe(true);
  });

  it('afterInit não é chamado quando o init não deu certo', async () => {
    let called = false;
    const result = await initBrain({
      url: sandbox.path('nada.git'),
      dir: freshDir('sem gancho'),
      configDir: machineDir('sem-gancho'),
      hooks: {
        afterInit: () => {
          called = true;
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('remoção da pasta clonada no Windows', () => {
  it('removeTree apaga objetos somente leitura do git', async () => {
    const bare = await sandbox.seed('somente-leitura.git', 'main', { 'a.md': '# a\n' });
    const clone = sandbox.path('clone somente leitura');
    await git(sandbox.root, ['clone', '--quiet', bare, clone]);
    await removeTree(clone);
    expect(await exists(clone)).toBe(false);
  });
});
