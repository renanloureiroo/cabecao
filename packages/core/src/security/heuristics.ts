// Heurísticas compartilhadas pelas regras do scanner de segredos.
// Tudo aqui é função pura e de custo linear no tamanho do valor analisado.

/** Entropia de Shannon em bits por caractere. Hex aleatório fica perto de 4; base64 aleatório, perto de 6. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Marcas de valor ilustrativo. As palavras curtas (your, seu, fake...) só valem quando isoladas por
// separadores, para não descartar um token aleatório que as contenha por acaso.
const PLACEHOLDER =
  /x{4,}|\*{3,}|\.{3,}|…|[<>]|\{\{|\$\{|example|exemplo|change[_-]?me|placeholder|redacted|dummy|insert|replace|(?:^|[^a-z0-9])(?:your|seu|sua|meu|minha|fake|todo)(?:[^a-z0-9]|$)/i;

/** Diz se o valor é um placeholder óbvio (`xxxx`, `<seu-token>`, `EXAMPLE`, `changeme`, `...`). */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ULIDs e UUIDs são identificadores, não segredos: o cérebro está cheio deles. */
export function isIdentifier(value: string): boolean {
  return ULID.test(value) || UUID.test(value);
}

/**
 * Tamanho do maior trecho alfanumérico contínuo que mistura letras e dígitos.
 * Texto comum, slugs e datas (`2026-11-10-atlas`, `sha256`, `v2`) dão valores baixos;
 * tokens e senhas geradas dão valores altos.
 */
export function longestMixedRun(value: string): number {
  let best = 0;
  let length = 0;
  let hasLetter = false;
  let hasDigit = false;
  for (let i = 0; i <= value.length; i++) {
    const code = i < value.length ? value.charCodeAt(i) : 0;
    const digit = code >= 48 && code <= 57;
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (digit || letter) {
      length++;
      hasDigit ||= digit;
      hasLetter ||= letter;
      continue;
    }
    if (hasLetter && hasDigit && length > best) best = length;
    length = 0;
    hasLetter = false;
    hasDigit = false;
  }
  return best;
}

// Só ASCII imprimível: segredos reais quase nunca têm acento, e prosa em português quase sempre tem.
const ASCII_PRINTABLE = /^[\x21-\x7e]+$/;

// Valores que são referência a outro lugar (variável, caminho, URL, expressão), não o segredo em si.
const REFERENCE = /^(?:[=$%/~|\\]|\.{1,2}\/)|:\/\/|[(){}[\]]/;
const DOTTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function isCandidateValue(value: string): boolean {
  return (
    ASCII_PRINTABLE.test(value) &&
    !REFERENCE.test(value) &&
    !DOTTED_IDENTIFIER.test(value) &&
    !isPlaceholder(value) &&
    !isIdentifier(value)
  );
}

/** Critério para valores de `token=`, `secret=`, `api_key=`: longos, de alta entropia e com cara de gerados. */
export function looksLikeGeneratedSecret(value: string): boolean {
  return value.length >= 16 && isCandidateValue(value) && shannonEntropy(value) >= 3 && longestMixedRun(value) >= 8;
}

/** Critério para valores de `password=`/`senha=`: senhas são mais curtas e escolhidas por gente. */
export function looksLikePassword(value: string): boolean {
  return value.length >= 8 && isCandidateValue(value) && shannonEntropy(value) >= 2.5 && longestMixedRun(value) >= 6;
}

/** Devolve uma versão segura para exibir: no máximo os 4 primeiros caracteres e o tamanho. Nunca o segredo inteiro. */
export function redactSecret(secret: string): string {
  const shown = Math.min(4, Math.floor(secret.length / 4));
  return `${secret.slice(0, shown)}…(${secret.length} caracteres)`;
}
