// Verificação das citações, igual para todo provedor (é o Cabeção que confere, não o modelo):
//
// 1. cada rótulo citado (`S3`) tem de estar entre os enviados; rótulo inventado é removido;
// 2. a citação literal (`quote`) tem de aparecer no trecho citado, depois de normalizar forma Unicode, acentos, caixa,
//    aspas e espaços (e sem os `^` da marcação de dados); um rótulo cujo trecho não contém a citação é removido;
// 3. a afirmação sem nenhuma citação válida fica `supported: false`: aparece marcada, nunca escondida, e conta em
//    `unsupported_claims`.
import { normalizeForMatch } from './passages.ts';
import type { SentPassage } from './prompt.ts';
import type { RawClaim } from './schema.ts';

/** Uma citação mais curta que isto não prova nada (qualquer palavra solta casaria). */
export const MIN_QUOTE_CHARS = 8;

export interface VerifiedClaim {
  readonly text: string;
  /** Rótulos (`S1`...) que conferiram, na ordem citada. */
  readonly labels: readonly string[];
  readonly quote: string;
  readonly supported: boolean;
  /** Rótulos citados que não existem ou cujo trecho não contém a citação. */
  readonly rejected: readonly { readonly label: string; readonly reason: 'unknown_label' | 'quote_mismatch' }[];
}

function comparable(text: string): string {
  return normalizeForMatch(text.replace(/\^/g, ' ')).replace(/^["'.…\s]+|["'.…\s]+$/g, '');
}

/** O trecho enviado contém a citação, na forma comparável. */
export function quoteMatches(quote: string, sent: SentPassage): boolean {
  const needle = comparable(quote);
  if (needle.length < MIN_QUOTE_CHARS) return false;
  // "..." no meio da citação (o modelo pulou um pedaço): cada parte tem de aparecer, na ordem
  const haystack = comparable(sent.sentText);
  const parts = needle.split(/\s*(?:\.\.\.|…)\s*/).filter((part) => part !== '');
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return parts.length > 0;
}

/** Normaliza um rótulo como o modelo escreveu (`s2`, `[S2]`, `S 2`) para `S2`. */
export function normalizeLabel(label: string): string {
  const match = /^\[?\s*s\s*(\d{1,3})\s*\]?$/i.exec(label.trim());
  return match === null ? label.trim() : `S${Number(match[1])}`;
}

export function verifyClaim(claim: RawClaim, sent: ReadonlyMap<string, SentPassage>): VerifiedClaim {
  const labels: string[] = [];
  const rejected: VerifiedClaim['rejected'][number][] = [];
  for (const raw of claim.sources) {
    const label = normalizeLabel(raw);
    if (labels.includes(label) || rejected.some((r) => r.label === label)) continue;
    const passage = sent.get(label);
    if (passage === undefined) rejected.push({ label, reason: 'unknown_label' });
    else if (!quoteMatches(claim.quote, passage)) rejected.push({ label, reason: 'quote_mismatch' });
    else labels.push(label);
  }
  return { text: claim.text, labels, quote: claim.quote.replace(/\^/g, ' '), supported: labels.length > 0, rejected };
}
