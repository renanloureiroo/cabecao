import { describe, expect, it } from 'vitest';
import { parseNote, splitFrontmatter } from '../../src/markdown/index.ts';
import { editFrontmatterText, readNote, serializeFrontmatter, serializeNote } from '../../src/vault/index.ts';
import { FIXTURE_VAULT, fixtureNotePaths, toCrlf } from './helpers.ts';

describe('serializeNote: ida e volta', () => {
  it('parsear e serializar cada nota do cérebro de exemplo não muda o significado', async () => {
    const paths = await fixtureNotePaths();
    expect(paths.length).toBeGreaterThanOrEqual(25);
    for (const path of paths) {
      const { note } = await readNote(FIXTURE_VAULT, path);
      const text = serializeNote(note.frontmatter, note.body);
      const again = parseNote(text);
      expect(again.frontmatterError, path).toBeNull();
      expect(again.frontmatter, path).toEqual(note.frontmatter);
      // o corpo volta como veio (inclusive com CRLF, num checkout do Windows); só ganha a quebra final se faltar
      expect(again.body, path).toBe(note.body === '' || note.body.endsWith('\n') ? note.body : `${note.body}\n`);
      expect(
        again.links.map((link) => link.target),
        path,
      ).toEqual(note.links.map((link) => link.target));
      // a ordem dos campos passa a ser a canônica, então os links do frontmatter são comparados como conjunto
      const linkKeys = (links: typeof note.frontmatterLinks): string[] =>
        links.map((link) => `${link.property}\0${link.target}`).sort();
      expect(linkKeys(again.frontmatterLinks), path).toEqual(linkKeys(note.frontmatterLinks));
      expect(text.endsWith('\n'), path).toBe(true);
      // estável: serializar de novo dá os mesmos bytes
      expect(serializeNote(again.frontmatter, again.body), path).toBe(text);
    }
  });

  it('a fonte bruta sem frontmatter continua sem frontmatter', async () => {
    const { note } = await readNote(FIXTURE_VAULT, 'raw/meetings/2026-05-03-arquitetura.md');
    const text = serializeNote(note.frontmatter, note.body);
    expect(text.startsWith('# Reunião')).toBe(true);
    expect(parseNote(text).hasFrontmatter).toBe(false);
  });

  it('um corpo que começa com --- e sem frontmatter não vira frontmatter', () => {
    const text = serializeNote({}, '---\ntitle: x\n---\ntexto\n');
    const note = parseNote(text);
    expect(note.hasFrontmatter).toBe(false);
    expect(note.frontmatter).toEqual({});
  });
});

describe('serializeFrontmatter: formato', () => {
  it('segue a ordem canônica, e os campos desconhecidos vêm depois, na ordem recebida', async () => {
    const { note } = await readNote(FIXTURE_VAULT, 'wiki/decisions/usar-sqs-para-filas.md');
    const keys = serializeFrontmatter({ cor: 'azul', ...note.frontmatter, aliases: ['SQS'] }, { relations: [] })
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(0, line.indexOf(':')));
    expect(keys).toEqual([
      'id',
      'type',
      'title',
      'scope',
      'tags',
      'sources',
      'trust',
      'origin',
      'created',
      'updated',
      'confirmed',
      'valid_from',
      'valid_until',
      'supersedes',
      'superseded_by',
      'expires_at',
      'uses',
      'part_of',
      'depends_on',
      'decided_by',
      'cor',
      'aliases',
    ]);
  });

  it('fatos: subject, predicate e object logo depois do tipo; relações extras na ordem do .cabecao.json', () => {
    const yaml = serializeFrontmatter(
      { mentored_by: ['[[Ana]]'], object: '[[SQS]]', predicate: 'uses_queue', subject: '[[Atlas]]', type: 'fact' },
      { relations: ['mentored_by'] },
    );
    expect(yaml).toBe(
      'type: fact\nsubject: "[[Atlas]]"\npredicate: uses_queue\nobject: "[[SQS]]"\nmentored_by: ["[[Ana]]"]\n',
    );
  });

  it('wikilinks entre aspas, datas sem aspas, vazios como no doc 03, termina em LF', () => {
    const yaml = serializeFrontmatter({
      title: 'Usar SQS: por quê?',
      tags: ['infra', 'filas'],
      sources: ['[[raw/meetings/2026-05-03-arquitetura]]'],
      created: '2026-05-03',
      updated: '2026-11-12T14:32:10.482Z',
      valid_until: null,
      superseded_by: [],
      expires_at: undefined,
      uses: ['[[SQS]]', '[[Nota|apelido]]'],
    });
    expect(yaml).toBe(
      [
        'title: "Usar SQS: por quê?"',
        'tags: [infra, filas]',
        'sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]',
        'created: 2026-05-03',
        'updated: 2026-11-12T14:32:10.482Z',
        'valid_until:',
        'superseded_by: []',
        'uses: ["[[SQS]]", "[[Nota|apelido]]"]',
        '',
      ].join('\n'),
    );
    expect(serializeFrontmatter({})).toBe('');
    expect(serializeNote({}, '')).toBe('');
    expect(serializeNote({ type: 'concept' }, 'corpo')).toBe('---\ntype: concept\n---\ncorpo\n');
  });

  it('textos que o YAML leria como outra coisa ficam entre aspas e voltam iguais', () => {
    const data = {
      title: '2026',
      tags: ['#tag', 'true', 'null', '- item', '[x]', 'a, b', ''],
      sources: [],
      cor: 'linha 1\nlinha 2',
      nested: { a: [1, 2], b: { c: '[[X]]' } },
      flag: true,
      n: 3.5,
    };
    const parsed = splitFrontmatter(`---\n${serializeFrontmatter(data)}---\n`);
    expect(parsed.error).toBeNull();
    expect(parsed.data).toEqual(data);
  });

  it('não depende do idioma nem do sistema: sem CRLF, sem quebra de linha automática', () => {
    const long = 'palavra '.repeat(40).trim();
    const yaml = serializeFrontmatter({ title: long, tags: Array.from({ length: 30 }, (_, i) => `t${i}`) });
    expect(yaml).not.toContain('\r');
    expect(yaml.split('\n')).toHaveLength(3);
  });
});

describe('editFrontmatterText: mexe só nas linhas alteradas', () => {
  const raw = [
    '# comentário do usuário',
    'id: 01KNWQPCCGW9YN4PHGN519T4H6',
    'type: decision',
    "title: 'Usar SQS para filas'   # aspas simples dele",
    'tags: [infra,filas]',
    'updated: 2026-11-10',
    'valid_until:',
    '',
    'cor: azul',
    'uses: ["[[SQS]]"]',
  ].join('\n');

  it('troca um campo e deixa o resto byte a byte', () => {
    const out = editFrontmatterText(raw, { set: { updated: '2026-11-12' } });
    expect(out).toBe(raw.replace('updated: 2026-11-10', 'updated: 2026-11-12'));
  });

  it('campo novo entra na posição canônica; desconhecido novo vai para o fim', () => {
    const out = editFrontmatterText(raw, { set: { scope: 'global', confirmed: '2026-11-12', extra: 1 } }) ?? '';
    const lines = out.split('\n');
    expect(lines.indexOf('scope: global')).toBe(
      lines.indexOf("title: 'Usar SQS para filas'   # aspas simples dele") + 1,
    );
    expect(lines.indexOf('confirmed: 2026-11-12')).toBe(lines.indexOf('updated: 2026-11-10') + 1);
    expect(lines.at(-1)).toBe('extra: 1');
    expect(lines[0]).toBe('# comentário do usuário');
  });

  it('remove campos e mantém linhas em branco e comentários soltos', () => {
    const out = editFrontmatterText(raw, { set: {}, remove: ['valid_until', 'cor'] }) ?? '';
    expect(out).not.toContain('valid_until');
    expect(out).not.toContain('cor:');
    expect(out).toContain('# comentário do usuário');
    expect(splitFrontmatter(`---\n${out}\n---\n`).data).toEqual({
      id: '01KNWQPCCGW9YN4PHGN519T4H6',
      type: 'decision',
      title: 'Usar SQS para filas',
      tags: ['infra', 'filas'],
      updated: '2026-11-10',
      uses: ['[[SQS]]'],
    });
  });

  it('mantém o CRLF do arquivo', () => {
    const out = editFrontmatterText(toCrlf(raw), { set: { updated: '2026-11-12' } }) ?? '';
    expect(out).toBe(toCrlf(raw).replace('updated: 2026-11-10', 'updated: 2026-11-12'));
  });

  it('desiste (null) quando não dá para editar com segurança', () => {
    expect(editFrontmatterText('{a: 1, b: 2}', { set: { a: 2 } })).toBeNull();
    expect(editFrontmatterText('a: 1\na: 2', { set: { a: 3 } })).toBeNull();
    expect(editFrontmatterText('- a\n- b', { set: { a: 3 } })).toBeNull();
    expect(editFrontmatterText('a: [1', { set: { a: 3 } })).toBeNull();
  });

  it('frontmatter vazio ganha os campos na ordem canônica', () => {
    expect(editFrontmatterText('', { set: { title: 'T', id: '01KNWQPCCGW9YN4PHGN519T4H6' } })).toBe(
      'id: 01KNWQPCCGW9YN4PHGN519T4H6\ntitle: T',
    );
  });
});
