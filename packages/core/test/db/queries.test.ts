import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backlinks,
  getIndexState,
  getNote,
  latestHandoff,
  listNotes,
  outgoingLinks,
  scan,
  setIndexState,
} from '../../src/db/index.ts';
import type { OpenVault } from './helpers.ts';
import { openFixture } from './helpers.ts';

let vault: OpenVault;
beforeAll(async () => {
  vault = await openFixture('queries');
  await scan(vault.index, vault.root, vault.config);
});
afterAll(async () => {
  await vault.cleanup();
});

const ATLAS_ID = '01KGSQT6VRXNFR2ZA3ZAQSYAN5';

describe('getNote', () => {
  it('por id e por caminho, com as variações aceitas', () => {
    const byId = getNote(vault.index, { id: ATLAS_ID });
    expect(byId).toMatchObject({
      path: 'wiki/entities/Projeto Atlas.md',
      type: 'entity',
      title: 'Projeto Atlas',
      scope: 'project:atlas',
      trust: 'high',
      origin: 'human',
      created: '2026-01-12',
      managed: true,
      archived: false,
      frontmatterError: null,
    });
    expect(byId?.frontmatter.uses).toEqual(['[[SQS]]']);
    expect(getNote(vault.index, { path: 'wiki/entities/Projeto Atlas.md' })?.id).toBe(ATLAS_ID);
    expect(getNote(vault.index, { path: 'wiki\\entities\\Projeto Atlas' })?.id).toBe(ATLAS_ID);
    expect(getNote(vault.index, { path: 'wiki/entities/projeto atlas.md' })?.id).toBe(ATLAS_ID);
    expect(getNote(vault.index, { path: 'wiki/concepts/Idempotência.md'.normalize('NFD') })?.title).toBe(
      'Idempotência',
    );
    expect(getNote(vault.index, { id: 'nao-existe' })).toBeNull();
    expect(getNote(vault.index, { path: 'wiki/nao-existe.md' })).toBeNull();
  });

  it('fato sem título ganha um título legível', () => {
    expect(getNote(vault.index, { id: '01KTZQJHX82Q9ZW0ZF69APQRF1' })?.title).toBe('Projeto Atlas uses_queue SQS');
  });
});

describe('links', () => {
  it('backlinks do Projeto Atlas', () => {
    const links = backlinks(vault.index, ATLAS_ID);
    const sources = new Set(links.map((l) => l.path));
    for (const path of [
      'wiki/entities/Ana Prado.md',
      'wiki/entities/Bruno Tavares.md',
      'wiki/entities/Lumen Logística.md',
      'wiki/concepts/Idempotência.md', // [[projeto atlas]], em minúsculas
      'wiki/decisions/usar-sqs-para-filas.md',
      'wiki/decisions/usar-rabbitmq-para-filas.md',
      'wiki/syntheses/Mensageria no Projeto Atlas.md',
      'memory/facts/fato-atlas-usa-sqs.md',
      'memory/handoffs/2026-11-10-atlas-consumidores.md',
      'memory/procedures/publicar-nova-versao-do-atlas.md',
    ]) {
      expect(sources.has(path), path).toBe(true);
    }
    expect(sources.has('wiki/entities/Projeto Atlas.md')).toBe(false);
    expect(links).toContainEqual(
      expect.objectContaining({ path: 'wiki/entities/Ana Prado.md', origin: 'relation', type: 'works_on' }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ path: 'memory/facts/fato-atlas-usa-sqs.md', origin: 'fact', type: 'subject' }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ path: 'wiki/concepts/Idempotência.md', origin: 'wikilink', type: 'link' }),
    );
  });

  it('links de saída, com o quebrado marcado', () => {
    const fila = getNote(vault.index, { path: 'wiki/concepts/Fila de mensagens.md' });
    const links = outgoingLinks(vault.index, fila?.id ?? '');
    expect(links.map((l) => [l.target, l.broken])).toEqual([
      ['raw/articles/filas-gerenciadas-vs-autogeridas', false],
      ['Idempotência', false],
      ['SQS', false],
      ['Idempotência', false],
      ['RabbitMQ', false],
      ['SQS', false],
      ['Kafka', true],
    ]);
    // link dentro de código não conta
    expect(links.some((l) => l.target.includes('Isto não é'))).toBe(false);
    expect(links[0]).toMatchObject({ origin: 'wikilink', type: 'sources', noteType: null });
  });
});

describe('listNotes e latestHandoff (recall)', () => {
  it('regras, preferências e armadilhas do escopo', () => {
    const notes = listNotes(vault.index, {
      types: ['rule', 'preference', 'gotcha'],
      scope: ['global', 'project:atlas'],
    });
    expect(notes.map((n) => n.path).sort()).toEqual([
      'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md',
      'memory/preferences/respostas-em-portugues.md',
      'memory/rules/nunca-commitar-segredos.md',
    ]);
    expect(listNotes(vault.index, { types: ['preference'], includeArchived: true })).toHaveLength(2);
    expect(listNotes(vault.index, { types: [] })).toEqual([]);
    const ordered = listNotes(vault.index, { types: ['decision'] });
    expect(ordered.map((n) => n.updated)).toEqual(['2026-11-10', '2026-05-03']);
    expect(listNotes(vault.index, { orderBy: 'path', limit: 2 }).map((n) => n.path)).toEqual([
      'memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md',
      'memory/facts/fato-ana-lidera-atlas.md',
    ]);
  });

  it('último handoff', () => {
    expect(latestHandoff(vault.index, { scope: 'project:atlas' })).toMatchObject({
      path: 'memory/handoffs/2026-11-10-atlas-consumidores.md',
      expiresAt: '2026-12-10',
    });
    expect(latestHandoff(vault.index, { scope: 'project:outro' })).toBeNull();
  });
});

describe('state', () => {
  it('grava, lê e apaga', () => {
    expect(getIndexState(vault.index, 'last_indexed_commit')).toBeNull();
    setIndexState(vault.index, 'last_indexed_commit', 'abc123');
    setIndexState(vault.index, 'last_indexed_commit', 'def456');
    expect(getIndexState(vault.index, 'last_indexed_commit')).toBe('def456');
    setIndexState(vault.index, 'last_indexed_commit', null);
    expect(getIndexState(vault.index, 'last_indexed_commit')).toBeNull();
  });
});
