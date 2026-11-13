// "Você quis dizer...?" para comando, subcomando, opção e cliente digitados com erro. Sem dependência e sem o núcleo:
// o roteador usa isto em todo erro de uso.

/** Distância de edição (Damerau, com a troca de duas letras vizinhas custando 1, como em "statsu" → "status"). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, at(i - 2, j - 2) + 1);
      const row = d[i];
      if (row !== undefined) row[j] = value;
    }
  }
  return at(a.length, b.length);
}

/**
 * O candidato mais parecido com `input`, ou `undefined` quando nenhum é parecido o bastante: distância até 2 (até 1
 * em palavras de 4 letras ou menos), ou `input` é o começo de um único candidato ("claude" → "claude-code").
 */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  const typed = input.toLowerCase();
  const prefixed = candidates.filter((candidate) => candidate.startsWith(typed));
  // "claude" → "claude-code": o começo de um ou mais candidatos, e o mais curto deles
  if (typed.length >= 3 && prefixed.length > 0) return [...prefixed].sort((a, b) => a.length - b.length)[0];
  const limit = typed.length <= 4 ? 1 : 2;
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(typed, candidate.toLowerCase());
    if (distance <= limit && (best === undefined || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

/** `" Você quis dizer \"x\"?"`, ou texto vazio. */
export function didYouMean(input: string, candidates: readonly string[], prefix = ''): string {
  const match = closest(input, candidates);
  return match === undefined ? '' : ` Você quis dizer "${prefix}${match}"?`;
}
