import { describe, expect, it } from 'vitest';
import { parseNote } from '../../src/markdown/index.ts';
import type { NoteIssue } from '../../src/vault/index.ts';
import {
  ARCHIVE_DIR,
  defaultTrustForOrigin,
  displayTitle,
  FIXED_RELATIONS,
  fieldOrder,
  fieldsForType,
  hasErrors,
  isArchivedPath,
  isIsoDate,
  isWikilinkText,
  linkListFields,
  NOTE_TYPE_DIRS,
  NOTE_TYPES,
  noteDirForType,
  plainLinkText,
  readNote,
  relationTypes,
  validateNote,
} from '../../src/vault/index.ts';
import { FIXTURE_VAULT, fixtureNotePaths } from './helpers.ts';

const codes = (issues: readonly NoteIssue[]): string[] => issues.map((issue) => `${issue.severity}:${issue.code}`);

const validDecision = {
  id: '01KNWQPCCGW9YN4PHGN519T4H6',
  type: 'decision',
  title: 'Usar SQS para filas',
  scope: 'project:atlas',
  trust: 'high',
  origin: 'human',
  created: '2026-05-03',
  updated: '2026-05-03',
};

describe('tipos e pastas', () => {
  it('tem os 12 tipos com a pasta padrão de cada um', () => {
    expect(NOTE_TYPES).toHaveLength(12);
    expect(Object.keys(NOTE_TYPE_DIRS).sort()).toEqual([...NOTE_TYPES].sort());
    expect(noteDirForType('decision')).toBe('wiki/decisions');
    expect(noteDirForType('source')).toBe('wiki/sources');
    expect(noteDirForType('rule')).toBe('memory/rules');
    expect(noteDirForType('fact')).toBe('memory/facts');
    expect(noteDirForType('handoff')).toBe('memory/handoffs');
    expect(noteDirForType('episode', '2026-11-10')).toBe('memory/episodes/2026/11');
    expect(() => noteDirForType('episode')).toThrow(RangeError);
  });

  it('reconhece o arquivo de memórias esquecidas', () => {
    expect(ARCHIVE_DIR).toBe('memory/_archive');
    expect(isArchivedPath('memory/_archive/x.md')).toBe(true);
    expect(isArchivedPath('memory\\_archive\\x.md')).toBe(true);
    expect(isArchivedPath('memory/_archived/x.md')).toBe(false);
  });

  it('pasta de cada nota do cérebro de exemplo bate com o tipo', async () => {
    for (const path of await fixtureNotePaths()) {
      if (path.startsWith('raw/') || isArchivedPath(path)) continue;
      const { note } = await readNote(FIXTURE_VAULT, path);
      const type = note.frontmatter.type as (typeof NOTE_TYPES)[number];
      const dir = noteDirForType(type, String(note.frontmatter.created));
      expect(path.startsWith(`${dir}/`), `${path} deveria ficar em ${dir}`).toBe(true);
    }
  });
});

describe('relações', () => {
  it('são as fixas mais as do .cabecao.json, sem repetir', () => {
    expect(relationTypes()).toEqual([...FIXED_RELATIONS]);
    expect(relationTypes({ relations: ['mentored_by', 'uses', 'supersedes'] })).toEqual([
      ...FIXED_RELATIONS,
      'mentored_by',
    ]);
    expect(linkListFields({ relations: ['mentored_by'] })).toEqual([
      'supersedes',
      'superseded_by',
      ...FIXED_RELATIONS,
      'mentored_by',
    ]);
    expect(fieldOrder({ relations: ['mentored_by'] }).slice(-2)).toEqual(['related_to', 'mentored_by']);
  });
});

describe('campos por tipo', () => {
  it('fatos exigem subject, predicate e object, e não title', () => {
    expect(fieldsForType('fact').required).toEqual(['id', 'type', 'subject', 'predicate', 'object']);
    expect(fieldsForType('fact').required).not.toContain('title');
    for (const type of NOTE_TYPES.filter((t) => t !== 'fact')) {
      expect(fieldsForType(type).required).toEqual(['id', 'type', 'title']);
    }
  });

  it('confiança padrão pela origem', () => {
    expect(defaultTrustForOrigin('human')).toBe('high');
    expect(defaultTrustForOrigin('agent:claude-code')).toBe('medium');
    expect(defaultTrustForOrigin('ingest:web')).toBe('low');
  });
});

describe('validateNote', () => {
  it('nenhuma nota do cérebro de exemplo tem erro nem aviso; fontes brutas são aceitas como estão', async () => {
    const paths = await fixtureNotePaths();
    expect(paths.length).toBeGreaterThanOrEqual(25);
    for (const path of paths) {
      const { note } = await readNote(FIXTURE_VAULT, path);
      expect(validateNote({ ...note, path }), path).toEqual([]);
    }
  });

  it('a fonte bruta sem frontmatter e a com frontmatter de fora (sem id) passam só por estarem em raw/', async () => {
    for (const path of ['raw/meetings/2026-05-03-arquitetura.md', 'raw/articles/filas-gerenciadas-vs-autogeridas.md']) {
      const { note } = await readNote(FIXTURE_VAULT, path);
      expect(validateNote({ ...note, path })).toEqual([]);
      // fora de raw/, a mesma nota é "não gerenciada"
      expect(codes(validateNote({ ...note, path: `wiki/${path}` }))).toEqual(['warning:unmanaged']);
    }
  });

  it('devolve todos os problemas de uma vez, sem lançar', () => {
    const issues = validateNote({
      frontmatter: {
        id: 'nao-e-ulid',
        type: 'decision',
        title: '   ',
        scope: 'projeto atlas',
        trust: 'altíssima',
        origin: 'robô',
        created: '2026-02-30',
        valid_from: '2026-05-03',
        valid_until: '2026-05-01',
        tags: 'infra',
        sources: ['[[ok]]', 'texto'],
        uses: '[[SQS]]',
        part_of: ['Projeto Atlas'],
        relations: [{ type: 'uses', target: 'SQS' }],
      },
    });
    expect(codes(issues)).toEqual([
      'error:invalid_id',
      'warning:missing_recommended',
      'error:invalid_title',
      'error:invalid_scope',
      'error:invalid_trust',
      'error:invalid_origin',
      'error:invalid_date',
      'error:invalid_date_range',
      'warning:invalid_list',
      'warning:invalid_wikilink',
      'error:invalid_list',
      'error:invalid_wikilink',
      'warning:legacy_relations',
    ]);
    expect(issues.find((issue) => issue.code === 'missing_recommended')?.field).toBe('updated');
    expect(issues.find((issue) => issue.code === 'invalid_date')?.field).toBe('created');
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true);
    expect(hasErrors(issues)).toBe(true);
  });

  it('nota sem título é erro, menos fato', () => {
    const { title: _, ...withoutTitle } = validDecision;
    expect(codes(validateNote({ frontmatter: withoutTitle }))).toEqual(['error:missing_required']);
    const fact = {
      id: '01KTZQJHX82Q9ZW0ZF69APQRF1',
      type: 'fact',
      subject: '[[Projeto Atlas]]',
      predicate: 'uses_queue',
      object: '[[SQS]]',
      valid_from: '2026-05-03',
      valid_until: null,
      trust: 'high',
      origin: 'human',
      created: '2026-05-03',
      updated: '2026-05-03',
    };
    expect(validateNote({ frontmatter: fact })).toEqual([]);
  });

  it('fato sem subject, predicate ou object, ou com predicado mal formado, é erro', () => {
    const issues = validateNote({
      frontmatter: { id: '01KTZQJHX82Q9ZW0ZF69APQRF1', type: 'fact', predicate: 'Usa Fila', object: { a: 1 } },
    });
    const errors = issues.filter((issue) => issue.severity === 'error');
    expect(errors.map((issue) => `${issue.code}:${issue.field}`)).toEqual([
      'missing_required:subject',
      'invalid_fact:predicate',
      'invalid_fact:object',
    ]);
    // subject que não é wikilink é só aviso: um valor simples ainda é um fato
    const plain = validateNote({
      frontmatter: { id: '01KTZQJHX82Q9ZW0ZF69APQRF1', type: 'fact', subject: 'Atlas', predicate: 'p', object: 1 },
    });
    expect(plain.filter((issue) => issue.code === 'invalid_fact').map((issue) => issue.severity)).toEqual(['warning']);
  });

  it('regra com origem que não é humana é erro', () => {
    const issues = validateNote({ frontmatter: { ...validDecision, type: 'rule', origin: 'agent:codex' } });
    expect(codes(issues)).toEqual(['error:rule_origin_not_human']);
  });

  it('tipo desconhecido e nota sem id', () => {
    expect(codes(validateNote({ frontmatter: { ...validDecision, type: 'ideia' } }))).toEqual(['error:unknown_type']);
    const { id: _, ...withoutId } = validDecision;
    expect(codes(validateNote({ frontmatter: withoutId }))).toEqual(['error:missing_required']);
  });

  it('frontmatter ilegível é um erro só, com a linha', () => {
    const note = parseNote('---\ntitle: [aberto\n---\ncorpo\n');
    const issues = validateNote({ ...note, path: 'wiki/x.md' });
    expect(codes(issues)).toEqual(['error:invalid_frontmatter']);
    expect(issues[0]?.message).toMatch(/linha/);
    // em raw/, nem isso
    expect(validateNote({ ...note, path: 'raw/x.md' })).toEqual([]);
  });

  it('relações extras do .cabecao.json também são conferidas', () => {
    const frontmatter = { ...validDecision, mentored_by: 'Ana' };
    expect(validateNote({ frontmatter })).toEqual([]);
    expect(codes(validateNote({ frontmatter }, { relations: ['mentored_by'] }))).toEqual(['error:invalid_list']);
  });

  it('campos desconhecidos (propriedades do usuário no Obsidian) são ignorados', () => {
    expect(validateNote({ frontmatter: { ...validDecision, aliases: ['SQS'], cor: 'azul' } })).toEqual([]);
  });

  it('datas: AAAA-MM-DD, com hora opcional, e o dia tem de existir', () => {
    for (const ok of ['2026-05-03', '2024-02-29', '2026-05-03T14:32', '2026-05-03T14:32:10.482Z', '2026-05-03 14:32']) {
      expect(isIsoDate(ok), ok).toBe(true);
    }
    for (const bad of ['2026-5-3', '2025-02-29', '2026-13-01', '03/05/2026', '2026-05-03T25:00', 20260503, null]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });
});

describe('wikilinks no frontmatter e títulos', () => {
  it('reconhece um valor que é um wikilink inteiro', () => {
    for (const ok of ['[[SQS]]', '[[raw/meetings/x]]', '[[Nota#Seção]]', '[[Nota|apelido]]', ' [[SQS]] ']) {
      expect(isWikilinkText(ok), ok).toBe(true);
    }
    for (const bad of ['SQS', '[[a]] e [[b]]', '[[]]', '[[a', 42]) expect(isWikilinkText(bad), String(bad)).toBe(false);
  });

  it('texto legível de um link e título para mostrar', () => {
    expect(plainLinkText('[[wiki/entities/Ana Prado]]')).toBe('Ana Prado');
    expect(plainLinkText('[[SQS|fila gerenciada]]')).toBe('fila gerenciada');
    expect(plainLinkText('texto')).toBe('texto');
    expect(displayTitle({ title: ' Título ' })).toBe('Título');
    expect(
      displayTitle({ type: 'fact', subject: '[[Projeto Atlas]]', predicate: 'uses_queue', object: '[[SQS]]' }),
    ).toBe('Projeto Atlas uses_queue SQS');
    expect(displayTitle({}, 'raw/meetings/2026-05-03-arquitetura.md')).toBe('2026-05-03-arquitetura');
  });
});
