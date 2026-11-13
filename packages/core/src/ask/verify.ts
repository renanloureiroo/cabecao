// Verificação das citações, igual para todo provedor (é o Cabeção que confere, não o modelo):
//
// 1. cada rótulo citado (`S3`) tem de estar entre os enviados; rótulo inventado é removido;
// 2. a citação literal (`quote`) tem de aparecer no trecho citado, depois de normalizar forma Unicode, acentos, caixa,
//    aspas e espaços (e sem os `^` da marcação de dados); um rótulo cujo trecho não contém a citação é removido;
// 3. a afirmação sem nenhuma citação válida fica `supported: false`: aparece marcada, nunca escondida, e conta em
//    `unsupported_claims`.
//
// Contra o casamento acidental (revisão adversária): a citação tem de ser SUBSTANTIVA (palavras de verdade, não só
// pontuação, espaços, números ou palavras vazias), cada pedaço separado por reticências também, e a citação devolvida
// é SEMPRE o texto real do trecho (o intervalo casado), nunca o que o modelo escreveu.
//
// Limite honesto: confere que a citação está no trecho, não que a conclusão da afirmação decorre dela.
import type { Passage } from './passages.ts';
import type { SentPassage } from './prompt.ts';
import type { RawClaim } from './schema.ts';

/** Mínimo de caracteres alfanuméricos de cada pedaço da citação. */
export const MIN_QUOTE_CHARS = 16;
/** Mínimo de palavras com conteúdo (3+ letras, fora das palavras vazias) de cada pedaço. */
export const MIN_QUOTE_WORDS = 3;

const STOPWORDS = new Set(
  'a o e de da do das dos em no na nos nas um uma uns umas que se por para com sem como mas ou ao aos à às é foi ser são era ele ela eles elas isso isto este esta esse essa seu sua seus suas mais menos muito já não sim the and for with from that this are was were has have had not but you'.split(
    ' ',
  ),
);

export interface VerifiedClaim {
  readonly text: string;
  /** Rótulos (`S1`...) que conferiram, na ordem citada. */
  readonly labels: readonly string[];
  /** A citação como está no trecho (o texto real casado), ou `''` quando não conferiu. */
  readonly quote: string;
  readonly supported: boolean;
  /** Rótulos citados que não existem ou cujo trecho não contém a citação. */
  readonly rejected: readonly { readonly label: string; readonly reason: 'unknown_label' | 'quote_mismatch' }[];
}

const QUOTE_MAP: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '`': "'",
  '´': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
  '«': '"',
  '»': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  '‹': '<',
  '›': '>',
  '^': ' ',
};

/**
 * Forma comparável de um texto, com o mapa de cada caractere da saída para a posição no original: sem acentos, em
 * minúsculas, aspas e traços retos, `…` como `...`, `^` (marcação de dados) como espaço, espaços colapsados.
 */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let space = true; // corta espaço no começo
  let i = 0;
  for (const char of text) {
    const at = i;
    i += char.length;
    if (/\s/u.test(char) || char === '^') {
      if (!space) {
        norm += ' ';
        map.push(at);
        space = true;
      }
      continue;
    }
    const mapped = char === '…' ? '...' : (QUOTE_MAP[char] ?? char);
    const plain = mapped.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    for (const out of plain) {
      norm += out;
      map.push(at);
    }
    if (plain !== '') space = false;
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/** O pedaço é substantivo: caracteres alfanuméricos e palavras de conteúdo suficientes. */
export function substantive(part: string): boolean {
  const alnum = part.replace(/[^\p{L}\p{N}]/gu, '');
  if (alnum.length < MIN_QUOTE_CHARS) return false;
  const words = part.split(/[^\p{L}\p{N}]+/u).filter((w) => /\p{L}{3,}/u.test(w) && !STOPWORDS.has(w));
  return words.length >= MIN_QUOTE_WORDS;
}

/**
 * Procura a citação no texto real do trecho. Devolve o texto real casado (pedaços unidos por " … " quando o modelo
 * usou reticências no meio), ou `null`. Cada pedaço tem de ser substantivo e aparecer na ordem.
 */
export function matchQuote(quote: string, content: string): string | null {
  const needle = normalizeWithMap(quote).norm.replace(/^["'.\s-]+|["'.\s-]+$/g, '');
  const parts = needle
    .split(/\s*\.\.\.\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0 || parts.length > 3 || !parts.every(substantive)) return null;
  const { norm, map } = normalizeWithMap(content);
  const found: string[] = [];
  let from = 0;
  for (const part of parts) {
    const at = norm.indexOf(part, from);
    if (at === -1) return null;
    const end = at + part.length - 1;
    const start = map[at] as number;
    const last = map[end] as number;
    // o fim real inclui o caractere inteiro (um caractere do original pode virar vários na forma comparável)
    const stop =
      last + (content.codePointAt(last) !== undefined && (content.codePointAt(last) as number) > 0xffff ? 2 : 1);
    found.push(content.slice(start, stop));
    from = at + part.length;
  }
  return found.join(' … ');
}

/** O trecho enviado contém a citação (compatibilidade: só diz sim ou não). */
export function quoteMatches(
  quote: string,
  sent: Pick<SentPassage, 'passage'> & { readonly passage: Pick<Passage, 'content'> },
): boolean {
  return matchQuote(quote, sent.passage.content) !== null;
}

/** Normaliza um rótulo como o modelo escreveu (`s2`, `[S2]`, `S 2`) para `S2`. */
export function normalizeLabel(label: string): string {
  const match = /^\[?\s*s\s*(\d{1,3})\s*\]?$/i.exec(label.trim());
  return match === null ? label.trim() : `S${Number(match[1])}`;
}

export function verifyClaim(claim: RawClaim, sent: ReadonlyMap<string, SentPassage>): VerifiedClaim {
  const labels: string[] = [];
  const rejected: VerifiedClaim['rejected'][number][] = [];
  let quote = '';
  for (const raw of claim.sources) {
    const label = normalizeLabel(raw);
    if (labels.includes(label) || rejected.some((r) => r.label === label)) continue;
    const passage = sent.get(label);
    if (passage === undefined) {
      rejected.push({ label, reason: 'unknown_label' });
      continue;
    }
    const real = matchQuote(claim.quote, passage.passage.content);
    if (real === null) rejected.push({ label, reason: 'quote_mismatch' });
    else {
      labels.push(label);
      if (quote === '') quote = real;
    }
  }
  return { text: claim.text, labels, quote, supported: labels.length > 0, rejected };
}
