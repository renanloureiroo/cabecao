// `cabecao obsidian setup`, `cabecao export canvas` e `cabecao upgrade` sobre cópias do cérebro de exemplo, e as
// restrições de segurança: nenhum agente escreve em `.obsidian/` nem gera `.base`/`.canvas`. Nada toca na
// configuração real do Obsidian: a pasta do usuário é temporária e o executor de comandos é um falso.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canvasOverlaps, dashboardFiles, type JsonCanvas, validateCanvas } from '@cabecao/core';
import { TOOL_NAMES } from '@cabecao/server';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { obsidianConfigCandidates } from '../src/obsidian/detect.ts';
import {
  brainRepo,
  closeOpened,
  disposeSandbox,
  git,
  HUMAN,
  machine,
  openAsAgent,
  parseJson,
  SANDBOX,
  TEST_TIMEOUT_MS,
} from './helpers.ts';

let brain: string;
let m: ReturnType<typeof machine>;

beforeEach(async () => {
  brain = await brainRepo();
  m = machine();
});

afterEach(async () => {
  await closeOpened();
});

afterAll(() => {
  disposeSandbox();
});

const read = (rel: string): string => readFileSync(join(brain, ...rel.split('/')), 'utf8');
const write = async (rel: string, text: string): Promise<void> => {
  const path = join(brain, ...rel.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/** Configuração de um usuário que já usa o Obsidian (formato real, 2 espaços, sem quebra no fim). */
const USER_APP = `{
  "newLinkFormat": "relative",
  "userIgnoreFilters": [
    "private/"
  ],
  "promptDelete": false
}`;
const USER_GRAPH = `{
  "collapse-filter": true,
  "search": "-tag:#arquivo",
  "colorGroups": [
    {
      "query": "tag:#pessoal",
      "color": {
        "a": 1,
        "rgb": 16711935
      }
    },
    {
      "query": "[type:decision] OR path:wiki/decisions",
      "color": {
        "a": 1,
        "rgb": 255
      }
    }
  ],
  "scale": 0.73
}`;
const USER_TYPES = `{
  "types": {
    "created": "datetime",
    "rating": "number"
  }
}`;

describe('obsidian setup', { timeout: TEST_TIMEOUT_MS }, () => {
  it('cérebro sem .obsidian: cria os três arquivos, os painéis e o modelo; a segunda vez não muda nada', async () => {
    const first = await m.cabecao(['obsidian', 'setup', '--brain', brain]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('+ .obsidian/graph.json (criado)');
    const app = JSON.parse(read('.obsidian/app.json'));
    expect(app).toMatchObject({ userIgnoreFilters: ['memory/_archive/'], attachmentFolderPath: 'raw/assets' });
    expect(JSON.parse(read('.obsidian/types.json')).types).toMatchObject({ valid_until: 'date', uses: 'multitext' });
    for (const file of dashboardFiles()) expect(read(file.path)).toBe(file.content);
    expect(JSON.parse(read('dashboards/cabecao-web-clipper.json')).path).toBe('raw/articles');
    expect(existsSync(join(brain, '.obsidian', 'workspace.json'))).toBe(false);
    // nada gerado carrega caminho desta máquina
    for (const rel of [
      '.obsidian/app.json',
      '.obsidian/graph.json',
      '.obsidian/types.json',
      'dashboards/cabecao-web-clipper.json',
    ]) {
      expect(read(rel)).not.toContain(SANDBOX);
      expect(read(rel)).not.toContain(m.home);
    }

    const before = ['app', 'graph', 'types'].map((name) => read(`.obsidian/${name}.json`));
    const second = await m.cabecao(['obsidian', 'setup', '--brain', brain, '--json']);
    const json = parseJson(second);
    expect(json.data.files.every((file: { status: string }) => file.status === 'unchanged')).toBe(true);
    expect(['app', 'graph', 'types'].map((name) => read(`.obsidian/${name}.json`))).toEqual(before);
  });

  it('mescla com o que o usuário tem: só acrescenta, sem trocar, tirar, reordenar nem reformatar; backup uma vez', async () => {
    await write('.obsidian/app.json', USER_APP);
    await write('.obsidian/graph.json', USER_GRAPH);
    await write('.obsidian/types.json', USER_TYPES);
    await write('.obsidian/workspace.json', '{"main":{}}');

    const dry = await m.cabecao(['obsidian', 'setup', '--dry-run', '--brain', brain]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('simulação');
    expect(dry.stdout).toContain('+    "memory/_archive/"');
    expect(read('.obsidian/app.json')).toBe(USER_APP);
    expect(existsSync(join(brain, 'dashboards', 'memorias.base'))).toBe(false);

    const result = await m.cabecao(['obsidian', 'setup', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mantido como você tinha: newLinkFormat = "relative"');
    expect(result.stdout).toContain('[type:decision] OR path:wiki/decisions" com a cor que você escolheu');
    expect(result.stdout).toContain('created como "datetime"');

    const app = read('.obsidian/app.json');
    // o texto do usuário continua ali, só com o acréscimo
    expect(app).toBe(`{
  "newLinkFormat": "relative",
  "userIgnoreFilters": [
    "private/",
    "memory/_archive/"
  ],
  "promptDelete": false,
  "useMarkdownLinks": false,
  "alwaysUpdateLinks": true,
  "attachmentFolderPath": "raw/assets"
}`);
    const graph = JSON.parse(read('.obsidian/graph.json'));
    expect(Object.keys(graph)).toEqual(['collapse-filter', 'search', 'colorGroups', 'scale']);
    expect(graph.search).toBe('-tag:#arquivo');
    expect(graph.colorGroups.slice(0, 2)).toEqual(JSON.parse(USER_GRAPH).colorGroups);
    expect(graph.colorGroups.filter((g: { query: string }) => g.query.includes('wiki/decisions'))).toHaveLength(1);
    expect(read('.obsidian/graph.json').startsWith(USER_GRAPH.slice(0, USER_GRAPH.lastIndexOf('    }\n  ]')))).toBe(
      true,
    );
    const types = JSON.parse(read('.obsidian/types.json')).types;
    expect(types).toMatchObject({ created: 'datetime', rating: 'number', uses: 'multitext' });
    expect(Object.keys(types).slice(0, 2)).toEqual(['created', 'rating']);
    expect(read('.obsidian/workspace.json')).toBe('{"main":{}}');

    // cópia do original, uma vez só
    expect(read('.cabecao/backups/obsidian/app.json.bak')).toBe(USER_APP);
    await m.cabecao(['obsidian', 'setup', '--brain', brain]);
    expect(read('.cabecao/backups/obsidian/app.json.bak')).toBe(USER_APP);
    // .cabecao/ é local: nada disso vai para o git
    expect(await git(brain, ['status', '--porcelain', '--', '.cabecao'])).toBe('');

    // --remove tira só o que o Cabeção pôs: os arquivos voltam byte a byte
    const removed = await m.cabecao(['obsidian', 'setup', '--remove', '--brain', brain]);
    expect(removed.code).toBe(0);
    expect(read('.obsidian/app.json')).toBe(USER_APP);
    expect(read('.obsidian/graph.json')).toBe(USER_GRAPH);
    expect(read('.obsidian/types.json')).toBe(USER_TYPES);
    expect(existsSync(join(brain, 'dashboards', 'memorias.base'))).toBe(false);
    expect(existsSync(join(brain, '.cabecao', 'obsidian-setup.json'))).toBe(false);
    const again = await m.cabecao(['obsidian', 'setup', '--remove', '--brain', brain]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('.cabecao/backups/obsidian');
  });

  it('--remove não tira o que o usuário mudou depois; painel editado nunca é substituído', async () => {
    await m.cabecao(['obsidian', 'setup', '--brain', brain]);
    const app = JSON.parse(read('.obsidian/app.json'));
    app.attachmentFolderPath = 'anexos';
    await write('.obsidian/app.json', JSON.stringify(app, null, 2));
    await write('dashboards/fatos.base', 'views: []\n');
    const second = await m.cabecao(['obsidian', 'setup', '--brain', brain]);
    expect(second.stdout).toContain('! dashboards/fatos.base (mantido)');
    expect(read('dashboards/fatos.base')).toBe('views: []\n');

    await m.cabecao(['obsidian', 'setup', '--remove', '--brain', brain]);
    expect(JSON.parse(read('.obsidian/app.json'))).toEqual({ attachmentFolderPath: 'anexos' });
    expect(read('dashboards/fatos.base')).toBe('views: []\n');
  });

  it('JSON inválido não é tocado (código 1); os outros arquivos seguem', async () => {
    await write('.obsidian/graph.json', '{ "colorGroups": [ ');
    const result = await m.cabecao(['obsidian', 'setup', '--brain', brain]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('✗ .obsidian/graph.json (não tocado)');
    expect(read('.obsidian/graph.json')).toBe('{ "colorGroups": [ ');
    expect(existsSync(join(brain, '.obsidian', 'app.json'))).toBe(true);
  });

  it('com o Obsidian aberto neste vault, recusa gravar (a não ser com --force); a simulação só avisa', async () => {
    const config = obsidianConfigCandidates(m.io)[0] as string;
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, JSON.stringify({ vaults: { abc: { path: brain, ts: 1, open: true } } }));
    // a resposta de "pgrep -x -i obsidian" (PIDs) ou, no Windows, a linha do "tasklist" com o processo
    const running = {
      code: 0,
      stdout:
        process.platform === 'win32' ? 'Obsidian.exe                  4242 Console    1    150.000 K\r\n' : '4242\n',
      stderr: '',
    };

    m.replies.push(running);
    const dry = await m.cabecao(['obsidian', 'setup', '--dry-run', '--brain', brain]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('O Obsidian parece estar aberto');

    m.replies.push(running);
    const refused = await m.cabecao(['obsidian', 'setup', '--brain', brain, '--json']);
    expect(refused.code).toBe(1);
    expect(parseJson(refused).error.code).toBe('obsidian_open');
    expect(existsSync(join(brain, '.obsidian'))).toBe(false);
    // só consultou a lista de processos; nada foi executado no Obsidian
    expect(m.calls.every((call) => ['pgrep', 'tasklist'].includes(call.file))).toBe(true);

    m.replies.push(running);
    expect((await m.cabecao(['obsidian', 'setup', '--force', '--brain', brain])).code).toBe(0);
    expect(existsSync(join(brain, '.obsidian', 'app.json'))).toBe(true);
    // e a configuração do Obsidian não foi alterada
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ vaults: { abc: { path: brain, ts: 1, open: true } } });
  });

  it('clipper: imprime o modelo em JSON', async () => {
    const result = await m.cabecao(['obsidian', 'clipper']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '0.1.0',
      behavior: 'create',
      path: 'raw/articles',
    });
    expect((await m.cabecao(['obsidian'])).code).toBe(2);
  });
});

describe('export canvas', { timeout: TEST_TIMEOUT_MS }, () => {
  const canvasAt = (rel: string): JsonCanvas => JSON.parse(read(rel)) as JsonCanvas;

  it('vizinhança de uma nota: arquivo válido em dashboards/, notas existentes, sem sobreposição', async () => {
    const result = await m.cabecao(['export', 'canvas', '--node', 'Projeto Atlas', '--depth', '2', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Mapa: dashboards/mapa-projeto-atlas.canvas');
    const canvas = canvasAt('dashboards/mapa-projeto-atlas.canvas');
    expect(validateCanvas(canvas, { fileExists: (path) => existsSync(join(brain, ...path.split('/'))) })).toEqual([]);
    expect(canvasOverlaps(canvas)).toEqual([]);
    const files = canvas.nodes.filter((node) => node.type === 'file').map((node) => node.file);
    expect(files).toContain('wiki/entities/Projeto Atlas.md');
    expect(files.some((file) => file?.startsWith('memory/_archive/'))).toBe(false);
    const labels = new Set(canvas.edges.map((edge) => edge.label));
    for (const label of ['part_of', 'uses', 'supersedes', 'subject']) expect(labels.has(label)).toBe(true);
    expect(read('dashboards/mapa-projeto-atlas.canvas')).not.toContain(SANDBOX);

    // não substitui um mapa existente (pode ter a arrumação do usuário) sem --force
    const again = await m.cabecao(['export', 'canvas', '--node', 'Projeto Atlas', '--brain', brain]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('--force');
    expect((await m.cabecao(['export', 'canvas', '--node', 'Projeto Atlas', '--force', '--brain', brain])).code).toBe(
      0,
    );
  });

  it('escopo, limite com aviso, saída com -o e erros de uso', async () => {
    const scoped = parseJson(
      await m.cabecao(['export', 'canvas', '--scope', 'project:atlas', '--brain', brain, '--json']),
    );
    expect(scoped.data).toMatchObject({
      path: 'dashboards/mapa-project-atlas.canvas',
      scope: 'project:atlas',
      omitted: 0,
    });
    const limited = await m.cabecao([
      'export',
      'canvas',
      '--limit',
      '3',
      '-o',
      join(brain, 'mapas', 'pequeno.canvas'),
      '--brain',
      brain,
    ]);
    expect(limited.code).toBe(0);
    expect(limited.stdout).toMatch(/ficaram de fora pelo limite de 3/);
    expect(canvasAt('mapas/pequeno.canvas').nodes.filter((node) => node.type === 'file')).toHaveLength(3);

    expect((await m.cabecao(['export', 'canvas', '--depth', '2', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['export', 'pdf', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['export', 'canvas', '-o', 'mapa.json', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['export', 'canvas', '--node', 'Nota que não existe', '--brain', brain])).code).toBe(1);
  });
});

describe('upgrade', { timeout: TEST_TIMEOUT_MS }, () => {
  it('esquema em dia; o modelo antigo aparece no status e o --template aplica', async () => {
    const result = await m.cabecao(['upgrade', '--brain', brain], HUMAN);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Esquema 1: em dia');

    // o cérebro de exemplo tem um .gitignore curto: há linhas do modelo a acrescentar
    const status = await m.cabecao(['status', '--brain', brain]);
    expect(status.stdout).toContain('Modelo do cérebro: atualização opcional (.gitignore)');
    expect(parseJson(await m.cabecao(['status', '--brain', brain, '--json'])).data.upgrade).toMatchObject({
      schema_version: 1,
      supported: 1,
      pending: 0,
      template: ['.gitignore'],
    });

    const dry = await m.cabecao(['upgrade', '--template', '--dry-run', '--brain', brain], HUMAN);
    expect(dry.stdout).toContain('AGENTS.md: editado por você');
    expect(dry.stdout).toContain('Diferença entre o seu AGENTS.md e o modelo atual');
    const agents = read('AGENTS.md');

    // sem terminal e sem --yes: o AGENTS.md editado fica, e o modelo novo vai para .cabecao/template/
    const applied = await m.cabecao(['upgrade', '--template', '--brain', brain], HUMAN);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain('.gitignore: linhas acrescentadas');
    expect(applied.stdout).toContain('.cabecao/template/AGENTS.md');
    expect(read('AGENTS.md')).toBe(agents);
    expect(read('.gitignore')).toContain('.obsidian/workspace.json');
    expect(await git(brain, ['status', '--porcelain'])).toBe('');
    expect((await m.cabecao(['status', '--brain', brain])).stdout).not.toContain('Modelo do cérebro');
  });

  it('pergunta antes de trocar um arquivo editado', async () => {
    const questions: string[] = [];
    const result = await m.cabecao(['upgrade', '--template', '--brain', brain], {
      // o usuário no terminal (upgrade é só dele): a pergunta vai ao terminal controlador
      terminal: {
        prompt: async (question: string) => {
          questions.push(question);
          return 's';
        },
      },
    });
    expect(result.code).toBe(0);
    expect(questions).toEqual([expect.stringContaining('Trocar o seu AGENTS.md pelo modelo atual?')]);
    expect(read('AGENTS.md')).toContain('# Regras deste cérebro');
    expect(read('AGENTS.md')).toContain('handoff_save');
  });
});

describe('segurança: nada disso é tool, e nenhum agente escreve configuração ou painel', {
  timeout: TEST_TIMEOUT_MS,
}, () => {
  it('as tools do servidor não incluem setup, export nem upgrade', () => {
    expect(TOOL_NAMES).toHaveLength(17);
    for (const name of TOOL_NAMES) expect(name).not.toMatch(/obsidian|export|canvas|upgrade|migrat|dashboard|template/);
  });

  it.each([
    '.obsidian/app.json',
    '.obsidian/plugins/x/main.js',
    '.obsidian/snippets/estilo.css',
    'dashboards/memorias.base',
    'dashboards/mapa.canvas',
    '.obsidian/notas.md',
  ])('write_page e patch_page em %s são recusados', async (path) => {
    const agent = await openAsAgent(brain);
    await expect(agent.writePage({ path, content: 'filters: {}\n', mode: 'create' })).rejects.toThrow();
    await expect(agent.writePage({ path, content: 'x', mode: 'overwrite' })).rejects.toThrow();
    await expect(agent.patchPage({ path, old: 'a', new: 'b' })).rejects.toThrow();
    expect(existsSync(join(brain, ...path.split('/')))).toBe(false);
  });
});
