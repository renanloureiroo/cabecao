import { describe, expect, it } from 'vitest';
import { normalizeLinkTarget, parseNote } from '../../src/markdown/index.ts';

const targets = (src: string): string[] => parseNote(src).links.map((l) => l.target);

describe('títulos e seções', () => {
  const src = [
    'intro [[Antes]]', // 1
    '', // 2
    '# Um', // 3
    'a', // 4
    '## Dois', // 5
    'b [[B]]', // 6
    '### Três', // 7
    'c', // 8
    '## Quatro', // 9
    'd', // 10
    '# Cinco', // 11
    '',
  ].join('\n');

  it('monta o headingPath com a pilha de níveis', () => {
    const note = parseNote(src);
    expect(note.headings.map((h) => [h.level, h.line, h.headingPath])).toEqual([
      [1, 3, ['Um']],
      [2, 5, ['Um', 'Dois']],
      [3, 7, ['Um', 'Dois', 'Três']],
      [2, 9, ['Um', 'Quatro']],
      [1, 11, ['Cinco']],
    ]);
    expect(note.headings.every((h) => h.style === 'atx')).toBe(true);
  });

  it('seções vão de um título até a linha antes do próximo; o texto inicial é uma seção sem título', () => {
    const note = parseNote(src);
    expect(note.sections.map((s) => [s.heading?.text ?? null, s.startLine, s.endLine])).toEqual([
      [null, 1, 2],
      ['Um', 3, 4],
      ['Dois', 5, 6],
      ['Três', 7, 8],
      ['Quatro', 9, 10],
      ['Cinco', 11, 11],
    ]);
    expect(note.sections[0]?.headingPath).toEqual([]);
  });

  it('nível pulado não inventa ancestral', () => {
    const note = parseNote('### Fundo\n\n# Topo\n\n#### Bem fundo\n');
    expect(note.headings.map((h) => h.headingPath)).toEqual([['Fundo'], ['Topo'], ['Topo', 'Bem fundo']]);
  });

  it('linhas contam o frontmatter', () => {
    const note = parseNote('---\na: 1\nb: 2\n---\n\n# T\n\nver [[X]]\n');
    expect(note.headings[0]?.line).toBe(6);
    expect(note.links[0]).toMatchObject({ target: 'X', line: 8, column: 5, headingPath: ['T'] });
    expect(note.sections).toEqual([{ heading: note.headings[0], headingPath: ['T'], startLine: 6, endLine: 8 }]);
  });

  it('setext: nível, linha do título e seção do link que está no título', () => {
    const note = parseNote('# Topo\n\nSobre o [[SQS]]\n---\n\ncorpo [[X]]\n');
    expect(note.headings.map((h) => [h.level, h.text, h.line, h.style])).toEqual([
      [1, 'Topo', 1, 'atx'],
      [2, 'Sobre o [[SQS]]', 3, 'setext'],
    ]);
    expect(note.links.map((l) => [l.target, l.headingPath])).toEqual([
      ['SQS', ['Topo', 'Sobre o [[SQS]]']],
      ['X', ['Topo', 'Sobre o [[SQS]]']],
    ]);
    // o texto do título setext não vira trecho
    expect(note.chunks.map((c) => c.text)).toEqual(['corpo [[X]]']);
  });

  it('--- depois de lista, citação, tabela ou código é linha horizontal, não título', () => {
    for (const src of [
      '- item\n---\n',
      '> citação\n---\n',
      '| a |\n---\n',
      '```\ncódigo\n```\n---\n',
      '    código\n---\n',
    ]) {
      expect(parseNote(src).headings, src).toEqual([]);
    }
  });

  it('título vazio e # sem espaço não são títulos', () => {
    expect(parseNote('## \n\n#\n\n#tag\n\n####### sete\n').headings).toEqual([]);
  });

  it('título com mais de 3 espaços de recuo é código', () => {
    expect(parseNote('   # Vale\n\n    # Não vale\n').headings.map((h) => h.text)).toEqual(['Vale']);
  });

  it('linha horizontal separa blocos e não entra nos trechos', () => {
    const note = parseNote('um\n\n---\n\ndois\n\n***\n\n_ _ _\n');
    expect(note.headings).toEqual([]);
    expect(note.chunks.map((c) => c.text)).toEqual(['um\n\ndois']);
  });
});

describe('wikilinks no corpo', () => {
  it('guarda linha, coluna e seção', () => {
    const note = parseNote('# A\n\ntexto [[Um]] e ![[dois.png]]\n\n## B\n\n- [[Três#s|t]]\n');
    expect(note.links).toEqual([
      { embed: false, target: 'Um', anchor: null, alias: null, line: 3, column: 7, headingPath: ['A'] },
      { embed: true, target: 'dois.png', anchor: null, alias: null, line: 3, column: 16, headingPath: ['A'] },
      { embed: false, target: 'Três', anchor: 's', alias: 't', line: 7, column: 3, headingPath: ['A', 'B'] },
    ]);
  });

  it('a coluna continua certa depois de código inline e de comentário', () => {
    const line = 'a `[[x]]` %%[[y]]%% <!-- [[z]] --> [[Real]]';
    const note = parseNote(line);
    expect(note.links).toHaveLength(1);
    expect(note.links[0]?.column).toBe(line.indexOf('[[Real]]') + 1);
  });

  it('âncoras: seção aninhada, bloco e só âncora', () => {
    const note = parseNote('[[Nota#A#B]] [[Nota#^bloco1]] [[#^local]] [[Nota#]] [[Nota|]]');
    expect(note.links.map((l) => [l.target, l.anchor, l.alias])).toEqual([
      ['Nota', 'A#B', null],
      ['Nota', '^bloco1', null],
      ['', '^local', null],
      ['Nota', null, null],
      ['Nota', null, null],
    ]);
  });

  it('embed com tamanho usa o apelido; apelido pode ter |', () => {
    const note = parseNote('![[foto.png|300]] e [[A|b|c]]');
    expect(note.links.map((l) => [l.embed, l.target, l.alias])).toEqual([
      [true, 'foto.png', '300'],
      [false, 'A', 'b|c'],
    ]);
  });

  it('ignora links vazios e malformados', () => {
    expect(targets('[[]] [[ ]] [[|x]] [[a]b]] [[a\nb]] [a] [[[Certo]]]')).toEqual(['Certo']);
  });

  it('colchete escapado não abre link; barra escapada antes do link não atrapalha', () => {
    expect(targets('\\[[Falso]] e \\\\[[Real]]')).toEqual(['Real']);
  });

  it('crase escapada não abre código inline', () => {
    expect(targets('uma \\` crase, [[A]] e outra ` solta [[B]]')).toEqual(['A', 'B']);
  });

  it('crase sem par na linha não esconde o resto', () => {
    expect(targets('custa ` 5 e [[Real]]')).toEqual(['Real']);
  });

  it('código indentado com várias linhas, e o parágrafo seguinte volta a valer', () => {
    expect(targets('texto\n\n    [[F1]]\n    [[F2]]\n\t[[F3]]\n\n[[Real]]')).toEqual(['Real']);
  });

  it('linha recuada dentro de parágrafo não é código', () => {
    expect(targets('começo\n    continua [[Real]]')).toEqual(['Real']);
  });

  it('item de lista aninhado e parágrafo de continuação depois de linha em branco não são código', () => {
    expect(targets('- a\n\n\t- b [[B]]\n\n    continuação [[C]]\n')).toEqual(['B', 'C']);
    expect(targets('1. a\n\n    - b [[B]]\n')).toEqual(['B']);
  });

  it('código indentado dentro de item de lista (recuo do conteúdo + 4) continua ignorado', () => {
    expect(targets('- a\n\n      [[Falso]]\n\n- b [[Real]]\n')).toEqual(['Real']);
  });

  it('a lista acaba em parágrafo sem recuo; depois disso, 4 espaços voltam a ser código', () => {
    expect(targets('- a\n\nparágrafo\n\n    [[Falso]]\n')).toEqual([]);
    expect(targets('- a\n\n# T\n\n    [[Falso]]\n')).toEqual([]);
  });

  it('cerca: fechamento precisa do mesmo caractere, do mesmo tamanho ou maior e sem texto depois', () => {
    expect(targets('```\n[[F1]]\n~~~\n[[F2]]\n``\n[[F3]]\n``` js\n[[F4]]\n````\n[[Real]]')).toEqual(['Real']);
  });

  it('``` com crase na mesma linha é código inline, não cerca', () => {
    expect(targets('```[[F]]``` e [[Real]]\n[[Real2]]')).toEqual(['Real', 'Real2']);
  });

  it('cerca aberta em citação acaba quando a citação acaba', () => {
    const note = parseNote('> ```\n> [[Falso]]\n\n# Título\n\n[[Real]]\n');
    expect(note.links.map((l) => l.target)).toEqual(['Real']);
    expect(note.headings.map((h) => h.text)).toEqual(['Título']);
  });

  it('comentário %% que abre no meio da linha esconde o resto e as linhas seguintes', () => {
    expect(targets('[[A]] %% rascunho [[F1]]\n[[F2]]\n\n# não é título [[F3]]\nfim %% [[B]]\n\n[[C]]')).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(parseNote('x %%\n# Escondido\n%%\n\n# Visível\n').headings.map((h) => h.text)).toEqual(['Visível']);
  });

  it('comentário HTML de várias linhas: vale o texto depois do -->', () => {
    expect(targets('[[A]] <!-- [[F1]]\n[[F2]]\n--> [[B]]\n[[C]]')).toEqual(['A', 'B', 'C']);
  });

  it('cerca dentro de comentário não é cerca; comentário dentro de cerca não é comentário', () => {
    expect(targets('%%\n```\n%%\n[[Real]]')).toEqual(['Real']);
    expect(targets('```\n%%\n```\n[[Real]]')).toEqual(['Real']);
  });

  it('link em citação, tabela e título', () => {
    expect(targets('> [[A]]\n\n| x | [[B]] |\n\n### T [[C]] ###\n')).toEqual(['A', 'B', 'C']);
  });

  it('não confunde wikilink seguido de parênteses com link Markdown', () => {
    const note = parseNote('[[Nota]](obs) e [texto](a/b.md) e [x](#local) e [y](mailto:a@b.c)');
    expect(note.links.map((l) => l.target)).toEqual(['Nota']);
    expect(note.markdownLinks).toEqual([
      { embed: false, target: 'a/b', anchor: null, text: 'texto', line: 1, column: 17, headingPath: [] },
    ]);
  });

  it('texto de link Markdown mantém o código inline; link dentro de código inline não conta', () => {
    const note = parseNote('ver [`RESULTS.md`](./RESULTS.md) e `[falso](x.md)` e [a [b](c.md)');
    expect(note.markdownLinks.map((l) => [l.target, l.text, l.column])).toEqual([
      ['./RESULTS', '`RESULTS.md`', 5],
      ['c', 'b', 57],
    ]);
  });

  it('link Markdown com % inválido não lança', () => {
    expect(parseNote('[x](a%ZZb.md)').markdownLinks[0]?.target).toBe('a%ZZb');
  });
});

describe('normalizeLinkTarget', () => {
  it('compara sem diferenciar maiúsculas e formas Unicode (NFC e NFD)', () => {
    const nfc = 'Idempotência';
    const nfd = 'Idempotência';
    expect(nfc).not.toBe(nfd);
    expect(normalizeLinkTarget(nfd)).toBe(normalizeLinkTarget(nfc));
    expect(normalizeLinkTarget('PROJETO Atlas')).toBe('projeto atlas');
    expect(normalizeLinkTarget('Cabeção')).toBe(normalizeLinkTarget('CABEÇÃO'));
    expect(normalizeLinkTarget(nfd)).toBe('idempotência');
  });

  it('apara espaços, tira a extensão .md e mantém o caminho', () => {
    expect(normalizeLinkTarget('  Nota A.md ')).toBe('nota a');
    expect(normalizeLinkTarget('Nota.MD')).toBe('nota');
    expect(normalizeLinkTarget('wiki/Entities/SQS')).toBe('wiki/entities/sqs');
    expect(normalizeLinkTarget('diagrama.png')).toBe('diagrama.png');
  });

  it('é idempotente', () => {
    for (const target of ['Nota A.md', 'Idempotência', 'İstanbul', 'straße', '']) {
      const once = normalizeLinkTarget(target);
      expect(normalizeLinkTarget(once)).toBe(once);
    }
  });
});
