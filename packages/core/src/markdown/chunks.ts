// Divisão em trechos (chunks), estimativa de tokens, prefixo de contexto e chave do trecho.
import { createHash } from 'node:crypto';

/** Alvo de tokens por trecho (doc 06: "divisão por seções do Markdown, com cerca de 350 tokens"). */
export const DEFAULT_CHUNK_TOKENS = 350;

/** Separador do caminho de títulos e do prefixo de contexto: `Título › Seção`. */
export const HEADING_PATH_SEPARATOR = ' › ';

// Um bloco sozinho pode passar do alvo até este fator antes de ser quebrado.
const OVERSIZE_FACTOR = 1.5;
const CHARS_PER_TOKEN = 4;
// Uma quebra "boa" (fim de frase, de linha ou de palavra) só vale se ficar depois desta fração da janela.
const MIN_CUT_FRACTION = 0.3;
const SENTENCE_END_RE = /[.!?…]["')\]»”]*(?=\s)/g;

/**
 * Estimativa de tokens: 1 token a cada 4 unidades UTF-16, arredondando para cima.
 * É uma aproximação de propósito: não depende do tokenizador do modelo escolhido, é determinística e custa O(1).
 * Serve para decidir onde cortar trechos e para orçamento de resposta, não para cobrar limite exato de modelo
 * (texto em português costuma dar um pouco mais de tokens reais do que esta conta).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Junta um caminho de títulos com ` › `. */
export function formatHeadingPath(headingPath: readonly string[]): string {
  return headingPath.join(HEADING_PATH_SEPARATOR);
}

const sameTitle = (a: string, b: string): boolean =>
  a.trim().normalize('NFC').toLowerCase() === b.trim().normalize('NFC').toLowerCase();

/**
 * Prefixo de contexto de um trecho: `Título › Seção › Subseção`.
 * Quando o primeiro título do caminho é o próprio título da nota (o caso comum do `# Título`), ele não é repetido.
 */
export function buildContextPrefix(title: string | null, headingPath: readonly string[]): string {
  const first = headingPath[0];
  if (title === null || title === '' || (first !== undefined && sameTitle(first, title))) {
    return formatHeadingPath(headingPath);
  }
  return formatHeadingPath([title, ...headingPath]);
}

/** Texto embutido: o prefixo de contexto na primeira linha e o trecho em seguida; só o trecho se não há prefixo. */
export function buildEmbedText(contextPrefix: string, text: string): string {
  return contextPrefix === '' ? text : `${contextPrefix}\n${text}`;
}

/**
 * Chave do trecho: SHA-256 do texto embutido (UTF-8), truncado em 16 bytes, em hexadecimal.
 * Depende só do texto: mover o arquivo ou mexer no frontmatter (fora o título) não muda a chave.
 */
export function computeChunkKey(embedText: string): string {
  return createHash('sha256').update(embedText, 'utf8').digest().subarray(0, 16).toString('hex');
}

/** Bloco do corpo: um parágrafo, uma lista, uma tabela ou um bloco de código inteiro. */
export interface Block {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Bloco de código: só pode ser cortado em quebra de linha, e a indentação é preservada. */
  readonly code: boolean;
}

/** Trecho ainda sem prefixo nem chave. */
export interface TextSpan {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Quantas quebras de linha há em `text[from, to)`. */
function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;

/** Onde cortar `window` (o começo do que falta): fim de frase, senão de linha, senão de palavra, senão no limite. */
function findCut(window: string, code: boolean): number {
  const min = Math.floor(window.length * MIN_CUT_FRACTION);
  if (!code) {
    let sentenceEnd = -1;
    for (const match of window.matchAll(SENTENCE_END_RE)) sentenceEnd = match.index + match[0].length;
    if (sentenceEnd >= min) return sentenceEnd;
  }
  const newline = window.lastIndexOf('\n');
  if (newline >= min && newline > 0) return newline;
  for (let i = window.length - 1; i >= min && i > 0; i--) {
    const ch = window.charCodeAt(i);
    if (ch === 32 || ch === 9) return i;
  }
  // corte seco; não separa um par substituto (emoji, por exemplo)
  const last = window.charCodeAt(window.length - 1);
  return last >= 0xd800 && last <= 0xdbff && window.length > 1 ? window.length - 1 : window.length;
}

/** Quebra um bloco grande demais em pedaços de até `targetTokens`. Anda por índices, sem recopiar o resto. */
function splitOversized(block: Block, targetTokens: number): TextSpan[] {
  const maxChars = Math.max(1, targetTokens * CHARS_PER_TOKEN);
  const { text } = block;
  const pieces: TextSpan[] = [];
  let pos = 0;
  let line = block.startLine;
  while (text.length - pos > maxChars) {
    const cut = pos + findCut(text.slice(pos, pos + maxChars), block.code);
    let end = cut;
    while (end > pos && isSpace(text.charCodeAt(end - 1))) end--;
    let next = cut;
    if (block.code) {
      // em código só somem espaços no corte e linhas em branco: a indentação da linha seguinte fica
      let scan = cut;
      while (scan < text.length && isSpace(text.charCodeAt(scan))) {
        if (text.charCodeAt(scan) === 10) next = scan + 1;
        scan++;
      }
      if (next === cut || scan === text.length) next = scan;
    } else {
      while (next < text.length && isSpace(text.charCodeAt(next))) next++;
    }
    if (end > pos) {
      pieces.push({ text: text.slice(pos, end), startLine: line, endLine: line + countNewlines(text, pos, end) });
    }
    line += countNewlines(text, pos, next);
    pos = next;
  }
  if (pos < text.length) pieces.push({ text: text.slice(pos), startLine: line, endLine: block.endLine });
  return pieces;
}

/**
 * Agrupa os blocos de UMA seção em trechos de cerca de `targetTokens`.
 * Blocos inteiros são mantidos juntos (separados por linha em branco) enquanto couberem; um bloco sozinho maior que
 * 1,5 vez o alvo é quebrado em fim de frase, de linha ou de palavra, nessa ordem de preferência.
 */
export function packBlocks(blocks: readonly Block[], targetTokens: number = DEFAULT_CHUNK_TOKENS): TextSpan[] {
  const spans: TextSpan[] = [];
  let pending: TextSpan[] = [];
  let pendingTokens = 0;
  const flush = (): void => {
    const first = pending[0];
    const last = pending[pending.length - 1];
    if (first !== undefined && last !== undefined) {
      spans.push({ text: pending.map((p) => p.text).join('\n\n'), startLine: first.startLine, endLine: last.endLine });
    }
    pending = [];
    pendingTokens = 0;
  };
  for (const block of blocks) {
    const tokens = estimateTokens(block.text);
    if (pendingTokens > 0 && pendingTokens + tokens > targetTokens) flush();
    if (tokens > targetTokens * OVERSIZE_FACTOR) {
      // aqui `pending` está vazio: ou acabou de ser descarregado ou não havia nada
      const pieces = splitOversized(block, targetTokens);
      const last = pieces.pop();
      spans.push(...pieces);
      // o último pedaço fica pendente e pode receber os blocos seguintes
      if (last !== undefined) {
        pending = [last];
        pendingTokens = estimateTokens(last.text);
      }
    } else {
      pending.push(block);
      pendingTokens += tokens;
    }
  }
  flush();
  return spans;
}
