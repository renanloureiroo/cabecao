// Grafo no banco local (marco 3): vizinhança por CTE recursiva, filtros por tipo, validade das arestas numa data,
// teto da recursão num nó muito ligado, encadeamento de versões e a exportação determinística.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportGraph,
  getNote,
  neighborhood,
  queryFacts,
  relatedCandidates,
  resolveNodeRef,
  scan,
} from '../../src/db/index.ts';
import type { OpenVault } from './helpers.ts';
import { openEmptyVault, openFixture } from './helpers.ts';

const opened: OpenVault[] = [];
afterEach(async () => {
  for (const vault of opened.splice(0)) await vault.cleanup();
});

async function scanned(label: string, empty = false): Promise<OpenVault> {
  const vault = empty ? await openEmptyVault(label) : await openFixture(label);
  opened.push(vault);
  await scan(vault.index, vault.root, vault.config);
  return vault;
}

function idOf(vault: OpenVault, path: string): string {
  const note = getNote(vault.index, { path });
  if (note === null) throw new Error(`sem nota em ${path}`);
  return note.id;
}

const pathsOf = (vault: OpenVault, ids: Iterable<string>): string[] =>
  [...ids].map((id) => getNote(vault.index, { id })?.path ?? id).sort();

describe('resolveNodeRef', () => {
  it('id, caminho (com ou sem .md, outra caixa), wikilink, título sem acento e apelido', async () => {
    const vault = await scanned('graph-resolve');
    const sqs = 'wiki/entities/SQS.md';
    const by = (ref: string) => {
      const found = resolveNodeRef(vault.index, ref);
      return found.kind === 'found' ? [found.by, found.note.path] : [found.kind];
    };
    expect(by(idOf(vault, sqs))).toEqual(['id', sqs]);
    expect(by('wiki/entities/sqs')).toEqual(['path', sqs]);
    expect(by('[[SQS|serviço]]')).toEqual(['link', sqs]);
    expect(by('Usar SQS para filas')).toEqual(['title', 'wiki/decisions/usar-sqs-para-filas.md']);
    expect(by('idempotencia')).toEqual(['title', 'wiki/concepts/Idempotência.md']);
    expect(by('Reunião de arquitetura — 03/05/2026')).toEqual(['title', 'raw/meetings/2026-05-03-arquitetura.md']);
    for (const ref of ['../../etc/passwd', '/etc/passwd', 'C:\\Windows', "x' or 1=1 --", '', '[[]]', 'Kafka']) {
      expect(by(ref), ref).toEqual(['not_found']);
    }
  });

  it('título de duas notas é ambíguo e devolve as candidatas', async () => {
    const vault = await openFixture('graph-ambiguous');
    opened.push(vault);
    await mkdir(join(vault.root, 'wiki', 'concepts'), { recursive: true });
    for (const [file, id] of [
      ['Fila A.md', '01KZ0000000000000000000021'],
      ['Fila B.md', '01KZ0000000000000000000022'],
    ]) {
      await writeFile(
        join(vault.root, 'wiki', 'concepts', file),
        `---\nid: ${id}\ntype: concept\ntitle: Fila compartilhada\n---\ntexto\n`,
      );
    }
    await scan(vault.index, vault.root, vault.config);
    const found = resolveNodeRef(vault.index, 'fila compartilhada');
    expect(found.kind).toBe('ambiguous');
    expect(found.kind === 'ambiguous' ? found.candidates.map((note) => note.path) : []).toEqual([
      'wiki/concepts/Fila A.md',
      'wiki/concepts/Fila B.md',
    ]);
  });
});

describe('neighborhood', () => {
  it('1 salto nas duas direções, com as relações tipadas, os fatos e as menções', async () => {
    const vault = await scanned('graph-1');
    const start = idOf(vault, 'wiki/entities/SQS.md');
    const hood = neighborhood(vault.index, { start, depth: 1, asOf: '2026-11-12' });
    const near = pathsOf(vault, hood.distance.keys());
    expect(near).toContain('wiki/decisions/usar-sqs-para-filas.md'); // uses (entrando)
    expect(near).toContain('wiki/concepts/Fila de mensagens.md'); // link (saindo)
    expect(near).toContain('memory/facts/fato-atlas-usa-sqs.md'); // object do fato
    expect(near).toContain('raw/meetings/2026-05-03-arquitetura.md'); // menção sem link
    expect(near).not.toContain('memory/_archive/preferencia-usar-tabs.md');
    expect([...hood.distance.values()].every((d) => d === 1)).toBe(true);
    const uses = hood.edges.find((edge) => edge.type === 'uses' && edge.dst === start);
    expect(uses).toMatchObject({ origin: 'relation', validity: 'current' });
  });

  it('filtro por tipo e validade da aresta na data: a decisão vencida ainda aparece, marcada', async () => {
    const vault = await scanned('graph-filter');
    const start = idOf(vault, 'wiki/entities/RabbitMQ.md');
    const hood = neighborhood(vault.index, {
      start,
      depth: 1,
      asOf: '2026-11-12',
      filters: [{ origin: 'relation', type: 'uses' }],
    });
    expect(pathsOf(vault, hood.distance.keys())).toEqual(['wiki/decisions/usar-rabbitmq-para-filas.md']);
    expect(hood.edges.map((edge) => edge.validity)).toEqual(['expired']);
    const past = neighborhood(vault.index, {
      start,
      depth: 1,
      asOf: '2026-03-01',
      filters: [{ origin: 'relation', type: 'uses' }],
    });
    expect(past.edges.map((edge) => edge.validity)).toEqual(['current']);
    // um tipo que não existe, com cara de SQL, não acha nada nem quebra a consulta
    const odd = neighborhood(vault.index, {
      start,
      depth: 2,
      asOf: '2026-11-12',
      filters: [{ origin: 'relation', type: "uses' or 1=1 --" }],
    });
    expect(odd.distance.size).toBe(0);
  });

  it('2 saltos: a distância de cada vizinho é a menor', async () => {
    const vault = await scanned('graph-2');
    const start = idOf(vault, 'wiki/entities/Lumen Logística.md');
    const hood = neighborhood(vault.index, { start, depth: 2, asOf: '2026-11-12' });
    expect(hood.distance.get(idOf(vault, 'wiki/entities/Projeto Atlas.md'))).toBe(1);
    expect(hood.distance.get(idOf(vault, 'wiki/entities/SQS.md'))).toBe(2);
    expect(hood.distance.has(start)).toBe(false);
  });

  it('um nó com milhares de vizinhos para no teto da recursão', async () => {
    const vault = await openEmptyVault('graph-hub');
    opened.push(vault);
    await mkdir(join(vault.root, 'wiki', 'concepts'), { recursive: true });
    await writeFile(join(vault.root, 'wiki', 'concepts', 'Hub.md'), '---\ntype: concept\ntitle: Hub\n---\ncentro\n');
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 1200; i++) {
      writes.push(
        writeFile(
          join(vault.root, 'wiki', 'concepts', `Folha ${i}.md`),
          `Liga ao [[Hub]] e à [[Folha ${(i + 1) % 1200}]].\n`,
        ),
      );
    }
    await Promise.all(writes);
    await scan(vault.index, vault.root, vault.config);
    const start = idOf(vault, 'wiki/concepts/Hub.md');
    const started = performance.now();
    const hood = neighborhood(vault.index, { start, depth: 2, asOf: '2026-11-12', maxRows: 300 });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(hood.capped).toBe(true);
    expect(hood.distance.size).toBeLessThanOrEqual(300);
    const full = neighborhood(vault.index, { start, depth: 1, asOf: '2026-11-12' });
    expect(full.distance.size).toBe(1200);
  });
});

describe('relatedCandidates', () => {
  it('vizinhos dos resultados, sem os próprios resultados e sem menções', async () => {
    const vault = await scanned('graph-related');
    const seed = idOf(vault, 'wiki/decisions/usar-sqs-para-filas.md');
    const found = relatedCandidates(vault.index, {
      seeds: [seed],
      exclude: new Set([seed]),
      asOf: '2026-11-12',
      limit: 50,
    });
    const paths = found.map((item) => item.note.path);
    expect(paths).toContain('wiki/entities/Ana Prado.md');
    expect(paths).not.toContain('wiki/decisions/usar-sqs-para-filas.md');
    expect(found.every((item) => item.via.every((edge) => edge.origin !== 'mention'))).toBe(true);
    // a relação tipada pesa mais que o link solto no texto
    expect(paths.indexOf('wiki/concepts/Idempotência.md')).toBeLessThan(paths.indexOf('wiki/entities/RabbitMQ.md'));
  });
});

describe('queryFacts', () => {
  it('validade na data e a cadeia supersedes / superseded_by nos dois sentidos', async () => {
    const vault = await scanned('graph-facts');
    const atlas = idOf(vault, 'wiki/entities/Projeto Atlas.md');
    const at = (asOf: string) =>
      queryFacts(vault.index, { subjectId: atlas, predicate: 'uses_queue', asOf }).map((fact) => [
        fact.path,
        fact.validity,
      ]);
    expect(at('2026-03-01')).toEqual([
      ['memory/facts/fato-atlas-usa-rabbitmq.md', 'current'],
      ['memory/facts/fato-atlas-usa-sqs.md', 'not_yet_valid'],
    ]);
    expect(at('2026-11-12')).toEqual([
      ['memory/facts/fato-atlas-usa-sqs.md', 'current'],
      ['memory/facts/fato-atlas-usa-rabbitmq.md', 'expired'],
    ]);
    const [sqs, rabbit] = queryFacts(vault.index, { subjectId: atlas, predicate: 'uses_queue', asOf: '2026-11-12' });
    expect(sqs?.supersedes.map((ref) => ref.path)).toEqual(['memory/facts/fato-atlas-usa-rabbitmq.md']);
    expect(rabbit?.supersededBy.map((ref) => ref.path)).toEqual(['memory/facts/fato-atlas-usa-sqs.md']);
  });

  it('sem valid_until, a substituição pelo supersedes já vence o fato antigo na data da nova', async () => {
    const vault = await scanned('graph-derived', true);
    await mkdir(join(vault.root, 'memory', 'facts'), { recursive: true });
    await writeFile(
      join(vault.root, 'memory', 'facts', 'velho.md'),
      '---\nid: 01KZ0000000000000000000031\ntype: fact\nsubject: "[[Time]]"\npredicate: uses_ci\nobject: Jenkins\nvalid_from: 2025-01-01\n---\nJenkins.\n',
    );
    await writeFile(
      join(vault.root, 'memory', 'facts', 'novo.md'),
      '---\nid: 01KZ0000000000000000000032\ntype: fact\nsubject: "[[Time]]"\npredicate: uses_ci\nobject: GitHub Actions\nvalid_from: 2026-02-01\nsupersedes: ["[[velho]]"]\n---\nActions.\n',
    );
    await scan(vault.index, vault.root, vault.config);
    const at = (asOf: string) =>
      Object.fromEntries(
        queryFacts(vault.index, { subjectText: 'time', asOf }).map((fact) => [fact.object, fact.validity]),
      );
    expect(at('2025-06-01')).toEqual({ Jenkins: 'current', 'GitHub Actions': 'not_yet_valid' });
    expect(at('2026-02-01')).toEqual({ Jenkins: 'expired', 'GitHub Actions': 'current' });
  });
});

describe('exportGraph', () => {
  it('idêntico byte a byte em duas cópias do mesmo cérebro, ordenado e sem datas da máquina', async () => {
    const a = await scanned('export-a');
    const b = await scanned('export-outra-pasta');
    const first = exportGraph(a.index);
    expect(exportGraph(b.index)).toEqual(first);
    // varrer de novo não muda nada
    await scan(a.index, a.root, a.config, { full: true });
    expect(exportGraph(a.index)).toEqual(first);

    const nodes = first.nodes
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const edges = first.edges
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first.nodes.endsWith('\n')).toBe(true);
    expect(nodes.map((node) => node.id)).toEqual(
      [...nodes.map((node) => String(node.id))].sort((x, y) => (x < y ? -1 : 1)),
    );
    expect(Object.keys(nodes[0] ?? {})).toEqual([
      'id',
      'path',
      'type',
      'title',
      'scope',
      'valid_from',
      'valid_until',
      'archived',
    ]);
    expect(Object.keys(edges[0] ?? {})).toEqual(['src', 'dst', 'origin', 'type', 'target']);
    expect(new Set(edges.map((edge) => edge.origin))).toEqual(
      new Set(['wikilink', 'relation', 'supersedes', 'fact', 'mention']),
    );
    expect(first.nodes + first.edges).not.toMatch(/indexed_at|mtime|content_hash|20\d\d-\d\d-\d\dT/);
  });
});
