import { mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyTree, detectRepoKind, VAULT_MIN_NOTE_SHARE, vaultLayout } from '../../src/init/index.ts';
import { brainTemplateFiles } from '../../src/init/template.ts';
import { createSandbox, git, type Sandbox, TEST_TIMEOUT_MS, writeFiles } from './helpers.ts';

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });

const brainConfig = brainTemplateFiles().find((file) => file.path === '.cabecao.json')?.content ?? '';

describe('classifyTree', () => {
  it('sem commits ou sem arquivos: vazio', () => {
    expect(classifyTree([], { hasCommits: false }).kind).toBe('empty');
    expect(classifyTree([], { hasCommits: true }).kind).toBe('empty');
  });

  it('fronteira: repositório só com um README (o "adicionar README" do provedor) é vazio', () => {
    const detection = classifyTree(['README.md']);
    expect(detection.kind).toBe('empty');
    expect(detection.reason).toMatch(/arquivos iniciais/);
    expect(classifyTree(['README.md', 'LICENSE', '.gitignore', '.gitattributes']).kind).toBe('empty');
    // um README dentro de uma pasta já é conteúdo
    expect(classifyTree(['README.md', 'docs/README.md']).kind).toBe('markdown-vault');
  });

  it('com .cabecao.json válido: cérebro', () => {
    const detection = classifyTree(['.cabecao.json', 'wiki/a.md'], { brainConfigText: brainConfig });
    expect(detection.kind).toBe('brain');
    expect(detection.config?.noteDirs).toEqual(['wiki', 'memory', 'raw']);
  });

  it('com .cabecao.json inválido ou de esquema mais novo: outra coisa, com o motivo', () => {
    const broken = classifyTree(['.cabecao.json', 'wiki/a.md'], { brainConfigText: '{ nada' });
    expect(broken.kind).toBe('other');
    expect(broken.reason).toMatch(/não é JSON válido/);
    const newer = classifyTree(['.cabecao.json'], {
      brainConfigText: JSON.stringify({ schemaVersion: 99, noteDirs: ['wiki'], indexMd: 'index.md' }),
    });
    expect(newer.kind).toBe('other');
    expect(newer.reason).toMatch(/Atualize o Cabeção/);
  });

  it('vault do Obsidian: pela pasta .obsidian/, mesmo com muitos anexos', () => {
    const detection = classifyTree(['.obsidian/app.json', 'Diário/2026-11-01.md', 'anexos/a.png', 'anexos/b.png']);
    expect(detection.kind).toBe('markdown-vault');
    expect(detection.stats.obsidian).toBe(true);
  });

  it('fronteira: vault de Markdown comum com alguns anexos e imagens', () => {
    const paths = [
      'Projetos/Alfa/plano.md',
      'Projetos/Alfa/diagrama.excalidraw',
      'Diário/2026-11-01.md',
      'Diário/2026-11-02.md',
      'anexos/foto.png',
      'anexos/foto 2.jpg',
      'anexos/scan.pdf',
      'mapa.canvas',
      'README.md',
    ];
    const detection = classifyTree(paths);
    expect(detection.kind).toBe('markdown-vault');
    expect(detection.stats).toMatchObject({ markdown: 3, attachments: 5, code: 0, content: 8 });
  });

  it('vault com poucas imagens e muitas notas, e só imagens com uma nota', () => {
    expect(classifyTree(['a.md', 'b.md', 'c.png']).kind).toBe('markdown-vault');
    expect(classifyTree(['nota.md', 'f1.png', 'f2.png', 'f3.png', 'f4.png', 'f5.png']).kind).toBe('markdown-vault');
  });

  it(`limiar de ${VAULT_MIN_NOTE_SHARE * 100}%: 8 notas e 2 scripts passam; 7 e 3 não`, () => {
    const notes = (n: number) => Array.from({ length: n }, (_, i) => `notas/n${i}.md`);
    const scripts = (n: number) => Array.from({ length: n }, (_, i) => `scripts/s${i}.js`);
    expect(classifyTree([...notes(8), ...scripts(2)]).kind).toBe('markdown-vault');
    const below = classifyTree([...notes(7), ...scripts(3)]);
    expect(below.kind).toBe('other');
    expect(below.reason).toMatch(/70%/);
  });

  it('projeto de código: por marcador na raiz ou pela pasta src/', () => {
    const node = classifyTree(['package.json', 'src/index.ts', 'README.md', 'docs/a.md', 'docs/b.md']);
    expect(node.kind).toBe('other');
    expect(node.stats.codeMarkers).toEqual(['package.json', 'src/']);
    expect(node.reason).toMatch(/projeto de código/);
    expect(classifyTree(['src/main.rs', 'notas.md']).kind).toBe('other');
    expect(classifyTree(['App.sln', 'a.md']).kind).toBe('other');
    // marcador vence até a pasta .obsidian/
    expect(classifyTree(['.obsidian/app.json', 'go.mod', 'a.md']).kind).toBe('other');
    // site de documentação em Markdown não é vault
    expect(classifyTree(['mkdocs.yml', 'docs/index.md', 'docs/guia.md']).kind).toBe('other');
  });

  it('sem nenhum Markdown: outra coisa', () => {
    const detection = classifyTree(['dados.csv', 'planilha.xlsx']);
    expect(detection.kind).toBe('other');
    expect(detection.reason).toMatch(/Markdown/);
    expect(classifyTree(['.vscode/settings.json']).kind).toBe('other');
  });

  it('normaliza para NFC e ordena os caminhos', () => {
    const detection = classifyTree(['b.md', 'Diário/a.md']);
    expect(detection.paths).toEqual(['Diário/a.md', 'b.md']);
  });
});

describe('vaultLayout', () => {
  it('pastas padrão do Cabeção mais as pastas que já têm notas', () => {
    const layout = vaultLayout([
      'Diário/a.md',
      'Projetos/Alfa/b.md',
      'anexos/c.png',
      '.obsidian/app.json',
      'README.md',
    ]);
    expect(layout).toEqual({ noteDirs: ['wiki', 'memory', 'raw', 'Diário', 'Projetos'], rootNotes: [] });
  });

  it('uma pasta padrão com outra caixa usa a grafia que já existe', () => {
    expect(vaultLayout(['Wiki/a.md']).noteDirs).toEqual(['Wiki', 'memory', 'raw']);
  });

  it('notas soltas na raiz: a raiz inteira', () => {
    const layout = vaultLayout(['ideia.md', 'Diário/a.md', 'README.md', 'AGENTS.md']);
    expect(layout).toEqual({ noteDirs: ['.'], rootNotes: ['ideia.md'] });
  });
});

describe('detectRepoKind', () => {
  let sandbox: Sandbox;
  beforeAll(async () => {
    sandbox = await createSandbox();
  });
  afterAll(async () => {
    await sandbox.cleanup();
  });

  it('repositório sem commits: vazio', async () => {
    const dir = sandbox.path('sem commits');
    await mkdir(dir);
    await git(dir, ['init', '--quiet']);
    const detection = await detectRepoKind(dir);
    expect(detection.kind).toBe('empty');
    expect(detection.stats.hasCommits).toBe(false);
  });

  it('lê o commit, não a pasta de trabalho (clone com --no-checkout)', async () => {
    const bare = await sandbox.seed('vault.git', 'master', {
      '.obsidian/app.json': '{}',
      'Diário/2026-11-01.md': '# Dia\n',
    });
    const clone = sandbox.path('clone sem checkout');
    await git(sandbox.root, ['clone', '--quiet', '--no-checkout', bare, clone]);
    const detection = await detectRepoKind(clone);
    expect(detection.kind).toBe('markdown-vault');
    expect(detection.paths).toEqual(['.obsidian/app.json', 'Diário/2026-11-01.md']);
  });

  it('cérebro: lê e valida o .cabecao.json do commit', async () => {
    const bare = await sandbox.seed('cerebro.git', 'trunk', { '.cabecao.json': brainConfig, 'wiki/a.md': '# A\n' });
    const clone = sandbox.path('clone do cérebro');
    await git(sandbox.root, ['clone', '--quiet', '--no-checkout', bare, clone]);
    const detection = await detectRepoKind(clone);
    expect(detection.kind).toBe('brain');
    expect(detection.config?.indexMd).toBe('index.md');
  });

  it('pasta que não é repositório: pelos arquivos que há nela', async () => {
    const dir = sandbox.path('pasta comum');
    await writeFiles(dir, { 'notas/a.md': '# A\n', 'notas/b.md': '# B\n' });
    expect((await detectRepoKind(dir)).kind).toBe('markdown-vault');
    const empty = sandbox.path('pasta vazia');
    await mkdir(empty);
    expect((await detectRepoKind(empty)).kind).toBe('empty');
  });

  it('referência inexistente: vazio; referência que parece opção: recusada', async () => {
    const dir = sandbox.path('sem commits');
    expect((await detectRepoKind(dir, { ref: 'refs/heads/nada' })).kind).toBe('empty');
    await expect(detectRepoKind(dir, { ref: '--output=x' })).rejects.toThrow(TypeError);
  });
});
