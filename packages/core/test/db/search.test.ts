import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFtsQuery, queryTerms, scan, searchKeyword, validityOf } from '../../src/db/index.ts';
import type { OpenVault } from './helpers.ts';
import { openFixture } from './helpers.ts';

// A busca só lê o banco: um cérebro para o arquivo inteiro.
let vault: OpenVault;
beforeAll(async () => {
  vault = await openFixture('search');
  await scan(vault.index, vault.root, vault.config);
});
afterAll(async () => {
  await vault.cleanup();
});

const TODAY = new Date(2026, 10, 12); // 12/11/2026, data local
const search = (query: string, extra: Partial<Parameters<typeof searchKeyword>[1]> = {}) =>
  searchKeyword(vault.index, { query, now: TODAY, ...extra });
const paths = (query: string, extra: Partial<Parameters<typeof searchKeyword>[1]> = {}) =>
  search(query, extra).hits.map((hit) => hit.path);

describe('queryTerms e buildFtsQuery', () => {
  it('tira palavras vazias de português e inglês, com ou sem acento', () => {
    expect(queryTerms('Por que o time decidiu usar o SQS para as filas?').map((t) => t.text)).toEqual([
      'time',
      'decidiu',
      'usar',
      'sqs',
      'filas',
    ]);
    expect(queryTerms('What is the queue of the project').map((t) => t.text)).toEqual(['queue', 'project']);
    expect(queryTerms('não é nao e está esta')).toEqual([]);
  });

  it('mantém identificadores compostos e prefixo com *', () => {
    expect(queryTerms('make db-reset make_db v1.2 migr*')).toEqual([
      { text: 'make', prefix: false },
      { text: 'db-reset', prefix: false },
      { text: 'make_db', prefix: false },
      { text: 'v1.2', prefix: false },
      { text: 'migr', prefix: true },
    ]);
    expect(buildFtsQuery(queryTerms('db-reset migr*'), 'AND')).toBe('"db-reset" AND "migr"*');
  });

  it('sintaxe do FTS5 digitada pelo usuário vira texto', () => {
    for (const query of [
      '"SQS',
      'SQS"',
      '-SQS',
      'title:SQS',
      '*',
      'SQS*',
      'NEAR(a b)',
      'a AND OR NOT b',
      '(((',
      '^SQS',
      "d'água",
      'SQS + RabbitMQ',
      '{a b}: c',
    ]) {
      expect(() => search(query), query).not.toThrow();
    }
    expect(paths('title:SQS')).toEqual([]); // "title sqs" como frase: não existe
    expect(paths('-SQS').length).toBeGreaterThan(0); // `-` não é NOT
  });
});

describe('searchKeyword', () => {
  it('acha termo com e sem acento', () => {
    expect(paths('migracao')).toContain('memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md');
    expect(paths('migração')).toEqual(paths('migracao'));
    expect(paths('IDEMPOTENCIA')[0]).toBe('wiki/concepts/Idempotência.md');
  });

  it('título pesa mais que o texto', () => {
    // "Idempotência" aparece no texto de várias notas, mas só uma tem esse título
    const hits = search('idempotência').hits;
    expect(hits[0]?.path).toBe('wiki/concepts/Idempotência.md');
    expect(hits.length).toBeGreaterThan(3);
  });

  it('paráfrase sem palavra em comum não casa', () => {
    expect(search('enfileiramento terceirizado barato').hits).toEqual([]);
    expect(search('enfileiramento terceirizado barato').mode).toBe('or');
  });

  it('AND primeiro e OR como recuo', () => {
    const and = search('rabbitmq sqs');
    expect(and.mode).toBe('and');
    expect(and.hits.length).toBeGreaterThan(0);
    const or = search('rabbitmq ornitorrinco');
    expect(or.mode).toBe('or');
    expect(or.hits.map((h) => h.path)).toContain('wiki/entities/RabbitMQ.md');
  });

  it('pergunta vazia ou só de palavras vazias devolve vazio sem erro', () => {
    for (const query of ['', '   ', 'de que para o a', '?!', '"""']) {
      expect(search(query)).toEqual({ hits: [], mode: 'none', terms: [], truncated: false });
    }
  });

  it('marca a decisão do RabbitMQ como vencida e a do SQS como vigente, e rebaixa a vencida', () => {
    const hits = search('usar filas', { types: ['decision'] }).hits;
    const byPath = new Map(hits.map((h) => [h.path, h]));
    const rabbit = byPath.get('wiki/decisions/usar-rabbitmq-para-filas.md');
    const sqs = byPath.get('wiki/decisions/usar-sqs-para-filas.md');
    expect(rabbit).toMatchObject({ validity: 'expired', validUntil: '2026-05-03', validFrom: '2026-01-14' });
    expect(sqs).toMatchObject({ validity: 'current', validUntil: null, validFrom: '2026-05-03' });
    expect(hits.indexOf(sqs as never)).toBeLessThan(hits.indexOf(rabbit as never));
    // num dia anterior ao fim, a mesma decisão é vigente
    const past = search('usar filas', { types: ['decision'], now: new Date(2026, 2, 1) }).hits;
    expect(past.find((h) => h.path.includes('rabbitmq'))?.validity).toBe('current');
  });

  it('handoff com expires_at no passado sai como vencido', () => {
    const hit = search('consumidores lote', { types: ['handoff'], now: new Date(2026, 11, 11) }).hits[0];
    expect(hit).toMatchObject({ type: 'handoff', expiresAt: '2026-12-10', validity: 'expired' });
    expect(search('consumidores lote', { types: ['handoff'] }).hits[0]?.validity).toBe('current');
  });

  it('devolve um resultado por nota, com os campos pedidos', () => {
    const hits = search('fila', { limit: 50 }).hits;
    expect(new Set(hits.map((h) => h.noteId)).size).toBe(hits.length);
    const fila = hits.find((h) => h.path === 'wiki/concepts/Fila de mensagens.md');
    expect(fila).toMatchObject({
      noteId: '01KFB5J5989ZJ2Q184GYZJQGS7',
      title: 'Fila de mensagens',
      type: 'concept',
      scope: 'global',
      trust: 'medium',
      origin: 'agent:claude-code',
      validity: 'current',
      expiresAt: null,
    });
    expect(Array.isArray(fila?.headingPath)).toBe(true);
    expect(fila?.snippet).toMatch(/«[^»]+»/);
    expect(fila?.score).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]?.score).toBeGreaterThanOrEqual(hits[i]?.score ?? 0);
  });

  it('filtra por tipo e escopo', () => {
    const facts = search('projeto atlas', { types: ['fact'], limit: 50 }).hits;
    expect(facts.length).toBe(4);
    expect(facts.every((h) => h.type === 'fact')).toBe(true);
    const global = search('sqs', { scope: 'global', limit: 50 }).hits;
    expect(global.length).toBeGreaterThan(0);
    expect(global.every((h) => h.scope === 'global')).toBe(true);
    const both = search('sqs', { scope: ['global', 'project:atlas'], limit: 50 }).hits;
    expect(both.length).toBeGreaterThan(global.length);
  });

  it('notas arquivadas ficam fora por padrão', () => {
    expect(paths('tabs formatador')).toEqual([]);
    expect(paths('tabs formatador', { includeArchived: true })).toEqual(['memory/_archive/preferencia-usar-tabs.md']);
  });

  it('respeita limit e orçamento de tokens', () => {
    const all = search('atlas', { limit: 100 });
    expect(all.hits.length).toBeGreaterThan(5);
    expect(search('atlas', { limit: 3 }).hits).toEqual(all.hits.slice(0, 3));
    const tight = search('atlas', { limit: 100, budgetTokens: 150 });
    expect(tight.truncated).toBe(true);
    expect(tight.hits.length).toBeGreaterThan(0);
    expect(tight.hits.length).toBeLessThan(all.hits.length);
    expect(tight.hits).toEqual(all.hits.slice(0, tight.hits.length));
    expect(search('atlas', { budgetTokens: 1 }).hits).toEqual([]);
  });

  it('busca por prefixo', () => {
    expect(paths('idempot*')).toContain('wiki/concepts/Idempotência.md');
  });

  it('acha fonte bruta sem id', () => {
    expect(paths('plantão previsibilidade')).toEqual(['raw/articles/filas-gerenciadas-vs-autogeridas.md']);
  });
});

describe('validityOf', () => {
  it('valid_until e expires_at são exclusivos', () => {
    expect(validityOf({ validUntil: '2026-05-03', expiresAt: null }, '2026-05-02')).toBe('current');
    expect(validityOf({ validUntil: '2026-05-03', expiresAt: null }, '2026-05-03')).toBe('expired');
    expect(validityOf({ validUntil: null, expiresAt: '2026-12-10T10:00:00Z' }, '2026-12-11')).toBe('expired');
    expect(validityOf({ validUntil: null, expiresAt: null }, '2026-12-11')).toBe('current');
  });
});
