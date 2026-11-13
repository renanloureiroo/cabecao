import { describe, expect, it } from 'vitest';
import type { FusionInput, KeywordCandidate, VectorCandidate } from '../../src/vector/index.ts';
import { aggregateByNote, DEFAULT_FUSION_ALPHA, DEFAULT_FUSION_DEPTH, fuse } from '../../src/vector/index.ts';

const kw = (chunkId: string, bm25: number, noteId = `n-${chunkId}`): KeywordCandidate => ({ chunkId, noteId, bm25 });
const vec = (chunkId: string, cosine: number, noteId = `n-${chunkId}`): VectorCandidate => ({
  chunkId,
  noteId,
  cosine,
});

/** RRF k=60 da prova de conceito (descartado): só a posição em cada lista importa. */
function rrf(input: FusionInput, k = 60): string[] {
  const score = new Map<string, number>();
  const lists = [
    [...(input.vector ?? [])].sort((a, b) => b.cosine - a.cosine).map((c) => c.chunkId),
    [...(input.keyword ?? [])].sort((a, b) => b.bm25 - a.bm25).map((c) => c.chunkId),
  ];
  for (const list of lists) {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

describe('fuse: a fórmula do doc 06', () => {
  it('score = α · minmax(cosseno) + (1 − α) · min(1, bm25 / Σidf), calculado à mão', () => {
    const result = fuse({
      vector: [vec('a', 0.9), vec('b', 0.7), vec('c', 0.5)],
      keyword: [kw('b', 6), kw('d', 3), kw('e', 20)],
      idfSum: 10,
    });
    expect(result.mode).toBe('hybrid');
    expect(result.alpha).toBe(DEFAULT_FUSION_ALPHA);
    const byId = new Map(result.chunks.map((c) => [c.chunkId, c]));
    // a: minmax 1, sem palavra-chave            → 0,5
    // b: minmax 0,5, cobertura 0,6              → 0,25 + 0,3 = 0,55
    // c: minmax 0 (o menor do vetor)            → 0
    // d: só palavra-chave, cobertura 0,3        → 0,15
    // e: só palavra-chave, cobertura min(1, 2)  → 0,5
    expect(byId.get('a')).toMatchObject({ vector: 1, cosine: 0.9, coverage: 0, bm25: null, factor: 1 });
    expect(byId.get('b')).toMatchObject({ cosine: 0.7, bm25: 6 });
    expect(byId.get('b')?.vector).toBeCloseTo(0.5, 12);
    expect(byId.get('b')?.coverage).toBeCloseTo(0.6, 12);
    expect(byId.get('e')?.coverage).toBe(1);
    const scores = Object.fromEntries(result.chunks.map((c) => [c.chunkId, c.score]));
    expect(scores.a).toBeCloseTo(0.5, 12);
    expect(scores.b).toBeCloseTo(0.55, 12);
    expect(scores.c).toBe(0);
    expect(scores.d).toBeCloseTo(0.15, 12);
    expect(scores.e).toBeCloseTo(0.5, 12);
    // a e e empatam em 0,5: desempata o BM25 cru (e tem 20; a não veio da palavra-chave)
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['b', 'e', 'a', 'd', 'c']);
  });

  it('α configurável: 1 é só vetor, 0 é só cobertura', () => {
    const input: FusionInput = { vector: [vec('a', 0.9), vec('b', 0.1)], keyword: [kw('b', 10)], idfSum: 10 };
    expect(fuse(input, { alpha: 1 }).chunks.map((c) => [c.chunkId, c.score])).toEqual([
      ['a', 1],
      ['b', 0],
    ]);
    expect(fuse(input, { alpha: 0 }).chunks.map((c) => [c.chunkId, c.score])).toEqual([
      ['b', 1],
      ['a', 0],
    ]);
    const third = fuse(input, { alpha: 0.3 }).chunks;
    expect(third.find((c) => c.chunkId === 'a')?.score).toBeCloseTo(0.3, 12);
    expect(third.find((c) => c.chunkId === 'b')?.score).toBeCloseTo(0.7, 12);
  });

  it('a cobertura não passa por min-max: uma palavra solta continua valendo pouco mesmo no topo da lista', () => {
    // o único candidato da palavra-chave cobre 20% da pergunta; com min-max ele valeria 1
    const result = fuse({ keyword: [kw('solta', 2)], idfSum: 10 });
    expect(result.chunks[0]?.coverage).toBeCloseTo(0.2, 12);
    expect(result.chunks[0]?.score).toBeCloseTo(0.1, 12);
  });

  it('BM25 negativo (não deveria vir do FTS5) dá cobertura 0, nunca negativa', () => {
    expect(fuse({ keyword: [kw('x', -1)], idfSum: 5 }).chunks[0]?.coverage).toBe(0);
  });
});

describe('fuse: o defeito que derrubou o RRF', () => {
  // Pergunta parafraseada: o trecho certo (alvo) não divide nenhuma palavra com ela, então só o vetor o acha, em
  // primeiro. O trecho "solta" divide UMA palavra comum com a pergunta: aparece em primeiro na palavra-chave (com
  // cobertura baixa, 0,2) e, por acaso, em quinto no vetor. Os outros candidatos completam as duas listas.
  const vector = [
    vec('alvo', 0.82),
    vec('v2', 0.8),
    vec('v3', 0.78),
    vec('v4', 0.76),
    vec('solta', 0.74),
    ...Array.from({ length: 25 }, (_, i) => vec(`v${i + 6}`, 0.72 - i * 0.01)),
  ];
  const keyword = [kw('solta', 2), kw('k2', 1.8), kw('k3', 1.5), kw('k4', 1.2)];
  const input: FusionInput = { vector, keyword, idfSum: 10 };

  it('RRF põe o trecho da palavra solta na frente da paráfrase certa', () => {
    const order = rrf(input);
    expect(order[0]).toBe('solta');
    expect(order.indexOf('alvo')).toBeGreaterThan(0);
  });

  it('a fusão convexa com cobertura mantém a paráfrase certa em primeiro', () => {
    const result = fuse(input);
    expect(result.chunks[0]?.chunkId).toBe('alvo');
    const solta = result.chunks.find((c) => c.chunkId === 'solta');
    expect(solta?.coverage).toBeCloseTo(0.2, 12);
    expect(solta?.score).toBeLessThan(result.chunks[0]?.score as number);
    expect(result.notes[0]?.noteId).toBe('n-alvo');
  });

  it('e não perde o termo exato: um ID com cobertura cheia sobe mesmo lá embaixo no vetor', () => {
    // pergunta por um identificador: o trecho com o ID cobre a pergunta toda, mas o vetor o põe em 20º
    const exact: FusionInput = {
      vector: Array.from({ length: 30 }, (_, i) => vec(i === 19 ? 'id' : `v${i}`, 0.7 - i * 0.005)),
      keyword: [kw('id', 12), kw('k2', 3)],
      idfSum: 11,
    };
    const result = fuse(exact);
    expect(result.chunks[0]?.chunkId).toBe('id');
    expect(result.chunks[0]?.coverage).toBe(1);
  });
});

describe('fuse: casos de borda', () => {
  it('só palavra-chave (embeddings desligados): ordem do BM25 cru, mesmo com cobertura saturada', () => {
    const result = fuse({ keyword: [kw('a', 12), kw('b', 30), kw('c', 4), kw('d', 15)], idfSum: 10 });
    expect(result.mode).toBe('keyword');
    // a, b e d saturam em cobertura 1; o BM25 cru desempata
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['b', 'd', 'a', 'c']);
    expect(result.chunks.map((c) => c.score)).toEqual([0.5, 0.5, 0.5, 0.2]);
    for (const c of result.chunks) expect(c).toMatchObject({ vector: 0, cosine: null });
  });

  it('só vetor: ordem do cosseno, sem exigir Σidf', () => {
    const result = fuse({ vector: [vec('a', 0.2), vec('b', 0.6), vec('c', 0.4)] });
    expect(result.mode).toBe('vector');
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['b', 'c', 'a']);
    expect(result.chunks.map((c) => c.vector)).toEqual([1, expect.closeTo(0.5, 12), 0]);
    expect(result.chunks.every((c) => c.coverage === 0 && c.bm25 === null)).toBe(true);
  });

  it('trecho ainda sem vetor concorre só pela cobertura, ao lado dos que têm vetor', () => {
    const result = fuse({
      vector: [vec('a', 0.9), vec('b', 0.5)],
      keyword: [kw('sem-vetor', 10), kw('b', 10)],
      idfSum: 10,
    });
    const byId = new Map(result.chunks.map((c) => [c.chunkId, c]));
    expect(byId.get('sem-vetor')).toMatchObject({ vector: 0, cosine: null, coverage: 1, score: 0.5 });
    expect(byId.get('b')?.score).toBeCloseTo(0.5, 12);
  });

  it('listas vazias ou ausentes: resultado vazio, modo empty', () => {
    for (const input of [{}, { keyword: [], vector: [] }, { keyword: [], idfSum: 0 }]) {
      const result = fuse(input);
      expect(result).toEqual({ mode: 'empty', alpha: 0.5, chunks: [], notes: [] });
    }
  });

  it('min-max degenerado (um candidato só, ou todos com o mesmo cosseno): todos recebem 1', () => {
    expect(fuse({ vector: [vec('a', 0.31)] }).chunks[0]).toMatchObject({ vector: 1, score: 0.5 });
    const tied = fuse({ vector: [vec('b', 0.4), vec('a', 0.4), vec('c', 0.4)] });
    expect(tied.chunks.map((c) => [c.chunkId, c.vector])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
  });

  it('empates determinísticos: a ordem de entrada não muda a saída', () => {
    const input: FusionInput = {
      vector: [vec('x', 0.5), vec('y', 0.5), vec('z', 0.9), vec('w', 0.1)],
      keyword: [kw('x', 2), kw('q', 2), kw('r', 2)],
      idfSum: 4,
    };
    const reversed: FusionInput = {
      vector: [...(input.vector ?? [])].reverse(),
      keyword: [...(input.keyword ?? [])].reverse(),
      idfSum: 4,
    };
    expect(fuse(reversed)).toEqual(fuse(input));
    // q e r empatam em tudo: desempata o chunkId
    const ids = fuse(input).chunks.map((c) => c.chunkId);
    expect(ids.indexOf('q')).toBeLessThan(ids.indexOf('r'));
  });

  it('profundidade: só os 30 melhores de cada lista entram, e o min-max usa o 30º como mínimo', () => {
    expect(DEFAULT_FUSION_DEPTH).toBe(30);
    const vector = Array.from({ length: 40 }, (_, i) => vec(`v${String(i).padStart(2, '0')}`, 1 - i * 0.01));
    const keyword = Array.from({ length: 40 }, (_, i) => kw(`k${String(i).padStart(2, '0')}`, 40 - i));
    const result = fuse({ vector, keyword, idfSum: 100 });
    expect(result.chunks).toHaveLength(60);
    expect(result.chunks.some((c) => c.chunkId === 'v30' || c.chunkId === 'k30')).toBe(false);
    expect(result.chunks.find((c) => c.chunkId === 'v29')?.vector).toBe(0);
    expect(fuse({ vector, keyword, idfSum: 100 }, { depth: 5 }).chunks).toHaveLength(10);
  });

  it('trecho repetido numa lista: fica a melhor ocorrência', () => {
    const result = fuse({ keyword: [kw('a', 1), kw('a', 3)], vector: [vec('a', 0.2), vec('a', 0.6)], idfSum: 6 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({ bm25: 3, cosine: 0.6, coverage: 0.5 });
  });

  it('recusa α fora de [0, 1], profundidade inválida, valores não finitos, Σidf inválido e trecho em duas notas', () => {
    const ok: FusionInput = { keyword: [kw('a', 1)], idfSum: 2 };
    expect(() => fuse(ok, { alpha: 1.5 })).toThrow(/α inválido/);
    expect(() => fuse(ok, { alpha: -0.1 })).toThrow(/α inválido/);
    expect(() => fuse(ok, { alpha: Number.NaN })).toThrow(/α inválido/);
    expect(() => fuse(ok, { depth: 0 })).toThrow(/profundidade/);
    expect(() => fuse({ keyword: [kw('a', 1)] })).toThrow(/Σidf/);
    expect(() => fuse({ keyword: [kw('a', 1)], idfSum: 0 })).toThrow(/Σidf/);
    expect(() => fuse({ keyword: [kw('a', 1)], idfSum: Number.POSITIVE_INFINITY })).toThrow(/Σidf/);
    expect(() => fuse({ keyword: [kw('a', Number.NaN)], idfSum: 1 })).toThrow(/BM25 não finito/);
    expect(() => fuse({ vector: [vec('a', Number.NaN)] })).toThrow(/cosseno não finito/);
    expect(() => fuse({ vector: [vec('a', 0.5, 'n1')], keyword: [kw('a', 1, 'n2')], idfSum: 1 })).toThrow(
      /duas notas|notas n1 e n2/,
    );
    expect(() => fuse({ vector: [vec('a', 0.5, 'n1'), vec('a', 0.4, 'n2')] })).toThrow(/notas n1 e n2/);
  });
});

describe('agregação por nota e fator por nota', () => {
  it('um resultado por nota, com o melhor trecho e a contagem de trechos', () => {
    const result = fuse({
      vector: [vec('a1', 0.9, 'A'), vec('a2', 0.6, 'A'), vec('b1', 0.8, 'B'), vec('c1', 0.5, 'C')],
      keyword: [kw('a2', 10, 'A'), kw('d1', 2, 'D')],
      idfSum: 10,
    });
    expect(result.notes.map((n) => [n.noteId, n.chunkId, n.matchedChunks])).toEqual([
      ['A', 'a2', 2], // a2: 0,5·0,25 + 0,5·1 = 0,625 > a1: 0,5
      ['B', 'b1', 1],
      ['D', 'd1', 1],
      ['C', 'c1', 1],
    ]);
    expect(aggregateByNote(result.chunks)).toEqual(result.notes);
  });

  it('noteFactor rebaixa uma nota (resultado vencido) antes de ordenar, e o fator aparece no resultado', () => {
    const input: FusionInput = { vector: [vec('old', 0.9, 'velha'), vec('new', 0.8, 'nova'), vec('z', 0.1, 'z')] };
    expect(fuse(input).notes[0]?.noteId).toBe('velha');
    const calls: string[] = [];
    const demoted = fuse(input, {
      noteFactor: (id) => {
        calls.push(id);
        return id === 'velha' ? 0.5 : 1;
      },
    });
    expect(demoted.notes.map((n) => n.noteId)).toEqual(['nova', 'velha', 'z']);
    expect(demoted.notes[1]).toMatchObject({ factor: 0.5, score: 0.25 });
    expect(calls.sort()).toEqual(['nova', 'velha', 'z']); // uma chamada por nota
    expect(() => fuse(input, { noteFactor: () => -1 })).toThrow(/fator inválido/);
  });
});
