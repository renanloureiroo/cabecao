// Apoio do banco à busca híbrida: trechos da palavra-chave com o BM25 cru e o Σidf, a tradução chave de trecho →
// trechos com os filtros, e o que o serviço de embeddings calcula.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allChunkKeys,
  buildFtsQuery,
  chunkDetails,
  chunkKeysMatching,
  chunksForKeys,
  embeddingInputs,
  keywordCandidates,
  queryTerms,
  scan,
  searchKeyword,
  termIdfs,
} from '../../src/db/index.ts';
import { connection } from '../../src/db/open.ts';
import { fuse } from '../../src/vector/index.ts';
import type { OpenVault } from './helpers.ts';
import { openFixture } from './helpers.ts';

let vault: OpenVault;
beforeAll(async () => {
  vault = await openFixture('semantic');
  await scan(vault.index, vault.root, vault.config);
});
afterAll(async () => {
  await vault.cleanup();
});

const db = () => connection(vault.index);

describe('keywordCandidates', () => {
  it('devolve trechos (vários da mesma nota), do melhor para o pior, com o BM25 cru positivo', () => {
    const found = keywordCandidates(vault.index, { query: 'filas' });
    expect(found.mode).toBe('and');
    expect(found.terms).toEqual(['filas']);
    expect(found.candidates.length).toBeGreaterThan(3);
    expect(found.candidates.length).toBeLessThanOrEqual(30);
    const notes = found.candidates.map((c) => c.noteId);
    expect(new Set(notes).size).toBeLessThan(notes.length); // a mesma nota aparece em mais de um trecho
    for (let i = 1; i < found.candidates.length; i++) {
      expect(found.candidates[i - 1]?.bm25).toBeGreaterThanOrEqual(found.candidates[i]?.bm25 ?? 0);
    }
    expect(found.candidates.every((c) => c.bm25 > 0 && /^[0-9a-f]{32}$/.test(c.chunkKey))).toBe(true);
    expect(found.candidates.some((c) => /«filas»/i.test(c.snippet))).toBe(true);
  });

  it('BM25 cru é o mesmo da busca por palavra-chave (sem o rebaixamento de vencido)', () => {
    const found = keywordCandidates(vault.index, { query: 'RabbitMQ' });
    const expired = searchKeyword(vault.index, { query: 'RabbitMQ', now: new Date(2026, 10, 12) }).hits.find(
      (hit) => hit.validity === 'expired',
    );
    expect(expired).toBeDefined();
    const best = found.candidates.find((c) => c.noteId === expired?.noteId);
    expect(best?.bm25).toBeCloseTo((expired?.score ?? 0) * 2, 3);
  });

  it('Σidf segue a fórmula do FTS5 sobre a tabela inteira (piso 1e-6)', () => {
    const terms = queryTerms('filas zebralunar');
    const total = Number(db().prepare('select count(*) as n from chunks').get()?.n);
    const count = (term: (typeof terms)[number]) =>
      Number(
        db()
          .prepare('select count(*) as n from chunks_fts where chunks_fts match ?')
          .get(buildFtsQuery([term], 'AND'))?.n,
      );
    const expected = terms.map((term) => Math.max(1e-6, Math.log((total - count(term) + 0.5) / (count(term) + 0.5))));
    expect(termIdfs(vault.index, terms)).toEqual(expected);
    const found = keywordCandidates(vault.index, { query: 'filas zebralunar' });
    expect(found.idfSum).toBeCloseTo(
      expected.reduce((a, b) => a + b, 0),
      10,
    );
    // filtros não mudam o Σidf (as contagens são da tabela inteira)
    expect(keywordCandidates(vault.index, { query: 'filas zebralunar', types: ['fact'] }).idfSum).toBe(found.idfSum);
    // um termo presente em quase todo trecho tem idf negativo na fórmula: vale o piso
    expect(Math.min(...termIdfs(vault.index, queryTerms('filas')))).toBeGreaterThan(0);
  });

  it('recua de AND para OR como searchKeyword, e pergunta vazia não consulta nada', () => {
    const both = keywordCandidates(vault.index, { query: 'SQS zebralunar' });
    expect(both.mode).toBe('or');
    expect(both.candidates.length).toBeGreaterThan(0);
    expect(searchKeyword(vault.index, { query: 'SQS zebralunar' }).mode).toBe('or');
    expect(keywordCandidates(vault.index, { query: 'de que para' })).toEqual({
      mode: 'none',
      terms: [],
      candidates: [],
      idfSum: 0,
    });
  });

  it('aplica escopo, tipo, arquivadas e cópias de conflito', () => {
    const facts = keywordCandidates(vault.index, { query: 'Atlas', types: ['fact'] });
    const noteType = db().prepare('select type from notes where id = ?');
    expect(facts.candidates.length).toBeGreaterThan(0);
    expect(facts.candidates.every((c) => noteType.get(c.noteId)?.type === 'fact')).toBe(true);
    const global = keywordCandidates(vault.index, { query: 'português', scope: ['global'] });
    const scopeOf = db().prepare('select scope from notes where id = ?');
    expect(global.candidates.every((c) => scopeOf.get(c.noteId)?.scope === 'global')).toBe(true);
    const archivedId = String(db().prepare("select id from notes where path like 'memory/_archive/%'").get()?.id);
    expect(keywordCandidates(vault.index, { query: 'tabs' }).candidates.some((c) => c.noteId === archivedId)).toBe(
      false,
    );
    expect(
      keywordCandidates(vault.index, { query: 'tabs', includeArchived: true }).candidates.some(
        (c) => c.noteId === archivedId,
      ),
    ).toBe(true);
  });

  it('a profundidade limita os trechos, e o peso do título é configurável', () => {
    expect(keywordCandidates(vault.index, { query: 'Atlas', depth: 3 }).candidates).toHaveLength(3);
    const one = keywordCandidates(vault.index, { query: 'SQS', titleWeight: 1 });
    const two = keywordCandidates(vault.index, { query: 'SQS', titleWeight: 2 });
    expect(one.idfSum).toBe(two.idfSum);
    expect(Math.max(...two.candidates.map((c) => c.bm25))).toBeGreaterThan(
      Math.max(...one.candidates.map((c) => c.bm25)),
    );
    expect(() => keywordCandidates(vault.index, { query: 'SQS', titleWeight: -1 })).toThrow(RangeError);
  });

  it('serve de entrada direta para a fusão', () => {
    const found = keywordCandidates(vault.index, { query: 'filas SQS' });
    const fused = fuse({ keyword: found.candidates, idfSum: found.idfSum });
    expect(fused.mode).toBe('keyword');
    expect(fused.notes[0]?.noteId).toBe(searchKeyword(vault.index, { query: 'filas SQS' }).hits[0]?.noteId);
  });
});

describe('tradução chave de trecho → trechos', () => {
  it('chunkKeysMatching respeita os filtros', () => {
    const all = chunkKeysMatching(vault.index);
    const facts = chunkKeysMatching(vault.index, { types: ['fact'] });
    expect(facts.size).toBeGreaterThan(0);
    expect(facts.size).toBeLessThan(all.size);
    for (const key of facts) expect(all.has(key)).toBe(true);
    const archived = chunkKeysMatching(vault.index, { includeArchived: true });
    expect(archived.size).toBeGreaterThan(all.size);
  });

  it('chunksForKeys devolve todos os trechos de cada chave que passam nos filtros', () => {
    const rows = db().prepare('select id, note_id, chunk_key from chunks order by id limit 5').all();
    const keys = rows.map((row) => String(row.chunk_key));
    const refs = chunksForKeys(vault.index, [...keys, ...keys], { includeArchived: true });
    expect([...new Set(refs.map((ref) => ref.chunkKey))].sort()).toEqual([...new Set(keys)].sort());
    // por padrão, como a busca, sem as arquivadas
    const visible = chunkKeysMatching(vault.index);
    expect(chunksForKeys(vault.index, keys).every((ref) => visible.has(ref.chunkKey))).toBe(true);
    expect(chunksForKeys(vault.index, [])).toEqual([]);
    expect(chunksForKeys(vault.index, ['0'.repeat(32)])).toEqual([]);
    const typed = chunksForKeys(vault.index, keys, { types: ['nenhum-tipo'] });
    expect(typed).toEqual([]);
  });

  it('chunkDetails traz a seção e o texto pelo id', () => {
    const row = db().prepare("select id from chunks where heading_path != '[]' limit 1").get();
    const details = chunkDetails(vault.index, [String(row?.id), 'x', '999999']);
    expect(details.size).toBe(1);
    expect(details.get(String(row?.id))?.headingPath.length).toBeGreaterThan(0);
  });
});

describe('o que o serviço de embeddings calcula', () => {
  it('um texto por chave, sem cópias de conflito, em ordem de chave; allChunkKeys tem todas', () => {
    const inputs = embeddingInputs(vault.index);
    const keys = inputs.map((input) => input.key);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(inputs.every((input) => input.text.length > 0)).toBe(true);
    expect(inputs.some((input) => input.title.includes(' › '))).toBe(true);
    const all = allChunkKeys(vault.index);
    for (const key of keys) expect(all.has(key)).toBe(true);
  });
});
