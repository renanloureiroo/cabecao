// Scanner de segredos: roda em toda escrita e antes de todo envio. Se achar algo, a operação é bloqueada.
// Função pura, sem I/O. Ver as regras em rules.ts e as heurísticas em heuristics.ts.
import { redactSecret } from './heuristics.ts';
import { SECRET_RULES, type SecretRuleId } from './rules.ts';

/**
 * Marcador de allowlist. Uma linha que o contém nunca é acusada; uma linha que só tem o marcador
 * (sozinho ou dentro de um comentário, como `<!-- cabecao:allow-secret -->`) libera a linha seguinte.
 * Para uma chave privada em várias linhas, basta liberar a linha do cabeçalho `-----BEGIN`.
 */
export const ALLOW_SECRET_MARKER = 'cabecao:allow-secret';

export interface SecretFinding {
  /** Regra que acusou. */
  rule: SecretRuleId;
  /** Linha do primeiro caractere do segredo, a partir de 1. */
  line: number;
  /** Coluna do primeiro caractere do segredo, a partir de 1, em unidades UTF-16 (como `String.prototype.length`). */
  column: number;
  /** Trecho redigido, seguro para log e mensagem de erro. Nunca traz o segredo inteiro. */
  match: string;
  /** O que a regra procura. */
  description: string;
}

export interface ScanSecretsOptions {
  /**
   * Respeitar o marcador `cabecao:allow-secret`. O padrão é `true`.
   * Use `false` para conteúdo que não foi você quem escreveu (ingestão com `trust: low`).
   */
  honorAllowMarker?: boolean;
}

interface Candidate {
  rule: SecretRuleId;
  priority: number;
  start: number;
  end: number;
  match: string;
  description: string;
}

/** Posições de início de cada linha, para converter índice em linha e coluna. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** Índice (a partir de 0) da linha que contém a posição, por busca binária. */
function lineIndexOf(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

// O que pode cercar o marcador numa linha "só de marcador": espaços e delimitadores de comentário
// de Markdown/HTML (<!-- -->), Obsidian (%%), YAML/shell (#) e código (// /* */).
const COMMENT_DECORATION = /<!--|-->|%%|\/\*|\*\/|\/\/|[#\s]/g;

/**
 * Procura segredos no texto. Devolve os achados na ordem em que aparecem; lista vazia quer dizer
 * que nada foi encontrado.
 */
export function scanSecrets(text: string, options: ScanSecretsOptions = {}): SecretFinding[] {
  const candidates: Candidate[] = [];
  SECRET_RULES.forEach((rule, priority) => {
    // matchAll trabalha sobre uma cópia da expressão: nada de `lastIndex` compartilhado entre chamadas.
    for (const match of text.matchAll(rule.pattern)) {
      const hit = rule.locate(match, text);
      if (!hit) continue;
      candidates.push({
        rule: rule.id,
        priority,
        start: hit.start,
        end: hit.end,
        match: hit.display ?? redactSecret(text.slice(hit.start, hit.end)),
        description: rule.description,
      });
    }
  });
  if (candidates.length === 0) return [];

  // Sobreposição: fica um achado só, o da regra mais específica (a que vem antes na lista).
  candidates.sort((a, b) => a.start - b.start || a.priority - b.priority);
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const last = kept[kept.length - 1];
    if (last && candidate.start < last.end) {
      if (candidate.priority < last.priority) kept[kept.length - 1] = candidate;
      continue;
    }
    kept.push(candidate);
  }

  const starts = lineStarts(text);
  const honorAllowMarker = options.honorAllowMarker ?? true;
  const allowedLines = new Map<number, boolean>();
  const lineText = (index: number) => text.slice(starts[index] ?? 0, starts[index + 1] ?? text.length);
  const isAllowed = (index: number): boolean => {
    let allowed = allowedLines.get(index);
    if (allowed === undefined) {
      allowed = lineText(index).includes(ALLOW_SECRET_MARKER);
      if (!allowed && index > 0) {
        const previous = lineText(index - 1);
        allowed =
          previous.includes(ALLOW_SECRET_MARKER) &&
          previous.replaceAll(ALLOW_SECRET_MARKER, '').replace(COMMENT_DECORATION, '') === '';
      }
      allowedLines.set(index, allowed);
    }
    return allowed;
  };

  const findings: SecretFinding[] = [];
  for (const candidate of kept) {
    const index = lineIndexOf(starts, candidate.start);
    if (honorAllowMarker && isAllowed(index)) continue;
    findings.push({
      rule: candidate.rule,
      line: index + 1,
      column: candidate.start - (starts[index] ?? 0) + 1,
      match: candidate.match,
      description: candidate.description,
    });
  }
  return findings;
}
