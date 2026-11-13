// Duplicatas e contradições no `remember` (doc 07, "Duplicatas e contradições"): a decisão por regra, sem LLM.
// Funções puras: recebem o texto da memória nova e o de uma candidata (mesmo escopo e mesmo tipo) e dizem o que
// fazer. A busca das candidatas e a gravação ficam em `remember.ts`.
//
// A comparação é por conjuntos de termos (palavras em minúsculas, sem acento, sem palavras vazias). Dois cuidados
// seguram os falsos "duplicado":
// - negações (não, nunca, sem, not, never...) NÃO são palavras vazias aqui: "use X" e "não use X" não são iguais;
// - um número ou uma negação que aparece de um lado só ("lotes de 10" e "lotes de 20") impede "igual" e "complementa":
//   o caso vira ambíguo e volta para o agente decidir.

import { isStopword } from '../db/index.ts';

/**
 * Limiares da decisão. Medidos no cérebro de exemplo (`packages/core/test/brain/dedup-eval.test.ts`): nenhum par de
 * notas distintas do mesmo tipo e escopo vira "igual" nem "complementa", e toda nota gravada de novo com o mesmo
 * texto é reconhecida como igual.
 */
export const DEDUP_THRESHOLDS = {
  /** Termos distintos mínimos dos dois lados para comparar por semelhança; abaixo disso, só texto idêntico conta. */
  minTerms: 4,
  /** Jaccard dos termos a partir do qual é a mesma memória (ignora), se nenhum número ou negação mudou. */
  duplicate: 0.9,
  /** A nova tem TODOS os termos da antiga e pelo menos este múltiplo deles: complementa (atualiza a antiga). */
  complementGrowth: 1.25,
  /** Jaccard a partir do qual o caso é ambíguo (volta para o agente). */
  ambiguous: 0.5,
  /** Ou: fração dos termos da MENOR das duas que está na outra, a partir da qual o caso é ambíguo. */
  ambiguousContainment: 0.8,
  /** E, nos dois casos, pelo menos estes termos em comum (textos curtos com 2 ou 3 palavras iguais não contam). */
  minShared: 4,
  /** Cosseno da busca por significado a partir do qual uma candidata sem semelhança de palavras vira ambígua. */
  semanticAmbiguous: 0.9,
  /** Candidatas trazidas pela busca para comparar. */
  candidates: 5,
} as const;

/** O que fazer com a memória nova diante de uma candidata. */
export type DedupVerdict =
  /** Igual (texto idêntico ou quase, sem número nem negação diferente): nada é gravado. */
  | 'duplicate'
  /** A nova já está inteira na antiga: nada é gravado. */
  | 'subsumed'
  /** A nova tem tudo o que a antiga tem e mais: a antiga é atualizada com o texto novo. */
  | 'complement'
  /** Fato com o mesmo sujeito e predicado e outro objeto: a antiga é substituída. */
  | 'contradiction'
  /** Parecidas, mas a regra não decide: volta para o agente. */
  | 'ambiguous'
  /** Diferentes: a memória nova é criada. */
  | 'distinct';

/** Uma memória como a regra a enxerga. */
export interface MemoryText {
  readonly title: string;
  readonly body: string;
  /** Só em fatos. */
  readonly fact?: { readonly subject: string; readonly predicate: string; readonly object: string } | null | undefined;
}

export interface DedupComparison {
  readonly verdict: DedupVerdict;
  /** Jaccard dos termos (0 a 1). */
  readonly jaccard: number;
  /** Fração dos termos da antiga que estão na nova. */
  readonly oldInNew: number;
  /** Fração dos termos da nova que estão na antiga. */
  readonly newInOld: number;
  /** Cosseno da busca por significado, quando houve. */
  readonly cosine: number | null;
  /** Por que, em português. */
  readonly reason: string;
}

/** Negações: mudam o sentido e nunca são descartadas. */
const NEGATIONS = new Set([
  'nao',
  'nunca',
  'jamais',
  'nem',
  'sem',
  'not',
  'never',
  'no',
  'nor',
  'without',
  'dont',
  "don't",
  'don’t',
]);

const stripMarks = (text: string): string => text.normalize('NFD').replace(/\p{M}+/gu, '');
/** Palavra ou identificador composto (`proc-a`, `db_reset`, `v1.2`, `2026-05-03`), como na busca. */
const WORD_RE = /[\p{L}\p{N}]+(?:[-_.:/'’@][\p{L}\p{N}]+)*/gu;

/** Termos de um texto: palavras em minúsculas, sem acento, sem palavras vazias (menos as negações). */
export function memoryTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of stripMarks(text.normalize('NFC')).toLowerCase().matchAll(WORD_RE)) {
    const word = match[0];
    // negações e números contam sempre; uma letra solta também ("plano B"), menos as palavras vazias ("a", "e")
    if (NEGATIONS.has(word) || /\d/.test(word) || !isStopword(word)) out.add(word);
  }
  return out;
}

/** Texto para comparar igualdade: minúsculas, sem acento, sem marcação de Markdown, espaços colapsados. */
export function normalizedText(text: string): string {
  return stripMarks(text.normalize('NFC'))
    .toLowerCase()
    .replace(/[`*_#>[\](){}|~"'“”‘’.,;:!?-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isSensitive = (term: string): boolean => NEGATIONS.has(term) || /\d/.test(term);

/** Quantas vezes cada negação e cada número aparece (conjuntos perdem a contagem: "não ... não" vira um só). */
function sensitiveCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of stripMarks(text.normalize('NFC')).toLowerCase().matchAll(WORD_RE)) {
    if (isSensitive(match[0])) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const item of a) if (b.has(item)) n++;
  return n;
}

/** Chave de comparação de sujeito, predicado e objeto de um fato: sem `[[ ]]`, apelido, maiúsculas nem acentos. */
export function factKey(value: string): string {
  const text = value.trim();
  const link = /^\[\[([^[\]|#]*)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]$/.exec(text);
  const target = (link === null ? text : (link[1] ?? '')).trim();
  return normalizedText(target.slice(target.lastIndexOf('/') + 1));
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Compara a memória nova com uma candidata do mesmo escopo e tipo. */
export function compareMemories(
  incoming: MemoryText,
  existing: MemoryText,
  options: { readonly cosine?: number | null } = {},
): DedupComparison {
  const cosine = options.cosine ?? null;
  const T = DEDUP_THRESHOLDS;
  const newTerms = memoryTerms(`${incoming.title}\n${incoming.body}`);
  const oldTerms = memoryTerms(`${existing.title}\n${existing.body}`);
  const shared = intersection(newTerms, oldTerms);
  const union = newTerms.size + oldTerms.size - shared;
  const jaccard = union === 0 ? 1 : shared / union;
  const oldInNew = oldTerms.size === 0 ? 1 : shared / oldTerms.size;
  const newInOld = newTerms.size === 0 ? 1 : shared / newTerms.size;
  const base = { jaccard: round(jaccard), oldInNew: round(oldInNew), newInOld: round(newInOld), cosine };
  const verdict = (value: DedupVerdict, reason: string): DedupComparison => ({ ...base, verdict: value, reason });

  // fatos: o mesmo sujeito e predicado é a mesma afirmação; o objeto decide entre igual e contradição
  if (incoming.fact && existing.fact) {
    const same = (a: string, b: string): boolean => factKey(a) === factKey(b);
    if (same(incoming.fact.subject, existing.fact.subject) && same(incoming.fact.predicate, existing.fact.predicate)) {
      return same(incoming.fact.object, existing.fact.object)
        ? verdict('duplicate', 'fato com o mesmo sujeito, predicado e objeto')
        : verdict('contradiction', 'fato com o mesmo sujeito e predicado e outro objeto');
    }
    // outro sujeito ou predicado: nunca é a mesma afirmação, por mais parecido que seja o texto
    return verdict('distinct', 'fato com outro sujeito ou predicado');
  }

  const newBody = normalizedText(incoming.body);
  const oldBody = normalizedText(existing.body);
  const trivial = newTerms.size < T.minTerms || oldTerms.size < T.minTerms;
  if (newBody === oldBody && (!trivial || normalizedText(incoming.title) === normalizedText(existing.title))) {
    return verdict('duplicate', 'texto idêntico');
  }
  if (trivial) return verdict('distinct', 'texto curto demais para comparar por semelhança, e não é idêntico');
  const onlyNew = [...newTerms].filter((term) => !oldTerms.has(term));
  const onlyOld = [...oldTerms].filter((term) => !newTerms.has(term));
  const changedSensitive =
    [...onlyNew, ...onlyOld].some(isSensitive) ||
    !sameCounts(
      sensitiveCounts(`${incoming.title}\n${incoming.body}`),
      sensitiveCounts(`${existing.title}\n${existing.body}`),
    );
  if (jaccard >= T.duplicate && !changedSensitive) {
    return verdict('duplicate', `quase idêntica (Jaccard ${round(jaccard)})`);
  }
  if (onlyNew.length === 0 && !changedSensitive) {
    return verdict('subsumed', 'tudo o que a nova diz já está na antiga');
  }
  const negations = (counts: Map<string, number>): Map<string, number> =>
    new Map([...counts].filter(([term]) => NEGATIONS.has(term)));
  const sameNegations = sameCounts(
    negations(sensitiveCounts(`${incoming.title}\n${incoming.body}`)),
    negations(sensitiveCounts(`${existing.title}\n${existing.body}`)),
  );
  if (
    onlyOld.length === 0 &&
    newTerms.size >= oldTerms.size * T.complementGrowth &&
    sameNegations &&
    !onlyNew.some(isSensitive)
  ) {
    return verdict('complement', 'a nova tem tudo o que a antiga tem e acrescenta');
  }
  const similarity = Math.max(jaccard, oldInNew, newInOld);
  const smallerInLarger = newTerms.size <= oldTerms.size ? newInOld : oldInNew;
  if (shared >= T.minShared && (jaccard >= T.ambiguous || smallerInLarger >= T.ambiguousContainment)) {
    return verdict(
      'ambiguous',
      changedSensitive
        ? 'parecidas, com um número ou uma negação diferente (pode ser uma correção)'
        : `parecidas (semelhança ${round(similarity)})`,
    );
  }
  if (cosine !== null && cosine >= T.semanticAmbiguous) {
    return verdict('ambiguous', `parecidas no significado (cosseno ${round(cosine)})`);
  }
  return verdict('distinct', `diferentes (semelhança ${round(similarity)})`);
}

/** Ordem de força dos veredictos: o mais forte decide quando há várias candidatas. */
export const VERDICT_STRENGTH: Readonly<Record<DedupVerdict, number>> = {
  duplicate: 5,
  subsumed: 4,
  contradiction: 3,
  complement: 2,
  ambiguous: 1,
  distinct: 0,
};
