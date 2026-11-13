// Esquecimento por regra simples (doc 07, "Esquecimento"): memórias velhas nunca confirmadas perdem peso na busca,
// vencidas por `expires_at` ficam rebaixadas e saem do recall. Nada é escondido nem apagado.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { isStaleMemory, STALE_SCORE_FACTOR } from '../../src/db/index.ts';
import { cleanupAll, createBrainRepo, disposeSandbox, openTest, TEST_TIMEOUT_MS } from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

const gotcha = (id: string, extra: string): string =>
  `---\nid: ${id}\ntype: gotcha\ntitle: Pinguim azul\nscope: global\n${extra}\n---\nO pinguim azul trava o deploy quando a fila zebrapinguim enche.\n`;

describe('rebaixamento de memórias velhas nunca confirmadas', { timeout: TEST_TIMEOUT_MS }, () => {
  it('a regra: tipo de memória, sem confirmed, 180 dias desde a última atualização', () => {
    const base = { type: 'gotcha', confirmed: null, updated: '2026-05-01', created: '2026-01-01' };
    expect(isStaleMemory(base, '2026-11-12')).toBe(true);
    expect(isStaleMemory({ ...base, updated: '2026-06-01' }, '2026-11-12')).toBe(false);
    expect(isStaleMemory({ ...base, confirmed: '2026-01-02' }, '2026-11-12')).toBe(false);
    expect(isStaleMemory({ ...base, type: 'decision' }, '2026-11-12')).toBe(false);
    expect(isStaleMemory({ ...base, type: 'fact' }, '2026-11-12')).toBe(false);
  });

  it('na busca, a velha nunca confirmada vem abaixo da igual confirmada, com a pontuação rebaixada', async () => {
    const dir = await createBrainRepo();
    await writeFile(
      join(dir, 'memory', 'gotchas', 'pinguim-velho.md'),
      gotcha('01KZ0000000000000000000011', 'created: 2025-01-10\nupdated: 2025-01-10'),
    );
    await writeFile(
      join(dir, 'memory', 'gotchas', 'pinguim-confirmado.md'),
      gotcha('01KZ0000000000000000000012', 'created: 2025-01-10\nupdated: 2025-01-10\nconfirmed: 2026-10-01'),
    );
    const brain = await openTest(dir);
    const out = await brain.search({ query: 'zebrapinguim', mode: 'keyword' });
    expect(out.hits.map((hit) => hit.path)).toEqual([
      'memory/gotchas/pinguim-confirmado.md',
      'memory/gotchas/pinguim-velho.md',
    ]);
    const [fresh, stale] = out.hits;
    expect((stale?.score ?? 0) / (fresh?.score ?? 1)).toBeCloseTo(STALE_SCORE_FACTOR, 2);
    // continua aparecendo, e vigente: rebaixar não é esconder
    expect(stale?.validity).toBe('current');
  });
});
