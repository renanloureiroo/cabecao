// Dois processos de verdade varrendo o mesmo cérebro, com o banco ainda inexistente: nenhum corrompe nem duplica.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalIndex } from '../../src/db/index.ts';
import { indexStatus, openIndex, reindexFull } from '../../src/db/index.ts';
import { readBrainConfig } from '../../src/vault/index.ts';
import { waitChild } from '../util/helpers.ts';
import type { TempVault } from '../vault/helpers.ts';
import { makeTempDir } from '../vault/helpers.ts';
import { generateVault, spawnDbChild } from './helpers.ts';

const NOTES = 400;
let temp: TempVault;

beforeAll(async () => {
  temp = await makeTempDir('db-two-procs');
  await generateVault(temp.root, NOTES);
}, 60_000);
afterAll(async () => {
  await temp?.cleanup();
});

interface ChildSummary {
  added: number;
  unchanged: number;
  total: number;
  errors: number;
  rebuilt: string | null;
}

describe('dois processos', () => {
  it('varrem o mesmo cérebro ao mesmo tempo sem corromper nem duplicar', async () => {
    const children = [spawnDbChild('scan-child.mjs', [temp.root]), spawnDbChild('scan-child.mjs', [temp.root])];
    const results = await Promise.all(children.map(waitChild));
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      // o aviso experimental do SQLite não chega ao stderr (o da remoção de tipos, no Node 22.16/22.17, pode chegar)
      expect(result.stderr).not.toMatch(/SQLite/i);
    }
    const summaries = results.map((result) => JSON.parse(result.stdout.trim()) as ChildSummary);
    // um fez o trabalho; o outro, esperando a trava, achou tudo pronto
    expect(summaries.map((s) => s.added).sort((a, b) => a - b)).toEqual([0, NOTES]);
    expect(summaries.map((s) => s.total)).toEqual([NOTES, NOTES]);
    expect(summaries.every((s) => s.errors === 0)).toBe(true);
    // só um dos dois criou o esquema
    expect(summaries.filter((s) => s.rebuilt === 'created')).toHaveLength(1);

    const index: LocalIndex = await openIndex(temp.root);
    try {
      const db = index.db;
      expect(db.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' });
      // o comando de integridade do FTS5 lança se o índice de texto não bater com a tabela `chunks`
      expect(() => db.exec(`insert into chunks_fts(chunks_fts) values ('integrity-check')`)).not.toThrow();
      expect(
        db
          .prepare(
            'select count(*) as n from (select note_id, ord from chunks group by note_id, ord having count(*) > 1)',
          )
          .get(),
      ).toEqual({ n: 0 });
      const before = indexStatus(index);
      expect(before.notes).toBe(NOTES);
      // o resultado é o mesmo de uma reconstrução do zero
      await reindexFull(index, temp.root, await readBrainConfig(temp.root));
      const after = indexStatus(index);
      expect({ ...after, lastScanAt: null, lastScanMs: null }).toEqual({
        ...before,
        lastScanAt: null,
        lastScanMs: null,
      });
    } finally {
      index.close();
    }
  }, 120_000);
});
