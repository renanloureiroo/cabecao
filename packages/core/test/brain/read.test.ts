import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError, DATA_NOTICE, RECALL_PRIORITY } from '../../src/brain/index.ts';
import { indexStatus, openIndex } from '../../src/db/index.ts';
import { isUlid } from '../../src/util/index.ts';
import {
  cleanupAll,
  createBrainRepo,
  disposeSandbox,
  head,
  openTest,
  porcelain,
  snapshot,
  TEST_TIMEOUT_MS,
} from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

async function errorOf(promise: Promise<unknown>): Promise<BrainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('a operação deveria ter falhado');
}

describe('openBrain', { timeout: TEST_TIMEOUT_MS }, () => {
  it('abrir não tem efeito colateral: nenhum arquivo do cérebro muda, nenhum commit, e o banco ainda não foi varrido', async () => {
    const dir = await createBrainRepo();
    const before = await snapshot(dir);
    const sha = await head(dir);
    const brain = await openTest(dir);
    await brain.close();
    expect(await snapshot(dir)).toEqual(before);
    expect(await head(dir)).toBe(sha);
    expect(await porcelain(dir)).toBe('');
    // o banco existe, mas a varredura só roda na primeira operação
    const index = await openIndex(dir);
    try {
      expect(indexStatus(index)).toMatchObject({ notes: 0, lastScanAt: null });
    } finally {
      index.close();
    }
  });

  it('pasta que não é cérebro: not_a_brain, sem criar nada', async () => {
    const dir = await createBrainRepo();
    const empty = join(dir, '..', 'vazia');
    mkdirSync(empty);
    const error = await errorOf(openTest(empty));
    expect(error.code).toBe('not_a_brain');
    expect(error.nextStep).toMatch(/cabecao init/);
    expect(error.toJSON()).toMatchObject({ code: 'not_a_brain' });
    expect((await snapshot(empty)).size).toBe(0);
    expect((await errorOf(openTest(join(dir, '..', 'nao-existe')))).code).toBe('not_a_brain');
  });

  it('nome de cliente inválido é recusado', async () => {
    const dir = await createBrainRepo();
    expect((await errorOf(openTest(dir, { client: 'meu cliente\n' }))).code).toBe('invalid_argument');
  });
});

describe('leituras', { timeout: TEST_TIMEOUT_MS }, () => {
  it('recall: regras, handoff, preferências, armadilhas e memórias, sem vencidos nem arquivados', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const briefing = await brain.recall({ task: 'migrar consumidores do Atlas para SQS', scope: 'project:atlas' });
    expect(briefing.data_notice).toBe(DATA_NOTICE);
    expect(isUlid(briefing.session_handle)).toBe(true);
    expect(briefing.priority).toEqual(RECALL_PRIORITY);
    expect(briefing.rules.map((item) => item.title)).toEqual(['Nunca commitar segredos']);
    expect(briefing.rules[0]).toMatchObject({
      trust: 'high',
      origin: 'human',
      content_kind: 'note',
      validity: 'current',
    });
    expect(briefing.rules[0]?.content).toMatch(/^Nunca grave chaves/);
    expect(briefing.handoff?.title).toBe('Atlas, consumidores em lote');
    expect(briefing.handoff?.sources).toEqual(['[[2026-11-10-migracao-dos-consumidores]]']);
    expect(briefing.preferences.map((item) => item.title)).toEqual(['Respostas em português']);
    expect(briefing.gotchas.map((item) => item.title)).toEqual(['Testes de integração falham sem limpar o banco']);
    expect(briefing.memories.length).toBeGreaterThan(0);
    for (const item of briefing.memories) {
      expect(item.validity).toBe('current');
      expect(item.content_kind).toBe('snippet');
      expect(item.path.startsWith('memory/_archive/')).toBe(false);
    }
    // o fato vencido (RabbitMQ) e a preferência arquivada ficam de fora
    const everything = JSON.stringify(briefing);
    expect(everything).not.toMatch(/fato-atlas-usa-rabbitmq/);
    expect(everything).not.toMatch(/Indentar com tabs/);
    expect(briefing.truncated).toBe(false);
    expect(briefing.used_tokens).toBeLessThanOrEqual(briefing.budget_tokens);
    // um session_handle novo a cada recall
    expect((await brain.recall({ task: 'outra' })).session_handle).not.toBe(briefing.session_handle);
  });

  it('recall respeita o orçamento na ordem de prioridade: nada entra no lugar de algo mais prioritário', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const full = await brain.recall({ task: 'fila SQS Atlas', budget_tokens: 100_000 });
    const sizes = RECALL_PRIORITY.map((section) =>
      section === 'handoff' ? (full.handoff === null ? 0 : 1) : full[section].length,
    );
    expect(sizes.every((n) => n > 0)).toBe(true);
    const total = sizes.reduce((a, b) => a + b, 0);
    let previous = 0;
    for (const budget of [50, 300, 450, 600, 800, 1000, 1500, 2500, 100_000]) {
      const result = await brain.recall({ task: 'fila SQS Atlas', budget_tokens: budget });
      const got = RECALL_PRIORITY.map((section) =>
        section === 'handoff' ? (result.handoff === null ? 0 : 1) : result[section].length,
      );
      // cada seção só tem algo se as anteriores vieram inteiras
      for (let i = 1; i < got.length; i++) {
        if ((got[i] ?? 0) > 0) for (let j = 0; j < i; j++) expect(got[j]).toBe(sizes[j]);
      }
      const included = got.reduce((a, b) => a + b, 0);
      if (included > 0) expect(result.used_tokens).toBeLessThanOrEqual(budget);
      expect(result.truncated).toBe(included < total);
      expect(result.omitted).toBe(total - included);
      if (budget <= 100) expect(included).toBe(0);
      // mais orçamento nunca traz menos itens
      expect(included).toBeGreaterThanOrEqual(previous);
      previous = included;
    }
    expect(previous).toBe(total);
  });

  it('search: hits com validade, proveniência e caminho; vencidos rebaixados, não escondidos', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const result = await brain.search({ query: 'RabbitMQ' });
    expect(result.data_notice).toBe(DATA_NOTICE);
    expect(result.hits.length).toBeGreaterThan(1);
    const paths = result.hits.map((hit) => hit.path);
    expect(paths).toContain('wiki/decisions/usar-sqs-para-filas.md');
    const expired = result.hits.find((hit) => hit.path === 'wiki/decisions/usar-rabbitmq-para-filas.md');
    expect(expired?.validity).toBe('expired');
    for (const hit of result.hits) {
      expect(hit).toHaveProperty('trust');
      expect(hit).toHaveProperty('origin');
      expect(Array.isArray(hit.sources)).toBe(true);
      expect(hit.content_kind).toBe('snippet');
      expect(hit).not.toHaveProperty('related');
    }
    const decisions = await brain.search({ query: 'fila', types: ['decision'] });
    expect(decisions.hits.every((hit) => hit.type === 'decision')).toBe(true);
    const none = await brain.search({ query: 'xyzzyinexistente' });
    expect(none.hits).toEqual([]);
    expect(none.next_step).toBeDefined();
    expect((await errorOf(brain.search({ query: 'x', scope: 'qualquer' }))).code).toBe('invalid_argument');
    expect((await errorOf(brain.search({ query: 'x', types: ['inventado'] }))).code).toBe('invalid_argument');
  });

  it('read: por caminho e por id, com seção, links de saída e backlinks; caminho inseguro recusado', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const atlas = await brain.read({ path: 'wiki/entities/Projeto Atlas.md' });
    expect(atlas.data_notice).toBe(DATA_NOTICE);
    expect(atlas.note.content_kind).toBe('note');
    expect(atlas.frontmatter.type).toBe('entity');
    expect(atlas.backlinks.length).toBeGreaterThan(0);
    expect(atlas.backlinks.map((link) => link.path)).toContain(
      'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md',
    );
    const byId = await brain.read({ id: atlas.note.id });
    expect(byId.note.path).toBe('wiki/entities/Projeto Atlas.md');
    expect(byId.note.content).toBe(atlas.note.content);

    const fila = await brain.read({ path: 'wiki/concepts/Fila de mensagens.md' });
    expect(fila.outgoing_links.find((link) => link.target === 'Kafka')?.broken).toBe(true);
    expect(fila.headings.length).toBeGreaterThan(0);
    const heading = fila.headings[0] ?? '';
    const section = await brain.read({ path: 'wiki/concepts/Fila de mensagens.md', section: heading });
    expect(section.note.content_kind).toBe('section');
    expect(section.note.content.length).toBeLessThan(fila.note.content.length + 1);
    const missing = await errorOf(brain.read({ path: 'wiki/concepts/Fila de mensagens.md', section: 'Não existe' }));
    expect(missing.code).toBe('not_found');
    expect(missing.details.headings).toEqual(fila.headings);

    for (const path of ['../fora.md', '.git/config', '/etc/passwd', 'C:\\Windows\\win.ini']) {
      expect((await errorOf(brain.read({ path }))).code).toBe('unsafe_path');
    }
    expect((await errorOf(brain.read({ path: 'AGENTS.md' }))).code).toBe('not_found');
    expect((await errorOf(brain.read({ path: 'wiki/nada.md' }))).code).toBe('not_found');
    expect((await errorOf(brain.read({ id: '01KQB9YDZ08HD1F6B7GRHFG5N0' }))).code).toBe('not_found');
  });

  it('read: nota arquivada e fato vencido saem marcados', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const archived = await brain.read({ path: 'memory/_archive/preferencia-usar-tabs.md' });
    expect(archived.archived).toBe(true);
    expect(archived.note.validity).toBe('expired');
    const fact = await brain.read({ path: 'memory/facts/fato-atlas-usa-rabbitmq.md' });
    expect(fact.note.validity).toBe('expired');
  });

  it('status: contagens, esquema, conflitos, links quebrados e remoto', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const result = await brain.status();
    expect(result).toMatchObject({
      healthy: true,
      problems: [],
      client: 'teste',
      machine: 'maquina-a',
      brain_schema_version: 1,
      broken_links: 1,
      conflicts: [],
    });
    expect(result.notes.by_type).toMatchObject({ rule: 1, preference: 1, gotcha: 1, handoff: 1, fact: 4 });
    expect(result.notes.archived).toBe(1);
    expect(result.index.schema_version).toBe(result.index.expected_schema_version);
    expect(result.index.last_scan_at).not.toBeNull();
    expect(result.sync).toMatchObject({ branch: 'main', remote_configured: false, remote: null, pending_changes: 0 });
  });

  it('a varredura acompanha edições feitas fora do Cabeção entre duas leituras', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    expect((await brain.search({ query: 'zebrafantasma' })).hits).toEqual([]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'wiki', 'concepts', 'Nova.md'),
      '---\nid: 01KZZZZZZZZZZZZZZZZZZZZZZZ\ntype: concept\ntitle: Nova\n---\nFala da zebrafantasma.\n',
    );
    expect((await brain.search({ query: 'zebrafantasma' })).hits.map((hit) => hit.path)).toEqual([
      'wiki/concepts/Nova.md',
    ]);
  });

  it('fechar: operações depois do close falham com closed', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    await brain.close();
    expect((await errorOf(brain.search({ query: 'fila' }))).code).toBe('closed');
  });
});
