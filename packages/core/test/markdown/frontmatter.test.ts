import { describe, expect, it } from 'vitest';
import { parseNote, splitFrontmatter } from '../../src/markdown/index.ts';

describe('frontmatter', () => {
  it('nota sem frontmatter: tudo é corpo', () => {
    const note = parseNote('# T\n\ntexto\n');
    expect(note.hasFrontmatter).toBe(false);
    expect(note.frontmatter).toEqual({});
    expect(note.frontmatterError).toBeNull();
    expect(note.body).toBe('# T\n\ntexto\n');
    expect(note.bodyStartLine).toBe(1);
  });

  it('separa dados e corpo e diz onde o corpo começa', () => {
    const note = parseNote('---\ntype: concept\ntags: [a, b]\n---\ncorpo\n');
    expect(note.hasFrontmatter).toBe(true);
    expect(note.frontmatter).toEqual({ type: 'concept', tags: ['a', 'b'] });
    expect(note.body).toBe('corpo\n');
    expect(note.bodyStartLine).toBe(5);
  });

  it('frontmatter vazio ou só com comentário não é erro', () => {
    for (const src of ['---\n---\ncorpo', '---\n\n---\ncorpo', '---\n# nada\n---\ncorpo']) {
      const note = parseNote(src);
      expect(note.hasFrontmatter).toBe(true);
      expect(note.frontmatter).toEqual({});
      expect(note.frontmatterError).toBeNull();
      expect(note.body).toBe('corpo');
    }
  });

  it('YAML malformado não lança: devolve erro estruturado e o corpo', () => {
    const src = '---\ntitle: "sem fechar\nlista: [a, b\n  x: : y\n---\n# Título\n\nTexto [[X]].';
    expect(() => parseNote(src)).not.toThrow();
    const note = parseNote(src);
    expect(note.hasFrontmatter).toBe(true);
    expect(note.frontmatter).toEqual({});
    expect(note.frontmatterError).toMatchObject({ code: 'invalid_yaml' });
    expect(note.frontmatterError?.message).not.toBe('');
    expect(note.frontmatterError?.message).not.toContain('\n');
    expect(note.frontmatterError?.line).toBeGreaterThanOrEqual(2);
    expect(note.body).toBe('# Título\n\nTexto [[X]].');
    expect(note.title).toBe('Título');
    expect(note.links.map((l) => l.target)).toEqual(['X']);
    expect(note.chunks).toHaveLength(1);
  });

  it('informa a linha do arquivo em que o YAML quebrou', () => {
    const note = parseNote('---\nid: 1\ntags: [a, b\ntype: x\n---\ncorpo');
    expect(note.frontmatterError?.code).toBe('invalid_yaml');
    expect(note.frontmatterError?.line).toBeGreaterThanOrEqual(3);
    expect(note.frontmatterError?.line).toBeLessThanOrEqual(5);
  });

  it('chave repetida é erro de YAML', () => {
    const note = parseNote('---\ntype: a\ntype: b\n---\ncorpo');
    expect(note.frontmatterError?.code).toBe('invalid_yaml');
    expect(note.body).toBe('corpo');
  });

  it('raiz que não é mapa vira erro not_a_mapping', () => {
    for (const src of ['---\n- a\n- b\n---\ncorpo', '---\nsó um texto\n---\ncorpo']) {
      const note = parseNote(src);
      expect(note.frontmatterError?.code).toBe('not_a_mapping');
      expect(note.frontmatter).toEqual({});
      expect(note.body).toBe('corpo');
    }
  });

  it('referência YAML sem âncora não lança', () => {
    const note = parseNote('---\na: *nada\n---\ncorpo');
    expect(note.frontmatterError?.code).toBe('invalid_yaml');
    expect(note.body).toBe('corpo');
  });

  it('trata BOM e CRLF', () => {
    const note = parseNote('﻿---\r\ntitle: Olá\r\nuses: ["[[SQS]]"]\r\n---\r\n# T\r\n\r\n[[X]]\r\n');
    expect(note.frontmatter).toEqual({ title: 'Olá', uses: ['[[SQS]]'] });
    expect(note.frontmatterError).toBeNull();
    expect(note.bodyStartLine).toBe(5);
    expect(note.body).toBe('# T\r\n\r\n[[X]]\r\n');
    expect(note.frontmatterLinks).toEqual([{ property: 'uses', target: 'SQS', anchor: null, alias: null, line: 3 }]);
    expect(note.links[0]).toMatchObject({ target: 'X', line: 7, column: 1 });
  });

  it('BOM sem frontmatter sai do corpo', () => {
    expect(parseNote('﻿# T\n').body).toBe('# T\n');
    expect(parseNote('﻿# T\n').headings[0]?.text).toBe('T');
  });

  it('--- de abertura sem fechamento não é frontmatter', () => {
    const note = parseNote('---\ntitle: x\n\ntexto [[A]]\n');
    expect(note.hasFrontmatter).toBe(false);
    expect(note.frontmatterError).toBeNull();
    expect(note.body).toBe('---\ntitle: x\n\ntexto [[A]]\n');
    expect(note.links.map((l) => l.target)).toEqual(['A']);
  });

  it('--- só vale como abertura na primeira linha', () => {
    const note = parseNote('\n---\ntitle: x\n---\ncorpo');
    expect(note.hasFrontmatter).toBe(false);
    expect(note.frontmatter).toEqual({});
  });

  it('aceita frontmatter que ocupa o arquivo inteiro, com ou sem quebra final', () => {
    for (const src of ['---\ntype: fact\n---', '---\ntype: fact\n---\n', '---\r\ntype: fact\r\n---\r\n']) {
      const note = parseNote(src);
      expect(note.frontmatter).toEqual({ type: 'fact' });
      expect(note.body).toBe('');
      expect(note.chunks).toEqual([]);
      expect(note.sections).toEqual([]);
    }
  });

  it('datas e valores vazios ficam como o YAML manda (texto e null)', () => {
    const note = parseNote('---\ncreated: 2026-05-03\nvalid_until:\nsupersedes: []\n---\n');
    expect(note.frontmatter).toEqual({ created: '2026-05-03', valid_until: null, supersedes: [] });
  });

  it('splitFrontmatter devolve o YAML cru', () => {
    const split = splitFrontmatter('---\na: 1\nb: 2\n---\ncorpo');
    expect(split.raw).toBe('a: 1\nb: 2');
    expect(split.data).toEqual({ a: 1, b: 2 });
    expect(splitFrontmatter('corpo').raw).toBeNull();
  });
});

describe('wikilinks no frontmatter', () => {
  const decision = [
    '---',
    'type: decision',
    'title: Usar SQS para filas',
    'tags: [infra, filas]',
    'sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]',
    'supersedes: ["[[usar-rabbitmq-para-filas]]"]',
    'superseded_by: []',
    'uses: ["[[SQS]]"]',
    'decided_by:',
    '  - "[[Ana Prado|Ana]]"',
    '  - "[[Bruno Tavares]]"',
    'part_of: ["[[Projeto Atlas#Filas]]"]',
    '---',
    'Corpo com [[Idempotência]].',
  ].join('\n');

  it('relações tipadas: uma propriedade por relação, com lista de wikilinks', () => {
    const note = parseNote(decision);
    expect(note.frontmatterLinks).toEqual([
      { property: 'sources', target: 'raw/meetings/2026-05-03-arquitetura', anchor: null, alias: null, line: 5 },
      { property: 'supersedes', target: 'usar-rabbitmq-para-filas', anchor: null, alias: null, line: 6 },
      { property: 'uses', target: 'SQS', anchor: null, alias: null, line: 8 },
      { property: 'decided_by', target: 'Ana Prado', anchor: null, alias: 'Ana', line: 10 },
      { property: 'decided_by', target: 'Bruno Tavares', anchor: null, alias: null, line: 11 },
      { property: 'part_of', target: 'Projeto Atlas', anchor: 'Filas', alias: null, line: 12 },
    ]);
    // os links do corpo ficam separados dos do frontmatter
    expect(note.links.map((l) => l.target)).toEqual(['Idempotência']);
  });

  it('fatos: subject e object', () => {
    const note = parseNote(
      '---\ntype: fact\nsubject: "[[Projeto Atlas]]"\npredicate: uses_queue\nobject: "[[SQS]]"\n---\nO Atlas usa SQS.\n',
    );
    expect(note.frontmatterLinks).toEqual([
      { property: 'subject', target: 'Projeto Atlas', anchor: null, alias: null, line: 3 },
      { property: 'object', target: 'SQS', anchor: null, alias: null, line: 5 },
    ]);
    expect(note.frontmatter.predicate).toBe('uses_queue');
  });

  it('acha mais de um link no mesmo valor e ignora valores que não são texto', () => {
    const note = parseNote('---\nrelated_to: "[[A]] e [[B|b]]"\nn: 3\nok: true\nvazio:\n---\n');
    expect(note.frontmatterLinks.map((l) => [l.property, l.target, l.alias])).toEqual([
      ['related_to', 'A', null],
      ['related_to', 'B', 'b'],
    ]);
  });

  it('frontmatter inválido não gera links', () => {
    expect(parseNote('---\nuses: ["[[SQS]]"\n---\ncorpo').frontmatterLinks).toEqual([]);
  });

  it('limite conhecido: [[x]] sem aspas é lista aninhada no YAML, não link', () => {
    const note = parseNote('---\nuses: [[SQS]]\n---\n');
    expect(note.frontmatter).toEqual({ uses: [['SQS']] });
    expect(note.frontmatterLinks).toEqual([]);
  });
});

describe('título da nota', () => {
  it('vem do frontmatter, depois do primeiro título de nível 1, depois do fallback', () => {
    expect(parseNote('---\ntitle: Do frontmatter\n---\n# Do corpo\n').title).toBe('Do frontmatter');
    expect(parseNote('## Sub\n\n# Do corpo\n').title).toBe('Do corpo');
    expect(parseNote('texto', { fallbackTitle: 'Do arquivo' }).title).toBe('Do arquivo');
    expect(parseNote('texto').title).toBeNull();
    expect(parseNote('---\ntitle: 2026\n---\n').title).toBe('2026');
    expect(parseNote('---\ntitle: "  "\n---\n# H\n').title).toBe('H');
  });
});
