// Conteúdo que o `cabecao obsidian setup` e o `cabecao export canvas` geram: configuração do `.obsidian/`, painéis
// `.base`, modelo do Web Clipper e mapas em JSON Canvas. Tudo função pura: os testes conferem formato, determinismo e
// que nada carrega caminho absoluto ou dado da máquina.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  buildCanvas,
  CANVAS_LAYOUT,
  type CanvasEdgeInput,
  type CanvasNoteInput,
  COLOR_GROUPS,
  canvasFile,
  canvasOverlaps,
  dashboardFiles,
  graphQuery,
  groupOf,
  type JsonCanvas,
  OTHER_GROUP,
  obsidianSettings,
  rgbInt,
  validateCanvas,
  validateClipperTemplate,
  webClipperTemplate,
  webClipperTemplateFile,
} from '../../src/obsidian/index.ts';
import { DATE_FIELDS, FIXED_RELATIONS, NOTE_TYPE_DIRS, NOTE_TYPES } from '../../src/vault/index.ts';

const ABSOLUTE = /(?:^|[\s"'(])(?:\/(?:Users|home|tmp|private|var)\/|[A-Za-z]:\\)/;

describe('configuração do .obsidian', () => {
  const settings = obsidianSettings({ relations: ['mentored_by'] });

  it('datas como data, relações e sources como lista, campos de texto como texto', () => {
    for (const field of DATE_FIELDS) expect(settings.types[field]).toBe('date');
    for (const relation of [...FIXED_RELATIONS, 'supersedes', 'superseded_by', 'sources', 'mentored_by']) {
      expect(settings.types[relation]).toBe('multitext');
    }
    for (const field of ['type', 'scope', 'trust', 'origin', 'edited_by']) expect(settings.types[field]).toBe('text');
    // tags e aliases são tipos próprios do Obsidian: o setup não mexe
    expect(settings.types.tags).toBeUndefined();
    expect(settings.types.aliases).toBeUndefined();
  });

  it('app.json: arquivo morto fora da busca, anexos em raw/assets, wikilinks', () => {
    expect(settings.appLists.userIgnoreFilters).toEqual(['memory/_archive/']);
    expect(settings.appKeys).toMatchObject({ attachmentFolderPath: 'raw/assets', useMarkdownLinks: false });
  });

  it('graph.json: um grupo por tipo e pasta, cor inteira 0xRRGGBB, arquivo morto antes de todos', () => {
    expect(settings.colorGroups[0]?.query).toBe('path:memory/_archive');
    expect(settings.colorGroups.map((group) => group.query)).toContain('[type:decision] OR path:wiki/decisions');
    expect(rgbInt('#E5484D')).toBe(15026253); // o valor que o spike 15 viu no aplicativo
    for (const group of settings.colorGroups) {
      expect(Number.isInteger(group.color.rgb)).toBe(true);
      expect(group.color.a).toBe(1);
    }
    // os painéis e mapas ficam fora do grafo
    expect(settings.freshGraph.search).toBe('-path:dashboards');
  });

  it('todo tipo de nota tem grupo de cor, e o grupo casa pelo tipo e pela pasta', () => {
    for (const type of NOTE_TYPES) {
      const byType = groupOf({ path: 'qualquer/lugar.md', type });
      const byDir = groupOf({ path: `${NOTE_TYPE_DIRS[type]}/x.md`, type: null });
      expect(byType).not.toBe(OTHER_GROUP);
      expect(byDir).toBe(byType);
      expect(graphQuery(byType)).toContain(`[type:${type}]`);
    }
    expect(groupOf({ path: 'memory/_archive/x.md', type: 'decision' }).key).toBe('archive');
    expect(groupOf({ path: 'raw/articles/x.md', type: null }).key).toBe('raw');
    expect(groupOf({ path: 'Projetos/x.md', type: null })).toBe(OTHER_GROUP);
    expect(new Set(COLOR_GROUPS.map((group) => group.color)).size).toBe(COLOR_GROUPS.length);
  });

  it('é determinística', () => {
    expect(JSON.stringify(obsidianSettings())).toBe(JSON.stringify(obsidianSettings()));
  });
});

describe('painéis .base', () => {
  const files = dashboardFiles();

  it('os cinco painéis do plano, em dashboards/', () => {
    expect(files.map((file) => file.path)).toEqual([
      'dashboards/decisoes.base',
      'dashboards/fatos.base',
      'dashboards/memorias.base',
      'dashboards/revisar.base',
      'dashboards/saude.base',
    ]);
  });

  it.each(dashboardFiles().map((file) => [file.path, file] as const))(
    '%s é YAML válido no formato do Bases',
    (_, file) => {
      const value = parse(file.content) as Record<string, unknown>;
      expect(
        Object.keys(value).every((key) => ['filters', 'formulas', 'properties', 'summaries', 'views'].includes(key)),
      ).toBe(true);
      const views = value.views as Array<Record<string, unknown>>;
      expect(views.length).toBeGreaterThan(0);
      for (const view of views) {
        expect(view.type).toBe('table');
        expect(typeof view.name).toBe('string');
        expect(Array.isArray(view.order)).toBe(true);
        if (view.groupBy !== undefined) expect(view.groupBy).toMatchObject({ property: expect.any(String) });
      }
      const filterOk = (node: unknown): boolean => {
        if (typeof node === 'string') return true;
        if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
        const entries = Object.entries(node);
        return (
          entries.length === 1 &&
          ['and', 'or', 'not'].includes(entries[0]?.[0] ?? '') &&
          Array.isArray(entries[0]?.[1]) &&
          ((entries[0]?.[1] ?? []) as unknown[]).every(filterOk)
        );
      };
      expect(filterOk(value.filters)).toBe(true);
      for (const view of views) if (view.filters !== undefined) expect(filterOk(view.filters)).toBe(true);
    },
  );

  it('sem as duas armadilhas medidas no aplicativo, sem caminho absoluto e sem nada executável', () => {
    for (const file of files) {
      // "propriedade ausente" é `prop == null`; `!prop` descarta a nota em silêncio (spike 15, item 8c)
      expect(file.content).not.toMatch(/!\s*[a-z_]+\s*(?:\|\||$|')/m);
      // dividir uma duração por outra dá erro; diferença de datas é `.days`
      expect(file.content).not.toMatch(/duration\(/);
      expect(file.content).not.toMatch(ABSOLUTE);
      expect(file.content).not.toMatch(/<script|javascript:/i);
      expect(file.content.endsWith('\n')).toBe(true);
    }
  });

  it('cobre o que o plano pede: tipos, validade, conflitos, edited_by, sem fonte, órfãs', () => {
    const all = files.map((file) => file.content).join('\n');
    for (const needle of [
      'note.type',
      'valid_until',
      'superseded_by',
      '.conflict-',
      'edited_by',
      'sources == null',
      'file.backlinks',
    ]) {
      expect(all).toContain(needle);
    }
  });
});

describe('modelo do Web Clipper', () => {
  it('passa nas regras do importador da extensão e grava em raw/articles com trust low', () => {
    const template = webClipperTemplate();
    expect(validateClipperTemplate(template)).toEqual([]);
    expect(template.path).toBe('raw/articles');
    const props = Object.fromEntries(template.properties.map((p) => [p.name, p]));
    expect(props.origin?.value).toBe('ingest:web-clipper');
    expect(props.trust?.value).toBe('low');
    expect(props.source?.value).toBe('{{url}}');
    expect(props.created?.type).toBe('date');
    // o arquivo é o JSON do modelo, sem nada da máquina
    expect(JSON.parse(webClipperTemplateFile())).toEqual(template);
    expect(webClipperTemplateFile()).not.toMatch(ABSOLUTE);
  });

  it('o validador recusa o que o importador recusa', () => {
    const base = webClipperTemplate() as unknown as Record<string, unknown>;
    const { name: _name, noteContentFormat: _format, ...withoutRequired } = base;
    expect(validateClipperTemplate(withoutRequired)).toEqual(
      expect.arrayContaining(['falta "name"', 'falta "noteContentFormat"']),
    );
    const { path: _path, ...withoutPath } = base;
    expect(validateClipperTemplate(withoutPath)).toContain('falta "noteNameFormat" ou "path"');
    expect(
      validateClipperTemplate({
        ...base,
        properties: [
          { name: 'x', value: 'y', type: 'list' },
          { name: 'trust', value: 'low' },
        ],
      }),
    ).toEqual(['propriedade "x" com tipo desconhecido']);
    expect(validateClipperTemplate({ ...base, path: 'wiki/sources' })).toContain('o recorte deveria ir para raw/');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Canvas

/** Gerador pseudoaleatório com semente (o teste de propriedade tem de ser reproduzível). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomGraph(seed: number): { notes: CanvasNoteInput[]; edges: CanvasEdgeInput[] } {
  const rand = random(seed);
  const dirs = [...Object.values(NOTE_TYPE_DIRS), 'raw/articles', 'Projetos', 'memory/_archive'];
  const count = 1 + Math.floor(rand() * 90);
  const notes: CanvasNoteInput[] = [];
  for (let i = 0; i < count; i++) {
    const dir = dirs[Math.floor(rand() * dirs.length)] as string;
    const type = rand() < 0.5 ? (NOTE_TYPES[Math.floor(rand() * NOTE_TYPES.length)] as string) : null;
    notes.push({
      path: `${dir}/nota ${i}.md`,
      title: rand() < 0.8 ? `Nota ${i}` : null,
      type,
      distance: Math.floor(rand() * 3),
    });
  }
  const edges: CanvasEdgeInput[] = [];
  const labels = ['uses', 'part_of', 'supersedes', 'link', 'subject'];
  for (let i = 0; i < count * 2; i++) {
    const from = notes[Math.floor(rand() * count)] as CanvasNoteInput;
    const to = rand() < 0.1 ? { path: 'fora/do/mapa.md' } : (notes[Math.floor(rand() * count)] as CanvasNoteInput);
    edges.push({ from: from.path, to: to.path, label: labels[Math.floor(rand() * labels.length)] as string });
  }
  return { notes, edges };
}

function groupsContainMembers(canvas: JsonCanvas): boolean {
  const groups = canvas.nodes.filter((node) => node.type === 'group');
  const files = canvas.nodes.filter((node) => node.type === 'file');
  const inside = (outer: (typeof groups)[number], inner: (typeof files)[number]): boolean =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
  const groupsApart = groups.every((a, i) =>
    groups.slice(i + 1).every((b) => a.x + a.width <= b.x || b.x + b.width <= a.x),
  );
  return (
    groupsApart && files.every((file) => groups.some((group) => group.color === file.color && inside(group, file)))
  );
}

describe('mapa em JSON Canvas', () => {
  it('propriedades em 200 grafos aleatórios: válido, sem sobreposição, arestas entre nós existentes, determinístico', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { notes, edges } = randomGraph(seed);
      const canvas = buildCanvas({ notes, edges, legend: 'legenda', center: notes[0]?.path as string });
      expect(validateCanvas(canvas), `semente ${seed}`).toEqual([]);
      expect(canvasOverlaps(canvas), `semente ${seed}`).toEqual([]);
      expect(groupsContainMembers(canvas), `semente ${seed}`).toBe(true);
      const ids = new Set(canvas.nodes.map((node) => node.id));
      for (const edge of canvas.edges) {
        expect(ids.has(edge.fromNode) && ids.has(edge.toNode)).toBe(true);
        expect(edge.fromNode).not.toBe(edge.toNode);
        expect(edge.label).toBeTruthy();
      }
      expect(canvas.nodes.filter((node) => node.type === 'file')).toHaveLength(new Set(notes.map((n) => n.path)).size);
      // mesma entrada, mesmos bytes, em qualquer ordem
      const again = buildCanvas({
        notes: [...notes].reverse(),
        edges: [...edges].reverse(),
        legend: 'legenda',
        center: notes[0]?.path as string,
      });
      expect(canvasFile(again)).toBe(canvasFile(canvas));
    }
  });

  it('cores iguais às do grafo, nota central primeiro, grupo rotulado, rótulo da relação na aresta', () => {
    const canvas = buildCanvas({
      notes: [
        { path: 'wiki/entities/SQS.md', title: 'SQS', type: 'entity', distance: 1 },
        { path: 'wiki/entities/Projeto Atlas.md', title: 'Projeto Atlas', type: 'entity', distance: 0 },
        { path: 'wiki/decisions/usar-sqs.md', title: 'Usar SQS', type: 'decision', distance: 1 },
      ],
      edges: [
        { from: 'wiki/decisions/usar-sqs.md', to: 'wiki/entities/SQS.md', label: 'uses' },
        { from: 'wiki/decisions/usar-sqs.md', to: 'wiki/entities/SQS.md', label: 'uses' },
      ],
      center: 'wiki/entities/Projeto Atlas.md',
    });
    const files = canvas.nodes.filter((node) => node.type === 'file');
    const entityColor = COLOR_GROUPS.find((group) => group.key === 'entity')?.color;
    expect(files.find((node) => node.file === 'wiki/entities/Projeto Atlas.md')).toMatchObject({
      color: entityColor,
      y: CANVAS_LAYOUT.padding,
    });
    expect(canvas.nodes.find((node) => node.type === 'group' && node.label === 'Entidades (2)')).toBeDefined();
    expect(canvas.edges).toHaveLength(1);
    expect(canvas.edges[0]).toMatchObject({ label: 'uses', toEnd: 'arrow' });
    expect(canvasFile(canvas)).not.toMatch(ABSOLUTE);
  });

  it('o validador (portado do spike 15) pega cada violação da especificação 1.0', () => {
    const bad = {
      nodes: [
        { id: 'a', type: 'file', x: 0, y: 0, width: 10, height: 10, file: '/Users/eu/nota.md' },
        { id: 'a', type: 'texto', x: 0.5, y: 0, width: 10, height: 10, color: 'vermelho' },
        { id: 'c', type: 'text', x: 0, y: 0, width: 10, height: 10 },
        { id: 'd', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'x.md', subpath: 'secao' },
        { id: 'e', type: 'link', x: 0, y: 0, width: 10, height: 10 },
        { id: 'f', type: 'group', x: 0, y: 0, width: 10, height: 10, backgroundStyle: 'stretch' },
      ],
      edges: [{ id: 'g', fromNode: 'a', toNode: 'zz', fromSide: 'middle', toEnd: 'circle' }],
    };
    const errors = validateCanvas(bad, { fileExists: () => false });
    for (const needle of [
      'caminho relativo',
      'id repetido: a',
      'type inválido',
      'x deveria ser inteiro',
      'color inválida',
      'text é obrigatório',
      'subpath deveria começar com #',
      'arquivo inexistente x.md',
      'url é obrigatório',
      'backgroundStyle inválido',
      'toNode aponta para um nó que não existe',
      'fromSide inválido',
      'toEnd inválido',
    ]) {
      expect(
        errors.some((error) => error.includes(needle)),
        needle,
      ).toBe(true);
    }
    expect(validateCanvas({})).toEqual([]); // os dois campos são opcionais
    expect(validateCanvas([])).toEqual(['o canvas deveria ser um objeto']);
  });
});
