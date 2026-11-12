import { describe, expect, it } from 'vitest';
import { checkFileNameLength } from '../../src/util/index.ts';
import type { NoteType } from '../../src/vault/index.ts';
import {
  FILE_NAME_STYLES,
  fileNameKey,
  fileNameProblem,
  MAX_NOTE_BASENAME_BYTES,
  NOTE_TYPES,
  noteBaseName,
  readNote,
  sanitizeTitleFileName,
  slugify,
  uniqueFileName,
} from '../../src/vault/index.ts';
import { FIXTURE_VAULT } from './helpers.ts';

const FALLBACK = '01KQB9YDZ08HD1F6B7GRHFG5N6';

describe('regra de nome de arquivo', () => {
  it('cada tipo tem um estilo', () => {
    expect(Object.keys(FILE_NAME_STYLES).sort()).toEqual([...NOTE_TYPES].sort());
  });

  // O gotcha (`testes-de-integracao-sem-limpar-o-banco`), os fatos (`fato-...`) e o episódio foram nomeados à mão
  // com um resumo do título; os demais seguem a regra.
  it('reproduz os nomes do cérebro de exemplo a partir do título', async () => {
    const cases = [
      'wiki/entities/Projeto Atlas.md',
      'wiki/entities/Lumen Logística.md',
      'wiki/concepts/Idempotência.md',
      'wiki/concepts/Fila de mensagens.md',
      'wiki/sources/Reunião de arquitetura 2026-05-03.md',
      'wiki/syntheses/Mensageria no Projeto Atlas.md',
      'wiki/decisions/usar-sqs-para-filas.md',
      'wiki/decisions/usar-rabbitmq-para-filas.md',
      'memory/rules/nunca-commitar-segredos.md',
      'memory/preferences/respostas-em-portugues.md',
      'memory/procedures/publicar-nova-versao-do-atlas.md',
    ];
    for (const path of cases) {
      const { note } = await readNote(FIXTURE_VAULT, path);
      const base = noteBaseName({
        type: note.frontmatter.type as NoteType,
        title: String(note.frontmatter.title),
        date: String(note.frontmatter.created),
        fallback: FALLBACK,
      });
      expect(`${base}.md`, path).toBe(path.slice(path.lastIndexOf('/') + 1).normalize('NFC'));
    }
  });

  it('episódio e handoff ganham a data do created, sem repeti-la', () => {
    expect(
      noteBaseName({ type: 'episode', title: 'Migração dos consumidores', date: '2026-11-10', fallback: FALLBACK }),
    ).toBe('2026-11-10-migracao-dos-consumidores');
    expect(
      noteBaseName({
        type: 'handoff',
        title: '2026-11-10 Atlas, consumidores',
        date: '2026-11-10',
        fallback: FALLBACK,
      }),
    ).toBe('2026-11-10-atlas-consumidores');
  });

  it('fato sem título usa sujeito, predicado e objeto', () => {
    expect(noteBaseName({ type: 'fact', title: 'Projeto Atlas uses_queue SQS', fallback: FALLBACK })).toBe(
      'projeto-atlas-uses-queue-sqs',
    );
  });

  it('título legível: troca o que o Windows ou o wikilink não aceitam, apara pontas', () => {
    expect(sanitizeTitleFileName('Usar SQS: por quê?')).toBe('Usar SQS por quê');
    expect(sanitizeTitleFileName('  ..a/b\\c|d*e<f>g"h#i^j[k]l\tm\nn.  ')).toBe('a b c d e f g h i j k l m n');
    expect(sanitizeTitleFileName('Versão 2.0.')).toBe('Versão 2.0');
    expect(sanitizeTitleFileName('Reunião'.normalize('NFD'))).toBe('Reunião'.normalize('NFC'));
    expect(sanitizeTitleFileName('???')).toBe('');
  });

  it('slug: sem acento latino, minúsculo, com hífens; outros alfabetos ficam', () => {
    expect(slugify('Testes de integração falham — sem limpar o banco!')).toBe(
      'testes-de-integracao-falham-sem-limpar-o-banco',
    );
    expect(slugify('ÇÃO Ñandú Øre')).toBe('cao-nandu-øre');
    expect(slugify('東京の会議')).toBe('東京の会議');
    expect(slugify('🚀🚀')).toBe('');
  });

  it('nomes reservados do Windows ganham _', () => {
    expect(sanitizeTitleFileName('CON')).toBe('_CON');
    expect(sanitizeTitleFileName('aux.final')).toBe('_aux.final');
    expect(slugify('Com1')).toBe('_com1');
    expect(sanitizeTitleFileName('Console')).toBe('Console');
  });

  it('título sem nada aproveitável cai no id', () => {
    expect(noteBaseName({ type: 'concept', title: '???', fallback: FALLBACK })).toBe(FALLBACK.toLowerCase());
    expect(noteBaseName({ type: 'gotcha', title: '🚀', fallback: FALLBACK })).toBe(FALLBACK.toLowerCase());
  });

  it('qualquer título vira um nome portável de até 255 bytes', () => {
    const titles = [
      'á'.repeat(300),
      '東'.repeat(300),
      '🚀a'.repeat(200),
      `${'x'.repeat(159)}é`,
      'Nota. . .',
      ' . ',
      'nul',
      'a\u0000b\u001fc\u007fd',
      'ﬁ ligadura',
    ];
    for (const title of titles) {
      for (const type of NOTE_TYPES) {
        const base = noteBaseName({ type, title, date: '2026-11-12', fallback: FALLBACK });
        const name = uniqueFileName(base, (key) => key === fileNameKey(base));
        expect(fileNameProblem(name), `${type}: ${JSON.stringify(title)} → ${name}`).toBeNull();
        expect(Buffer.byteLength(base)).toBeLessThanOrEqual(MAX_NOTE_BASENAME_BYTES);
        expect(checkFileNameLength(name).ok).toBe(true);
      }
    }
  });
});

describe('uniqueFileName', () => {
  it('desempata sem diferenciar maiúsculas nem forma Unicode', () => {
    const taken = new Set(['sqs', 'sqs 2', 'reunião'].map(fileNameKey));
    const isTaken = (key: string): boolean => taken.has(key);
    expect(uniqueFileName('SQS', isTaken, ' ')).toBe('SQS 3.md');
    expect(uniqueFileName('Reunião'.normalize('NFD'), isTaken, ' ')).toBe(`${'Reunião'.normalize('NFD')} 2.md`);
    expect(uniqueFileName('usar-sqs', () => false)).toBe('usar-sqs.md');
    expect(uniqueFileName('usar-sqs', (key) => key === 'usar-sqs')).toBe('usar-sqs-2.md');
  });
});

describe('fileNameProblem', () => {
  it('aceita nomes portáveis e explica os que não são', () => {
    expect(fileNameProblem('Projeto Atlas.md')).toBeNull();
    expect(fileNameProblem('usar-sqs-para-filas.md')).toBeNull();
    expect(fileNameProblem('.md')).toMatch(/vazio/);
    expect(fileNameProblem('a:b.md')).toMatch(/Windows/);
    expect(fileNameProblem('a#b.md')).toMatch(/wikilinks/);
    expect(fileNameProblem(' a.md')).toMatch(/espaço ou ponto/);
    expect(fileNameProblem('CON.md')).toMatch(/reservado/);
    expect(fileNameProblem('Reunião.md'.normalize('NFD'))).toMatch(/NFC/);
    expect(fileNameProblem(`${'é'.repeat(130)}.md`)).toMatch(/bytes/);
  });
});
