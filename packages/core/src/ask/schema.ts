// O formato que o provedor devolve, a validação local (todo provedor é validado do mesmo jeito, haja ou não modo
// estrito do lado dele), a leitura das afirmações que já chegaram inteiras num JSON ainda incompleto (streaming) e a
// limpeza de texto que veio de fora.
import type { JsonSchema } from './types.ts';

/** Máximo de afirmações aproveitadas; o resto é descartado (e contado). */
export const MAX_CLAIMS = 12;
export const MAX_CLAIM_CHARS = 1200;
export const MAX_QUOTE_CHARS = 400;
export const MAX_MISSING_CHARS = 600;
const MAX_SOURCES_PER_CLAIM = 6;

/**
 * Esquema enviado ao provedor. Compatível com os modos estritos (OpenAI, Anthropic, Gemini compatível): todo campo
 * obrigatório, `additionalProperties: false`, sem `minLength`/`maxLength` (os limites são aplicados aqui).
 */
export const ANSWER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'claims', 'missing'],
  properties: {
    status: { type: 'string', enum: ['answered', 'not_found'] },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'sources', 'quote'],
        properties: {
          text: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          quote: { type: 'string' },
        },
      },
    },
    missing: { type: 'string' },
  },
};

export interface RawClaim {
  readonly text: string;
  readonly sources: readonly string[];
  readonly quote: string;
}

export interface RawAnswer {
  readonly status: 'answered' | 'not_found';
  readonly claims: readonly RawClaim[];
  readonly missing: string;
  /** Afirmações além de `MAX_CLAIMS`, descartadas. */
  readonly droppedClaims: number;
}

export type AnswerValidation =
  | { readonly ok: true; readonly value: RawAnswer }
  | { readonly ok: false; readonly errors: string[] };

// Sequências de escape de terminal (CSI, OSC, DCS/PM/APC e ESC de um caractere), caracteres de controle C0 (menos
// quebra de linha e tabulação), DEL, C1 e os controles de direção bidirecional (que escondem ou invertem texto).
// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const ANSI_STRING = /\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const ANSI_SINGLE = /\u001b[@-Z\\-_]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Tira do texto vindo de fora tudo o que um terminal interpretaria (cores, títulos de janela, cursor, bidi). */
export function sanitizeText(text: string): string {
  return text.replace(ANSI_STRING, '').replace(ANSI_CSI, '').replace(ANSI_SINGLE, '').replace(CONTROL, '');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readClaim(value: unknown, index: number, errors: string[]): RawClaim | null {
  if (!isRecord(value)) {
    errors.push(`claims[${index}] deveria ser um objeto`);
    return null;
  }
  const { text, sources, quote } = value;
  if (typeof text !== 'string') errors.push(`claims[${index}].text deveria ser texto`);
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'string')) {
    errors.push(`claims[${index}].sources deveria ser uma lista de rótulos como "S1"`);
  }
  if (typeof quote !== 'string') errors.push(`claims[${index}].quote deveria ser texto`);
  if (typeof text !== 'string' || !Array.isArray(sources) || typeof quote !== 'string') return null;
  const clean = sanitizeText(text).replace(/\s+/g, ' ').trim();
  if (clean === '') return null;
  return {
    text: clip(clean, MAX_CLAIM_CHARS),
    sources: (sources as string[]).slice(0, MAX_SOURCES_PER_CLAIM).map((source) => sanitizeText(source).trim()),
    quote: clip(sanitizeText(quote).trim(), MAX_QUOTE_CHARS),
  };
}

/** Confere o objeto do provedor. Afirmações demais e textos longos são cortados; forma errada é erro. */
export function validateAnswer(value: unknown): AnswerValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['a resposta deveria ser um objeto JSON'] };
  const status = value.status;
  if (status !== 'answered' && status !== 'not_found') errors.push('"status" deveria ser "answered" ou "not_found"');
  if (!Array.isArray(value.claims)) errors.push('"claims" deveria ser uma lista');
  const missing = value.missing;
  if (missing !== undefined && missing !== null && typeof missing !== 'string')
    errors.push('"missing" deveria ser texto');
  const claims: RawClaim[] = [];
  const list = Array.isArray(value.claims) ? (value.claims as unknown[]) : [];
  list.slice(0, MAX_CLAIMS).forEach((item, index) => {
    const claim = readClaim(item, index, errors);
    if (claim !== null) claims.push(claim);
  });
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 8) };
  return {
    ok: true,
    value: {
      status: status as 'answered' | 'not_found',
      claims,
      missing: clip(sanitizeText(typeof missing === 'string' ? missing : '').trim(), MAX_MISSING_CHARS),
      droppedClaims: Math.max(0, list.length - MAX_CLAIMS),
    },
  };
}

/**
 * Tira cercas de código (```json ... ```) e texto antes do primeiro `{`: servidores locais compatíveis com OpenAI às
 * vezes embrulham o JSON mesmo com o formato pedido. Lança `SyntaxError` se não sobrar JSON.
 */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end < start) throw new SyntaxError('a resposta não tem um objeto JSON');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Afirmações que já chegaram INTEIRAS num JSON ainda incompleto (o texto acumulado do streaming): os objetos fechados
 * da lista `claims` do primeiro nível. Tolerante: devolve o que conseguir ler, nunca lança.
 */
export function completedClaims(partial: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let key = '';
  let lastKey = '';
  let readingKey = false;
  let claimsDepth = -1; // profundidade do `[` de "claims"
  let objectStart = -1;
  for (let i = 0; i < partial.length; i++) {
    const char = partial[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (readingKey) {
          lastKey = key;
          readingKey = false;
        }
      } else if (readingKey) key += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      // uma chave do objeto do primeiro nível começa logo depois de `{` ou `,` nesse nível
      readingKey = depth === 1 && claimsDepth === -1;
      key = '';
    } else if (char === '{' || char === '[') {
      depth++;
      if (char === '[' && depth === 2 && lastKey === 'claims' && claimsDepth === -1) claimsDepth = depth;
      else if (char === '{' && claimsDepth !== -1 && depth === claimsDepth + 1) objectStart = i;
    } else if (char === '}' || char === ']') {
      if (char === '}' && claimsDepth !== -1 && depth === claimsDepth + 1 && objectStart !== -1) {
        try {
          out.push(JSON.parse(partial.slice(objectStart, i + 1)));
        } catch {
          // objeto que não é JSON válido: a validação final cuida dele
        }
        objectStart = -1;
      }
      if (char === ']' && depth === claimsDepth) claimsDepth = -2; // a lista acabou
      depth--;
    } else if (char === ':' && depth === 1) {
      // `lastKey` já foi gravada ao fechar a string
    } else if (char === ',' && depth === 1) {
      lastKey = '';
    }
  }
  return out;
}
