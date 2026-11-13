import { describe, expect, it } from 'vitest';
import type { EvalHit, EvalQuestion, FusionInput } from '../../src/vector/index.ts';
import {
  compareConfigs,
  DEFAULT_EVAL_K,
  evaluateRankings,
  fusionEvalConfigs,
  normalizeEvalRef,
  pairedDifference,
  scoreQuestion,
} from '../../src/vector/index.ts';

const hits = (...ids: string[]): EvalHit[] => ids.map((id) => ({ id }));
const q = (id: string, expected: string[], kind?: string): EvalQuestion => ({
  id,
  query: `pergunta ${id}`,
  expected,
  ...(kind === undefined ? {} : { kind }),
});

// Valores à mão (relevância binária, DCG = Σ 1/log2(posição + 1)):
// q1: gabarito [a], lista [x, a, y]    → 1ª relevante na 2ª: MRR 1/2; nDCG (1/log2 3) / 1 = 0,630930; recall 1; @1 0
// q2: gabarito [a, b], lista [a, x, b] → MRR 1; DCG 1 + 1/log2 4 = 1,5; ideal 1 + 1/log2 3 = 1,630930;
//                                        nDCG 0,919721; recall 1; @1 1
// q3: gabarito [c], lista [x, y]       → tudo 0
// médias: MRR 0,5; nDCG 0,516884; recall 0,666667; @1 0,333333
const Q = [q('q1', ['a'], 'paraphrase'), q('q2', ['a', 'b'], 'exact'), q('q3', ['c'], 'paraphrase')];
const R = [hits('x', 'a', 'y'), hits('a', 'x', 'b'), hits('x', 'y')];

describe('métricas por pergunta', () => {
  it('MRR, nDCG, recall e acerto@1 batem com a conta à mão', () => {
    expect(scoreQuestion(Q[0] as EvalQuestion, R[0] as EvalHit[])).toEqual({
      id: 'q1',
      query: 'pergunta q1',
      kind: 'paraphrase',
      firstRelevantRank: 2,
      mrr: 0.5,
      ndcg: 0.63093,
      recall: 1,
      hitAt1: 0,
      found: 1,
      expected: 1,
      top: ['x', 'a', 'y'],
    });
    expect(scoreQuestion(Q[1] as EvalQuestion, R[1] as EvalHit[])).toMatchObject({
      firstRelevantRank: 1,
      mrr: 1,
      ndcg: 0.919721,
      recall: 1,
      hitAt1: 1,
      found: 2,
    });
    expect(scoreQuestion(Q[2] as EvalQuestion, R[2] as EvalHit[])).toMatchObject({
      firstRelevantRank: null,
      mrr: 0,
      ndcg: 0,
      recall: 0,
      hitAt1: 0,
      found: 0,
    });
  });

  it('o corte k vale para todas as métricas', () => {
    // k = 2 em q2: só "a" entra; recall 1/2; DCG 1; ideal (2 esperadas, k = 2) 1,630930 → nDCG 0,613147
    expect(scoreQuestion(Q[1] as EvalQuestion, R[1] as EvalHit[], 2)).toMatchObject({
      mrr: 1,
      recall: 0.5,
      ndcg: 0.613147,
      top: ['a', 'x'],
    });
    // k = 1 em q1: a relevante está na 2ª posição, fora do corte
    expect(scoreQuestion(Q[0] as EvalQuestion, R[0] as EvalHit[], 1)).toMatchObject({
      mrr: 0,
      firstRelevantRank: null,
    });
    // o ideal do nDCG é limitado a k: 3 esperadas, k = 2, as duas primeiras certas → nDCG 1
    expect(scoreQuestion(q('t', ['a', 'b', 'c']), hits('a', 'b'), 2).ndcg).toBe(1);
    expect(DEFAULT_EVAL_K).toBe(10);
  });

  it('casa o gabarito pelo id ou pelo caminho (com ou sem .md, barras do Windows, NFD, ./ no início)', () => {
    const note: EvalHit = { id: '01JC3M7Q8Z5X2V9K4T6N1B0RWE', path: 'projects/atlas/decisão.md' };
    for (const ref of [
      '01JC3M7Q8Z5X2V9K4T6N1B0RWE',
      'projects/atlas/decisão.md',
      'projects/atlas/decisão',
      './projects/atlas/decisão.md',
      'projects\\atlas\\decisão.md',
      'projects/atlas/decisão.md'.normalize('NFD'),
    ]) {
      expect(scoreQuestion(q('p', [ref]), [{ id: 'outra' }, note]).firstRelevantRank).toBe(2);
    }
    expect(normalizeEvalRef('  ./a\\b.md ')).toBe('a/b.md');
  });

  it('nota repetida na lista conta uma vez só e não ocupa posição', () => {
    const result = scoreQuestion(q('d', ['a', 'b']), hits('a', 'a', 'a', 'b'));
    expect(result).toMatchObject({ found: 2, recall: 1, top: ['a', 'b'], ndcg: 1 });
  });

  it('pergunta sem gabarito e k inválido são erro', () => {
    expect(() => scoreQuestion(q('vazia', []), hits('a'))).toThrow(/sem gabarito/);
    expect(() => scoreQuestion(Q[0] as EvalQuestion, [], 0)).toThrow(/k inválido/);
  });
});

describe('relatório por configuração', () => {
  it('médias gerais e por kind, calculadas à mão', () => {
    const report = evaluateRankings('teste', Q, R);
    expect(report.name).toBe('teste');
    expect(report.k).toBe(10);
    expect(report.overall).toEqual({ questions: 3, mrr: 0.5, ndcg: 0.516884, recall: 0.666667, hitAt1: 0.333333 });
    expect(report.byKind).toEqual({
      exact: { questions: 1, mrr: 1, ndcg: 0.919721, recall: 1, hitAt1: 1 },
      paraphrase: { questions: 2, mrr: 0.25, ndcg: 0.315465, recall: 0.5, hitAt1: 0 },
    });
    expect(report.questions.map((r) => r.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('perguntas sem kind ficam no grupo ""', () => {
    expect(Object.keys(evaluateRankings('x', [q('a', ['a'])], [hits('a')]).byKind)).toEqual(['']);
  });

  it('número de listas diferente do de perguntas é erro', () => {
    expect(() => evaluateRankings('x', Q, R.slice(0, 2))).toThrow(/2 listas para 3 perguntas/);
  });

  it('a saída é serializável: JSON ida e volta dá o mesmo objeto', () => {
    const report = evaluateRankings('teste', Q, R);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('diferença pareada com bootstrap', () => {
  const base = evaluateRankings('base', Q, R);

  it('configuração idêntica: diferença 0, intervalo [0, 0], inconclusivo', () => {
    expect(pairedDifference(evaluateRankings('igual', Q, R), base)).toEqual({
      config: 'igual',
      baseline: 'base',
      metric: 'mrr',
      diff: 0,
      low: 0,
      high: 0,
      verdict: 'inconclusive',
    });
  });

  it('melhor em todas as perguntas: intervalo acima de zero', () => {
    // base fraca: a relevante sempre em 2º (MRR 0,5 em cada pergunta); a outra acerta tudo em 1º
    const weak = evaluateRankings('fraca', Q, [hits('x', 'a'), hits('x', 'a', 'b'), hits('x', 'c')]);
    const perfect = evaluateRankings('perfeita', Q, [hits('a'), hits('a', 'b'), hits('c')]);
    const diff = pairedDifference(perfect, weak, 'mrr');
    expect(diff).toMatchObject({ diff: 0.5, low: 0.5, high: 0.5, verdict: 'better' });
    expect(pairedDifference(weak, perfect, 'hitAt1').verdict).toBe('worse');
    // melhor em média mas igual numa das 3 perguntas: com tão poucas, o intervalo encosta em 0
    expect(pairedDifference(perfect, base, 'mrr')).toMatchObject({ diff: 0.5, verdict: 'inconclusive' });
    // semente fixa: o mesmo par dá o mesmo intervalo
    expect(pairedDifference(perfect, base, 'mrr')).toEqual(pairedDifference(perfect, base, 'mrr'));
  });

  it('relatórios com perguntas diferentes são erro', () => {
    expect(() => pairedDifference(base, evaluateRankings('x', [q('a', ['a'])], [hits('a')]))).toThrow(/diferentes/);
  });
});

describe('comparação entre configurações', () => {
  it('compareConfigs mede cada configuração e compara com a primeira', async () => {
    const report = await compareConfigs(Q, [
      { name: 'base', rank: (question) => R[Q.indexOf(question)] ?? [] },
      { name: 'perfeita', rank: async (question) => hits(...question.expected) },
    ]);
    expect(report.k).toBe(10);
    expect(report.questions).toBe(3);
    expect(report.configs.map((c) => [c.name, c.overall.mrr])).toEqual([
      ['base', 0.5],
      ['perfeita', 1],
    ]);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]).toMatchObject({ config: 'perfeita', baseline: 'base', metric: 'mrr', diff: 0.5 });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('nomes repetidos ou lista vazia são erro', async () => {
    const config = { name: 'a', rank: () => [] };
    await expect(compareConfigs(Q, [])).rejects.toThrow(/nenhuma configuração/);
    await expect(compareConfigs(Q, [config, config])).rejects.toThrow(/repetida/);
  });

  it('fusionEvalConfigs: só palavra-chave, só vetor e fusões, com os candidatos buscados uma vez por pergunta', async () => {
    // Uma paráfrase (só o vetor acha a nota certa) e uma busca por ID (o vetor erra; a palavra-chave acerta com
    // cobertura cheia). Só a fusão acerta as duas.
    const questions = [q('para', ['notes/certa.md'], 'paraphrase'), q('id', ['ERR-42'], 'exact')];
    const candidates: Record<string, FusionInput> = {
      para: {
        vector: [
          { chunkId: '1', noteId: 'certa', cosine: 0.82 },
          { chunkId: '2', noteId: 'parecida', cosine: 0.75 },
          { chunkId: '3', noteId: 'solta', cosine: 0.6 },
        ],
        keyword: [{ chunkId: '3', noteId: 'solta', bm25: 1 }],
        idfSum: 5,
      },
      id: {
        vector: [
          { chunkId: '4', noteId: 'vizinha', cosine: 0.7 },
          { chunkId: '5', noteId: 'ERR-42', cosine: 0.66 },
          { chunkId: '6', noteId: 'outra', cosine: 0.5 },
        ],
        keyword: [{ chunkId: '5', noteId: 'ERR-42', bm25: 9 }],
        idfSum: 8,
      },
    };
    const calls: string[] = [];
    const configs = fusionEvalConfigs({
      candidates: async (question) => {
        calls.push(question.id);
        return candidates[question.id] as FusionInput;
      },
      resolve: (noteId) => (noteId === 'ERR-42' ? { id: noteId } : { id: `id-${noteId}`, path: `notes/${noteId}.md` }),
    });
    expect(configs.map((c) => c.name)).toEqual(['keyword', 'vector', 'fusion α=0.3', 'fusion α=0.5', 'fusion α=0.7']);
    const report = await compareConfigs(questions, configs);
    expect(calls.sort()).toEqual(['id', 'para']);
    const hit1 = Object.fromEntries(report.configs.map((c) => [c.name, c.overall.hitAt1]));
    expect(hit1).toEqual({ keyword: 0.5, vector: 0.5, 'fusion α=0.3': 1, 'fusion α=0.5': 1, 'fusion α=0.7': 1 });
    const keyword = report.configs[0];
    expect(keyword?.byKind.paraphrase?.recall).toBe(0); // a palavra-chave não acha a paráfrase
    expect(keyword?.byKind.exact?.hitAt1).toBe(1);
  });
});
