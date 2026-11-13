// Métricas do `cabecao eval` (doc 06, "Limites desta medição"), portadas de `metrics`, `subset` e `bootDiff` em
// `spikes/11-embeddings-eval/lib/search.mjs`. Relevância binária: cada nota esperada vale 1.
//
// - acerto@1: a primeira posição é uma nota esperada.
// - MRR@k: 1 / posição da primeira nota esperada nas k primeiras (0 se nenhuma).
// - nDCG@k: DCG = Σ 1 / log2(posição + 1) nas posições com nota esperada; dividido pelo DCG ideal, com todas as
//   esperadas (até k) no topo.
// - recall@k: fração das notas esperadas que aparecem nas k primeiras.
//
// A biblioteca não sabe buscar: quem chama passa, por configuração, uma função que devolve a lista ordenada de notas
// de uma pergunta. `fusionEvalConfigs` monta as configurações padrão (só palavra-chave, só vetor, fusão com vários
// α) a partir dos candidatos de cada pergunta, que são buscados uma vez só.

import { normalizeNfc, toPosixPath } from '../util/index.ts';
import type { FusionInput } from './fusion.ts';
import { fuse } from './fusion.ts';
import type { EvalQuestion } from './questions.ts';

/** Profundidade padrão das métricas (MRR@10, nDCG@10, recall@10), a mesma da medição. */
export const DEFAULT_EVAL_K = 10;
/** Reamostragens do intervalo de confiança por bootstrap. */
export const DEFAULT_BOOTSTRAP_SAMPLES = 2000;
const BOOTSTRAP_SEED = 12345;

/** Um resultado da busca: a nota, pelo id e (opcionalmente) pelo caminho. */
export interface EvalHit {
  readonly id: string;
  readonly path?: string;
}

export type EvalMetric = 'mrr' | 'ndcg' | 'recall' | 'hitAt1';
export const EVAL_METRICS: readonly EvalMetric[] = ['mrr', 'ndcg', 'recall', 'hitAt1'];

/** Média das métricas sobre um conjunto de perguntas. */
export interface MetricSummary {
  readonly questions: number;
  readonly mrr: number;
  readonly ndcg: number;
  readonly recall: number;
  readonly hitAt1: number;
}

export interface QuestionResult {
  readonly id: string;
  readonly query: string;
  readonly kind: string | null;
  /** Posição (a partir de 1) da primeira nota esperada nas k primeiras, ou `null`. */
  readonly firstRelevantRank: number | null;
  readonly mrr: number;
  readonly ndcg: number;
  readonly recall: number;
  readonly hitAt1: number;
  /** Notas esperadas encontradas nas k primeiras. */
  readonly found: number;
  readonly expected: number;
  /** Ids das k primeiras notas devolvidas, para depuração. */
  readonly top: readonly string[];
}

export interface ConfigReport {
  readonly name: string;
  readonly k: number;
  readonly overall: MetricSummary;
  /** Médias por `kind`; perguntas sem `kind` ficam em `""`. */
  readonly byKind: Readonly<Record<string, MetricSummary>>;
  readonly questions: readonly QuestionResult[];
}

/** Diferença pareada `config − baseline` numa métrica, com intervalo de 95% por bootstrap. */
export interface PairedDifference {
  readonly config: string;
  readonly baseline: string;
  readonly metric: EvalMetric;
  readonly diff: number;
  readonly low: number;
  readonly high: number;
  /** O intervalo inteiro está acima (`better`) ou abaixo (`worse`) de zero; senão, `inconclusive`. */
  readonly verdict: 'better' | 'worse' | 'inconclusive';
}

export interface EvalReport {
  readonly k: number;
  readonly questions: number;
  readonly configs: readonly ConfigReport[];
  /** Cada configuração contra a primeira (a base). */
  readonly differences: readonly PairedDifference[];
}

const stripMd = (path: string): string => (path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path);

/** Forma comparável de um id ou caminho: sem espaços nas pontas, barras normais, NFC e sem `./` no início. */
export function normalizeEvalRef(ref: string): string {
  return normalizeNfc(toPosixPath(ref.trim())).replace(/^(?:\.\/)+/, '');
}

/** Formas pelas quais uma nota pode ser citada no gabarito: id, caminho e caminho sem `.md`. */
function hitRefs(hit: EvalHit): string[] {
  const refs = [normalizeEvalRef(hit.id)];
  if (hit.path !== undefined) {
    const path = normalizeEvalRef(hit.path);
    refs.push(path, stripMd(path));
  }
  return refs;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function checkK(k: number): number {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError(`k inválido: ${k}`);
  return k;
}

/**
 * Métricas de uma pergunta. Cada nota devolvida satisfaz no máximo uma entrada do gabarito, e uma nota repetida na
 * lista só conta na primeira vez. Um gabarito vazio dá erro (a pergunta não mede nada).
 */
export function scoreQuestion(question: EvalQuestion, ranking: readonly EvalHit[], k = DEFAULT_EVAL_K): QuestionResult {
  checkK(k);
  const expected = question.expected.map(normalizeEvalRef);
  if (expected.length === 0) throw new RangeError(`pergunta ${question.id} sem gabarito`);
  const pending = new Set(expected.keys());
  const seen = new Set<string>();
  const top: string[] = [];
  let first: number | null = null;
  let dcg = 0;
  let found = 0;
  for (const hit of ranking) {
    if (top.length >= k) break;
    const id = normalizeEvalRef(hit.id);
    if (seen.has(id)) continue;
    seen.add(id);
    top.push(hit.id);
    const position = top.length;
    const refs = hitRefs(hit);
    const match = [...pending].find((i) => refs.includes(expected[i] as string));
    if (match === undefined) continue;
    pending.delete(match);
    found++;
    dcg += 1 / Math.log2(position + 1);
    first ??= position;
  }
  let ideal = 0;
  for (let p = 1; p <= Math.min(k, expected.length); p++) ideal += 1 / Math.log2(p + 1);
  return {
    id: question.id,
    query: question.query,
    kind: question.kind ?? null,
    firstRelevantRank: first,
    mrr: round(first === null ? 0 : 1 / first),
    ndcg: round(dcg / ideal),
    recall: round(found / expected.length),
    hitAt1: first === 1 ? 1 : 0,
    found,
    expected: expected.length,
    top,
  };
}

/** Média das métricas de várias perguntas (zeros para lista vazia). */
export function summarize(results: readonly QuestionResult[]): MetricSummary {
  const n = results.length;
  const mean = (metric: EvalMetric): number =>
    n === 0 ? 0 : round(results.reduce((sum, r) => sum + r[metric], 0) / n);
  return { questions: n, mrr: mean('mrr'), ndcg: mean('ndcg'), recall: mean('recall'), hitAt1: mean('hitAt1') };
}

/** Relatório de uma configuração: `rankings[i]` é a lista devolvida para `questions[i]`. */
export function evaluateRankings(
  name: string,
  questions: readonly EvalQuestion[],
  rankings: readonly (readonly EvalHit[])[],
  k = DEFAULT_EVAL_K,
): ConfigReport {
  checkK(k);
  if (rankings.length !== questions.length) {
    throw new RangeError(`${rankings.length} listas para ${questions.length} perguntas`);
  }
  const results = questions.map((question, i) => scoreQuestion(question, rankings[i] ?? [], k));
  const kinds = [...new Set(results.map((r) => r.kind ?? ''))].sort();
  const byKind: Record<string, MetricSummary> = {};
  for (const kind of kinds) byKind[kind] = summarize(results.filter((r) => (r.kind ?? '') === kind));
  return { name, k, overall: summarize(results), byKind, questions: results };
}

/**
 * Diferença pareada entre duas configurações medidas sobre as mesmas perguntas, com intervalo de 95% por bootstrap
 * (reamostrando perguntas). Semente fixa: o mesmo par de relatórios dá sempre o mesmo intervalo.
 */
export function pairedDifference(
  config: ConfigReport,
  baseline: ConfigReport,
  metric: EvalMetric = 'mrr',
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
): PairedDifference {
  const n = config.questions.length;
  if (n !== baseline.questions.length) throw new RangeError('relatórios com números de perguntas diferentes');
  if (!Number.isSafeInteger(samples) || samples < 1) throw new RangeError(`amostras inválidas: ${samples}`);
  const deltas = config.questions.map((q, i) => q[metric] - (baseline.questions[i] as QuestionResult)[metric]);
  const diff = n === 0 ? 0 : deltas.reduce((s, d) => s + d, 0) / n;
  let seed = BOOTSTRAP_SEED;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const means = new Float64Array(samples);
  for (let t = 0; t < samples; t++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += deltas[Math.floor(random() * n)] as number;
    means[t] = n === 0 ? 0 : sum / n;
  }
  means.sort();
  const low = means[Math.floor(samples * 0.025)] as number;
  const high = means[Math.min(samples - 1, Math.floor(samples * 0.975))] as number;
  return {
    config: config.name,
    baseline: baseline.name,
    metric,
    diff: round(diff),
    low: round(low),
    high: round(high),
    verdict: low > 0 ? 'better' : high < 0 ? 'worse' : 'inconclusive',
  };
}

/** Uma configuração de busca a comparar. */
export interface EvalConfig {
  readonly name: string;
  readonly rank: (question: EvalQuestion) => readonly EvalHit[] | Promise<readonly EvalHit[]>;
}

export interface CompareOptions {
  readonly k?: number;
  /** Métrica das diferenças pareadas. Padrão: MRR. */
  readonly metric?: EvalMetric;
  readonly samples?: number;
}

/** Roda todas as configurações sobre as perguntas e compara cada uma com a primeira. */
export async function compareConfigs(
  questions: readonly EvalQuestion[],
  configs: readonly EvalConfig[],
  options: CompareOptions = {},
): Promise<EvalReport> {
  const k = checkK(options.k ?? DEFAULT_EVAL_K);
  if (configs.length === 0) throw new RangeError('nenhuma configuração para comparar');
  const names = new Set<string>();
  for (const config of configs) {
    if (names.has(config.name)) throw new RangeError(`configuração repetida: ${config.name}`);
    names.add(config.name);
  }
  const reports: ConfigReport[] = [];
  for (const config of configs) {
    const rankings: (readonly EvalHit[])[] = [];
    for (const question of questions) rankings.push(await config.rank(question));
    reports.push(evaluateRankings(config.name, questions, rankings, k));
  }
  const [baseline, ...rest] = reports as [ConfigReport, ...ConfigReport[]];
  return {
    k,
    questions: questions.length,
    configs: reports,
    differences: rest.map((report) => pairedDifference(report, baseline, options.metric, options.samples)),
  };
}

/** α usados por padrão na comparação de fusões (o ótimo medido ficou entre 0,3 e 0,7 conforme o conjunto). */
export const DEFAULT_EVAL_ALPHAS: readonly number[] = [0.3, 0.5, 0.7];

export interface FusionEvalOptions {
  /** Candidatos (palavra-chave e vetor) de uma pergunta. Chamado uma vez por pergunta. */
  readonly candidates: (question: EvalQuestion) => FusionInput | Promise<FusionInput>;
  /** Id e caminho de uma nota, a partir do `noteId` dos candidatos. */
  readonly resolve: (noteId: string) => EvalHit;
  readonly alphas?: readonly number[];
  readonly depth?: number;
  readonly noteFactor?: (noteId: string) => number;
}

/**
 * Configurações padrão: `keyword` (só palavra-chave), `vector` (só vetor) e `fusion α=…` para cada α. Todas usam os
 * mesmos candidatos, buscados uma vez por pergunta.
 */
export function fusionEvalConfigs(options: FusionEvalOptions): EvalConfig[] {
  const cache = new Map<EvalQuestion, Promise<FusionInput>>();
  const inputOf = (question: EvalQuestion): Promise<FusionInput> => {
    let input = cache.get(question);
    if (input === undefined) {
      input = Promise.resolve(options.candidates(question));
      cache.set(question, input);
    }
    return input;
  };
  const extra = {
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.noteFactor === undefined ? {} : { noteFactor: options.noteFactor }),
  };
  const config = (name: string, pick: (input: FusionInput) => FusionInput, alpha?: number): EvalConfig => ({
    name,
    rank: async (question) =>
      fuse(pick(await inputOf(question)), alpha === undefined ? extra : { ...extra, alpha }).notes.map((note) =>
        options.resolve(note.noteId),
      ),
  });
  const keywordOnly = (input: FusionInput): FusionInput => ({
    ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
    ...(input.idfSum === undefined ? {} : { idfSum: input.idfSum }),
  });
  const vectorOnly = (input: FusionInput): FusionInput => (input.vector === undefined ? {} : { vector: input.vector });
  return [
    config('keyword', keywordOnly),
    config('vector', vectorOnly),
    ...(options.alphas ?? DEFAULT_EVAL_ALPHAS).map((alpha) => config(`fusion α=${alpha}`, (input) => input, alpha)),
  ];
}
