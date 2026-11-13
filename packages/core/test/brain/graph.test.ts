// Marco 3 na camada de operações: `as_of` e o bloco `related` na busca, as operações `facts`, `graph` e `relate`, e
// as relações tipadas de ponta a ponta (gravadas pelo `remember`, indexadas com validade e devolvidas pelo `graph`).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Brain } from '../../src/brain/index.ts';
import { BrainError } from '../../src/brain/index.ts';
import { openIndex, searchKeyword } from '../../src/db/index.ts';
import { parseCommitTrailers } from '../../src/git/index.ts';
import {
  cleanupAll,
  commitCount,
  commitMessageOf,
  createBrainRepo,
  disposeSandbox,
  git,
  openTest,
  porcelain,
  readText,
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

let shared: { dir: string; brain: Brain } | null = null;
async function fixtureBrain(): Promise<Brain> {
  const dir = await createBrainRepo();
  const brain = await openTest(dir, { client: 'claude-code', actor: 'agent' });
  shared = { dir, brain };
  return brain;
}

describe('search com as_of', { timeout: TEST_TIMEOUT_MS }, () => {
  it('no passado, a decisão que valia na época fica acima da atual; hoje, o contrário; nada é escondido', async () => {
    const brain = await fixtureBrain();
    const rank = async (as_of?: string) => {
      const out = await brain.search({ query: 'filas', ...(as_of === undefined ? {} : { as_of }) });
      const paths = out.hits.map((hit) => hit.path);
      const validity = Object.fromEntries(out.hits.map((hit) => [hit.path, hit.validity]));
      return { out, paths, validity };
    };
    const rabbit = 'wiki/decisions/usar-rabbitmq-para-filas.md';
    const sqs = 'wiki/decisions/usar-sqs-para-filas.md';

    const past = await rank('2026-03-01');
    expect(past.out.as_of).toBe('2026-03-01');
    expect(past.validity[rabbit]).toBe('current');
    expect(past.validity[sqs]).toBe('not_yet_valid');
    expect(past.paths.indexOf(rabbit)).toBeLessThan(past.paths.indexOf(sqs));
    expect(past.paths[0]).toBe(rabbit);

    const now = await rank();
    expect(now.out.as_of).toBe('2026-11-12');
    expect(now.validity[rabbit]).toBe('expired');
    expect(now.validity[sqs]).toBe('current');
    expect(now.paths[0]).toBe(sqs);
    expect(now.paths).toContain(rabbit);

    // exatamente no dia da troca: a nova vale, a antiga venceu (valid_until é exclusivo)
    const swap = await rank('2026-05-03');
    expect([swap.validity[rabbit], swap.validity[sqs]]).toEqual(['expired', 'current']);
  });

  it('liderança: Ana até 2026-09-01, Bruno depois, pelos fatos na busca', async () => {
    const brain = await fixtureBrain();
    const at = async (as_of: string) =>
      Object.fromEntries(
        (await brain.search({ query: 'liderou lidera Atlas', types: ['fact'], as_of })).hits.map((hit) => [
          hit.path,
          hit.validity,
        ]),
      );
    expect(await at('2026-06-01')).toMatchObject({
      'memory/facts/fato-ana-lidera-atlas.md': 'current',
      'memory/facts/fato-bruno-lidera-atlas.md': 'not_yet_valid',
    });
    expect(await at('2026-10-01')).toMatchObject({
      'memory/facts/fato-ana-lidera-atlas.md': 'expired',
      'memory/facts/fato-bruno-lidera-atlas.md': 'current',
    });
  });

  it('as_of inválido é recusado com mensagem clara', async () => {
    const brain = await fixtureBrain();
    for (const as_of of ['ontem', '2026-02-30', '2026-13-01', '26-05-03', "2026-05-03' or 1=1", '']) {
      const error = await errorOf(brain.search({ query: 'filas', as_of }));
      expect(error.code, as_of).toBe('invalid_argument');
      expect(error.message).toContain('as_of');
    }
  });
});

describe('bloco related', { timeout: TEST_TIMEOUT_MS }, () => {
  it('vizinhos dos melhores resultados, com o motivo, sem mudar a ordem dos hits', async () => {
    const brain = await fixtureBrain();
    const out = await brain.search({ query: 'migrou SQS custo', limit: 3 });
    expect(out.related.length).toBeGreaterThan(0);
    expect(out.related.length).toBeLessThanOrEqual(5);
    const hitPaths = out.hits.map((hit) => hit.path);
    for (const item of out.related) {
      expect(hitPaths).not.toContain(item.path);
      expect(item.reasons.length).toBeGreaterThan(0);
      for (const reason of item.reasons) {
        expect(hitPaths).toContain(reason.from);
        expect(reason.origin).not.toBe('mention');
      }
    }
    // a ordem dos hits é a da busca por palavra-chave pura, sem o grafo
    const index = await openIndex(shared?.dir ?? '');
    try {
      const plain = searchKeyword(index, { query: 'migrou SQS custo', limit: 3, asOf: '2026-11-12' });
      expect(plain.hits.map((hit) => hit.path)).toEqual(hitPaths);
    } finally {
      index.close();
    }
  });

  it('com orçamento curto, o related é o primeiro a sair; sem hits, sem related', async () => {
    const brain = await fixtureBrain();
    const roomy = await brain.search({ query: 'SQS' });
    expect(roomy.related.length).toBeGreaterThan(0);
    const tight = await brain.search({ query: 'SQS', limit: 1, budget_tokens: 120 });
    expect(tight.hits.length).toBe(1);
    expect(tight.related.length).toBeLessThan(roomy.related.length);
    expect((await brain.search({ query: 'xyzzyinexistente' })).related).toEqual([]);
  });

  it('respeita as_of: no passado, quem decidiu a fila do Atlas era a Ana', async () => {
    const brain = await fixtureBrain();
    const past = await brain.search({ query: 'Usar RabbitMQ', as_of: '2026-03-01', limit: 1 });
    expect(past.hits[0]?.path).toBe('wiki/decisions/usar-rabbitmq-para-filas.md');
    const ana = past.related.find((item) => item.path === 'wiki/entities/Ana Prado.md');
    expect(ana?.reasons[0]).toMatchObject({ type: 'decided_by', direction: 'out', validity: 'current' });
    // hoje a decisão do RabbitMQ venceu: a mesma relação vem marcada como vencida
    const now = await brain.search({ query: 'Usar RabbitMQ', types: ['decision'], limit: 2 });
    const later = now.related.find((item) => item.path === 'wiki/entities/Ana Prado.md');
    expect(later?.reasons).toContainEqual({
      from: 'wiki/decisions/usar-rabbitmq-para-filas.md',
      type: 'decided_by',
      origin: 'relation',
      direction: 'out',
      validity: 'expired',
    });
  });
});

describe('facts', { timeout: TEST_TIMEOUT_MS }, () => {
  it('vigente na data, com a cadeia e o envelope de dado; sujeito por título, caminho, wikilink ou id', async () => {
    const brain = await fixtureBrain();
    const atlas = await brain.read({ path: 'wiki/entities/Projeto Atlas.md' });
    for (const subject of [
      'Projeto Atlas',
      'projeto atlas',
      'wiki/entities/Projeto Atlas.md',
      '[[Projeto Atlas]]',
      atlas.note.id,
    ]) {
      const out = await brain.facts({ subject, predicate: 'led_by', as_of: '2026-06-01' });
      expect(out.subject?.path, subject).toBe('wiki/entities/Projeto Atlas.md');
      expect(out.facts.map((fact) => [fact.path, fact.validity])).toEqual([
        ['memory/facts/fato-ana-lidera-atlas.md', 'current'],
        ['memory/facts/fato-bruno-lidera-atlas.md', 'not_yet_valid'],
      ]);
    }
    const now = await brain.facts({ subject: 'Projeto Atlas', predicate: 'led_by' });
    expect(now.as_of).toBe('2026-11-12');
    expect(now.data_notice).toMatch(/dado/);
    const [bruno, ana] = now.facts;
    expect(bruno).toMatchObject({
      path: 'memory/facts/fato-bruno-lidera-atlas.md',
      validity: 'current',
      object: 'Bruno Tavares',
      object_path: 'wiki/entities/Bruno Tavares.md',
      supersedes: ['memory/facts/fato-ana-lidera-atlas.md'],
      superseded_by: [],
      trust: 'high',
      origin: 'human',
      content_kind: 'note',
    });
    expect(bruno?.content).toContain('Bruno Tavares lidera');
    expect(ana).toMatchObject({ validity: 'expired', superseded_by: ['memory/facts/fato-bruno-lidera-atlas.md'] });
  });

  it('objeto resolvido como nota; sem filtro traz todos; predicado inválido é recusado', async () => {
    const brain = await fixtureBrain();
    const byObject = await brain.facts({ object: 'SQS' });
    expect(byObject.facts.map((fact) => fact.path)).toEqual(['memory/facts/fato-atlas-usa-sqs.md']);
    const all = await brain.facts();
    expect(all.total).toBe(4);
    const limited = await brain.facts({ limit: 1 });
    expect(limited.facts.length).toBe(1);
    expect(limited.truncated).toBe(true);
    const none = await brain.facts({ subject: 'Nota que não existe' });
    expect(none.subject).toEqual({ query: 'Nota que não existe', path: null });
    expect(none.facts).toEqual([]);
    expect(none.next_step).toBeTruthy();
    for (const predicate of ['Led By', 'led-by', "x' or 1=1", '']) {
      expect((await errorOf(brain.facts({ predicate }))).code, predicate).toBe('invalid_argument');
    }
  });
});

describe('graph', { timeout: TEST_TIMEOUT_MS }, () => {
  it('vizinhos com tipo, direção e validade; resolve por título; depth 2 vai mais longe', async () => {
    const brain = await fixtureBrain();
    const out = await brain.graph({ node: 'Usar RabbitMQ para filas' });
    expect(out.resolved_by).toBe('title');
    expect(out.node).toMatchObject({ path: 'wiki/decisions/usar-rabbitmq-para-filas.md', validity: 'expired' });
    const ana = out.neighbors.find((neighbor) => neighbor.path === 'wiki/entities/Ana Prado.md');
    expect(ana?.distance).toBe(1);
    expect(ana?.links).toContainEqual({
      from: 'wiki/decisions/usar-rabbitmq-para-filas.md',
      to: 'wiki/entities/Ana Prado.md',
      type: 'decided_by',
      origin: 'relation',
      direction: 'out',
      validity: 'expired',
    });
    const sqs = out.neighbors.find((neighbor) => neighbor.path === 'wiki/decisions/usar-sqs-para-filas.md');
    expect(sqs?.links.some((link) => link.type === 'supersedes' && link.direction === 'in')).toBe(true);
    const two = await brain.graph({ node: 'Usar RabbitMQ para filas', depth: 2 });
    expect(two.total).toBeGreaterThan(out.total);
    expect(two.neighbors.some((neighbor) => neighbor.distance === 2)).toBe(true);
  });

  it('relation_types filtra (mention é um tipo próprio); tipo desconhecido e depth fora de 1–2 são recusados', async () => {
    const brain = await fixtureBrain();
    const mentions = await brain.graph({ node: 'SQS', relation_types: ['mention'] });
    expect(mentions.neighbors.map((neighbor) => neighbor.path)).toEqual(['raw/meetings/2026-05-03-arquitetura.md']);
    expect(mentions.neighbors[0]?.links[0]).toMatchObject({ origin: 'mention', type: 'mention', direction: 'in' });
    const uses = await brain.graph({ node: 'SQS', relation_types: ['uses'] });
    expect(new Set(uses.neighbors.flatMap((neighbor) => neighbor.links.map((link) => link.type)))).toEqual(
      new Set(['uses']),
    );
    expect((await errorOf(brain.graph({ node: 'SQS', relation_types: ['owns'] }))).code).toBe('invalid_argument');
    for (const depth of [0, 3, 1.5, -1]) {
      expect((await errorOf(brain.graph({ node: 'SQS', depth }))).code, String(depth)).toBe('invalid_argument');
    }
    expect((await errorOf(brain.graph({ node: 'Nada com esse nome' }))).code).toBe('not_found');
  });

  it('limite e orçamento cortam a resposta com truncated e omitted', async () => {
    const brain = await fixtureBrain();
    const full = await brain.graph({ node: 'Projeto Atlas', depth: 2, budget_tokens: 100_000 });
    expect(full.truncated).toBe(false);
    const small = await brain.graph({ node: 'Projeto Atlas', depth: 2, limit: 3, budget_tokens: 100_000 });
    expect(small.neighbors.length).toBe(3);
    expect(small.truncated).toBe(true);
    expect(small.omitted).toBe(full.total - 3);
    expect(small.next_step).toBeTruthy();
    const tight = await brain.graph({ node: 'Projeto Atlas', budget_tokens: 300 });
    expect(tight.truncated).toBe(true);
    expect(JSON.stringify(tight).length / 4).toBeLessThan(600);
  });
});

describe('relate', { timeout: TEST_TIMEOUT_MS }, () => {
  it('grava uma propriedade por relação, com o wikilink mais curto, num commit com os rodapés; é idempotente', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir, { client: 'claude-code', actor: 'agent' });
    const before = await commitCount(dir);
    const out = await brain.relate({ from: 'Fila de mensagens', type: 'related_to', to: 'SQS' });
    expect(out).toMatchObject({
      changed: true,
      path: 'wiki/concepts/Fila de mensagens.md',
      relation: {
        from: 'wiki/concepts/Fila de mensagens.md',
        type: 'related_to',
        to: 'wiki/entities/SQS.md',
        link: '[[SQS]]',
      },
    });
    expect(await commitCount(dir)).toBe(before + 1);
    const trailers = parseCommitTrailers(await commitMessageOf(dir));
    expect(trailers.op).toBe(out.op);
    expect(trailers.client).toBe('claude-code');
    const text = await readText(dir, 'wiki/concepts/Fila de mensagens.md');
    expect(text).toContain('related_to: ["[[Idempotência]]", "[[SQS]]"]');
    expect(await porcelain(dir)).toBe('');

    // de novo, pelo caminho e por outro nome do mesmo destino: nada muda
    const again = await brain.relate({ from: 'wiki/concepts/Fila de mensagens.md', type: 'related_to', to: '[[sqs]]' });
    expect(again.changed).toBe(false);
    expect(again.commit).toBeNull();
    expect(again.relation.link).toBe('[[SQS]]');
    expect(await commitCount(dir)).toBe(before + 1);

    // o graph enxerga a relação nova; o undo a desfaz
    const graph = await brain.graph({ node: 'SQS', relation_types: ['related_to'] });
    expect(graph.neighbors.map((neighbor) => neighbor.path)).toContain('wiki/concepts/Fila de mensagens.md');
    await brain.undo({ op: out.op });
    expect(await readText(dir, 'wiki/concepts/Fila de mensagens.md')).not.toContain('[[SQS]]"]');
  });

  it('nota do usuário: rebaixa trust e grava edited_by; relação extra do .cabecao.json vale; desconhecida não', async () => {
    const dir = await createBrainRepo();
    await writeFile(
      join(dir, '.cabecao.json'),
      `${JSON.stringify({ schemaVersion: 1, noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md', relations: ['mentored_by'] })}\n`,
    );
    await git(dir, ['commit', '--quiet', '-am', 'relação extra']);
    const brain = await openTest(dir, { client: 'claude-code', actor: 'agent' });
    const out = await brain.relate({ from: 'Bruno Tavares', type: 'mentored_by', to: 'Ana Prado' });
    expect(out.warnings.map((warning) => warning.code)).toContain('provenance_changed');
    const read = await brain.read({ path: 'wiki/entities/Bruno Tavares.md' });
    expect(read.frontmatter).toMatchObject({
      trust: 'medium',
      edited_by: 'agent:claude-code',
      origin: 'human',
      mentored_by: ['[[Ana Prado]]'],
    });
    for (const type of ['owns', 'Uses', 'title', 'origin', 'trust', 'id', '__proto__', 'uses\nrule', '']) {
      expect((await errorOf(brain.relate({ from: 'SQS', type, to: 'RabbitMQ' }))).code, type).toBe('invalid_argument');
    }
    expect((await errorOf(brain.relate({ from: 'SQS', type: 'uses', to: 'Kafka' }))).code).toBe('not_found');
    expect((await errorOf(brain.relate({ from: 'SQS', type: 'uses', to: 'wiki/entities/SQS.md' }))).code).toBe(
      'invalid_argument',
    );
  });

  it('relações tipadas de ponta a ponta: remember grava uma propriedade por relação, o banco indexa com validade', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir, { client: 'claude-code', actor: 'agent' });
    const out = await brain.remember({
      type: 'decision',
      title: 'Usar Kafka para eventos',
      content: 'Eventos de rastreio vão para um log.\n',
      scope: 'project:atlas',
      valid_from: '2026-11-01',
      valid_until: '2027-01-01',
      aliases: ['Kafka para eventos'],
      relations: { part_of: ['Projeto Atlas'], decided_by: ['Bruno Tavares', '[[Ana Prado]]'], related_to: ['SQS'] },
    });
    const text = await readText(dir, out.path);
    expect(text).toContain('part_of: ["[[Projeto Atlas]]"]');
    expect(text).toContain('decided_by: ["[[Bruno Tavares]]", "[[Ana Prado]]"]');
    expect(text).toContain('aliases: [Kafka para eventos]');
    expect(text).not.toContain('relations:');
    const now = await brain.graph({ node: out.path, relation_types: ['decided_by'] });
    expect(now.neighbors.map((neighbor) => [neighbor.path, neighbor.links[0]?.validity])).toEqual([
      ['wiki/entities/Ana Prado.md', 'current'],
      ['wiki/entities/Bruno Tavares.md', 'current'],
    ]);
    const later = await brain.graph({ node: out.path, relation_types: ['decided_by'], as_of: '2027-02-01' });
    expect(later.neighbors.every((neighbor) => neighbor.links[0]?.validity === 'expired')).toBe(true);
    const before = await brain.graph({ node: 'Kafka para eventos', as_of: '2026-10-01' });
    expect(before.resolved_by).toBe('alias');
    expect(before.node.validity).toBe('not_yet_valid');
  });
});
