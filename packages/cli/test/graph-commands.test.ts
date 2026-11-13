// `graph`, `facts` e `search --as-of` sobre uma cópia do cérebro de exemplo.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brainRepo, closeOpened, disposeSandbox, machine, parseJson, TEST_TIMEOUT_MS } from './helpers.ts';

let brain: string;
let m: ReturnType<typeof machine>;

beforeEach(async () => {
  brain = await brainRepo();
  m = machine();
});

afterEach(async () => {
  await closeOpened();
});

afterAll(() => {
  disposeSandbox();
});

describe('search --as-of', { timeout: TEST_TIMEOUT_MS }, () => {
  it('no passado, a decisão da época vem primeiro e a atual aparece como ainda não vigente', async () => {
    const result = await m.cabecao(['search', 'filas', '--as-of', '2026-03-01', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('(validade em 2026-03-01)');
    expect(result.stdout).toMatch(/^1\. Usar RabbitMQ para filas .*vigente$/m);
    expect(result.stdout).toMatch(/Usar SQS para filas .*AINDA NÃO VIGENTE/);
    expect(result.stdout).toContain('Relacionadas (vizinhas dos melhores resultados no grafo');

    const json = parseJson(await m.cabecao(['search', 'filas', '--as-of', '2026-03-01', '--brain', brain, '--json']));
    expect(json.data.as_of).toBe('2026-03-01');
    expect(json.data.hits[0].path).toBe('wiki/decisions/usar-rabbitmq-para-filas.md');
    expect(json.data.related.length).toBeGreaterThan(0);

    const bad = await m.cabecao(['search', 'filas', '--as-of', 'ontem', '--brain', brain]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('as_of');
  });
});

describe('graph', { timeout: TEST_TIMEOUT_MS }, () => {
  it('mostra os vizinhos com a relação e a validade; --depth, --type e --json', async () => {
    const result = await m.cabecao(['graph', 'Usar RabbitMQ para filas', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('wiki/decisions/usar-rabbitmq-para-filas.md');
    expect(result.stdout).toContain('Ligados direto:');
    expect(result.stdout).toContain(
      'wiki/decisions/usar-rabbitmq-para-filas.md —decided_by→ wiki/entities/Ana Prado.md (VENCIDO)',
    );

    const typed = parseJson(
      await m.cabecao(['graph', 'SQS', '--type', 'mention', '--depth', '1', '--brain', brain, '--json']),
    );
    expect(typed.data.neighbors.map((n: { path: string }) => n.path)).toEqual([
      'raw/meetings/2026-05-03-arquitetura.md',
    ]);
    const deep = parseJson(await m.cabecao(['graph', 'SQS', '--depth', '2', '--brain', brain, '--json']));
    expect(deep.data.neighbors.some((n: { distance: number }) => n.distance === 2)).toBe(true);
  });

  it('erros: sem nota (uso), --depth inválido (uso), tipo desconhecido (uso), nota que não existe', async () => {
    expect((await m.cabecao(['graph', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['graph', 'SQS', '--depth', '3', '--brain', brain])).code).toBe(2);
    const type = await m.cabecao(['graph', 'SQS', '--type', 'owns', '--brain', brain]);
    expect(type.code).toBe(2);
    expect(type.stderr).toContain('owns');
    const missing = await m.cabecao(['graph', 'Nota que não existe', '--brain', brain]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('nenhuma nota');
  });
});

describe('facts', { timeout: TEST_TIMEOUT_MS }, () => {
  it('lista os fatos com a validade na data e a cadeia; --json', async () => {
    const result = await m.cabecao([
      'facts',
      '--subject',
      'Projeto Atlas',
      '--predicate',
      'led_by',
      '--as-of',
      '2026-06-01',
      '--brain',
      brain,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('validade em 2026-06-01');
    expect(result.stdout).toMatch(/1\. Projeto Atlas · led_by · Ana Prado {2}vigente/);
    expect(result.stdout).toMatch(/2\. Projeto Atlas · led_by · Bruno Tavares {2}AINDA NÃO VIGENTE/);
    expect(result.stdout).toContain('substituído por: memory/facts/fato-bruno-lidera-atlas.md');

    const json = parseJson(await m.cabecao(['facts', '--object', 'SQS', '--brain', brain, '--json']));
    expect(json.data.facts.map((fact: { path: string }) => fact.path)).toEqual(['memory/facts/fato-atlas-usa-sqs.md']);
  });

  it('erros de uso: posicional, predicado e data inválidos', async () => {
    expect((await m.cabecao(['facts', 'Projeto Atlas', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['facts', '--predicate', 'Led By', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['facts', '--as-of', '2026-02-30', '--brain', brain])).code).toBe(2);
  });
});
