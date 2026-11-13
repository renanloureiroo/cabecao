// `cabecao eval --answers`: métricas simples e honestas das respostas do `ask`, sem juiz por LLM.
//
// Arquivo de perguntas (JSONL, uma por linha): {"query": "...", "expected": "caminho/da/nota.md" ou lista, "id": "..."}
// para perguntas que o cérebro responde, e {"query": "...", "answerable": false} para as que ele NÃO responde.
//
// Métricas:
// - citações válidas: das citações que o provedor deu, quantas conferiram (rótulo existente e citação literal no
//   trecho);
// - afirmações sem apoio: das afirmações devolvidas, quantas ficaram sem citação conferida;
// - fonte certa citada: das perguntas respondíveis que tiveram resposta, quantas citam ao menos uma nota esperada;
// - recusa correta: das perguntas sem resposta no cérebro, quantas voltaram `not_found`;
// - recusa indevida: das respondíveis, quantas voltaram `not_found`;
// - tempo e tokens.

import type { AskOptions, AskStatus } from './ask.ts';
import { ask } from './ask.ts';
import type { AskBrain } from './passages.ts';

export interface AnswerQuestion {
  readonly id: string;
  readonly question: string;
  readonly expected: readonly string[];
  readonly answerable: boolean;
}

export class AnswerQuestionsError extends Error {
  readonly code = 'EEVAL_QUESTIONS';
  constructor(message: string) {
    super(message);
    this.name = 'AnswerQuestionsError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseAnswerQuestions(text: string, source: string): AnswerQuestion[] {
  const out: AnswerQuestion[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new AnswerQuestionsError(`${source}, linha ${index + 1}: não é JSON`);
    }
    if (!isRecord(value)) throw new AnswerQuestionsError(`${source}, linha ${index + 1}: deveria ser um objeto`);
    const question = typeof value.query === 'string' ? value.query : value.question;
    if (typeof question !== 'string' || question.trim() === '') {
      throw new AnswerQuestionsError(`${source}, linha ${index + 1}: falta "query" (a pergunta)`);
    }
    const answerable = value.answerable !== false;
    const raw = value.expected;
    const expected =
      typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((e) => typeof e === 'string') : [];
    if (answerable && expected.length === 0) {
      throw new AnswerQuestionsError(
        `${source}, linha ${index + 1}: diga a nota que responde em "expected", ou marque "answerable": false`,
      );
    }
    out.push({
      id: typeof value.id === 'string' ? value.id : `q${out.length + 1}`,
      question: question.trim(),
      expected: expected as string[],
      answerable,
    });
  });
  if (out.length === 0) throw new AnswerQuestionsError(`${source}: nenhuma pergunta`);
  return out;
}

export interface AnswerQuestionResult {
  readonly id: string;
  readonly answerable: boolean;
  readonly status: AskStatus;
  readonly claims: number;
  readonly unsupported: number;
  readonly valid_citations: number;
  readonly removed_citations: number;
  /** Cita ao menos uma nota esperada (`null` em pergunta sem resposta no cérebro). */
  readonly right_source: boolean | null;
  readonly duration_ms: number;
}

/** Uma fração (0 a 1) com o numerador e o denominador, para ninguém ler 100% de 1 caso como 100% de 50. */
export interface Ratio {
  readonly value: number | null;
  readonly hits: number;
  readonly total: number;
}

export interface AnswerEvalReport {
  readonly questions: number;
  readonly answerable: number;
  readonly unanswerable: number;
  readonly unavailable: number;
  readonly citation_validity: Ratio;
  readonly unsupported_claims: Ratio;
  readonly right_source: Ratio;
  readonly correct_refusal: Ratio;
  readonly wrong_refusal: Ratio;
  readonly mean_duration_ms: number;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly results: readonly AnswerQuestionResult[];
}

const ratio = (hits: number, total: number): Ratio => ({
  value: total === 0 ? null : Math.round((hits / total) * 1000) / 1000,
  hits,
  total,
});

const sameNote = (expected: string, citation: { id: string; path: string }): boolean => {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC').toLowerCase();
  return norm(expected) === norm(citation.path) || expected === citation.id;
};

export async function evaluateAnswers(
  brain: AskBrain,
  questions: readonly AnswerQuestion[],
  options: AskOptions,
): Promise<AnswerEvalReport> {
  const results: AnswerQuestionResult[] = [];
  let input = 0;
  let output = 0;
  for (const q of questions) {
    const { output: out, diagnostics } = await ask(brain, { question: q.question }, options);
    input += diagnostics.usage.input_tokens ?? 0;
    output += diagnostics.usage.output_tokens ?? 0;
    const answered = out.status === 'answered' || out.status === 'low_confidence';
    results.push({
      id: q.id,
      answerable: q.answerable,
      status: out.status,
      claims: out.claims.length + (answered ? 0 : out.unsupported_claims),
      unsupported: out.unsupported_claims,
      valid_citations: out.claims.reduce((sum, claim) => sum + claim.citations.length, 0),
      removed_citations: out.removed_citations,
      right_source: q.answerable ? answered && out.citations.some((c) => q.expected.some((e) => sameNote(e, c))) : null,
      duration_ms: diagnostics.duration_ms,
    });
  }
  const generated = results.filter((r) => r.status !== 'unavailable');
  const answerable = generated.filter((r) => r.answerable);
  const unanswerable = generated.filter((r) => !r.answerable);
  const citationsGiven = generated.reduce((s, r) => s + r.valid_citations + r.removed_citations, 0);
  const claims = generated.reduce((s, r) => s + r.claims, 0);
  return {
    questions: results.length,
    answerable: results.filter((r) => r.answerable).length,
    unanswerable: results.filter((r) => !r.answerable).length,
    unavailable: results.length - generated.length,
    citation_validity: ratio(
      generated.reduce((s, r) => s + r.valid_citations, 0),
      citationsGiven,
    ),
    unsupported_claims: ratio(
      generated.reduce((s, r) => s + r.unsupported, 0),
      claims,
    ),
    right_source: ratio(answerable.filter((r) => r.right_source === true).length, answerable.length),
    correct_refusal: ratio(unanswerable.filter((r) => r.status === 'not_found').length, unanswerable.length),
    wrong_refusal: ratio(answerable.filter((r) => r.status === 'not_found').length, answerable.length),
    mean_duration_ms:
      results.length === 0 ? 0 : Math.round(results.reduce((s, r) => s + r.duration_ms, 0) / results.length),
    tokens: { input, output },
    results,
  };
}
