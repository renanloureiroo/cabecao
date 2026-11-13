// Separa o frontmatter YAML do corpo da nota. Nunca lança: YAML inválido vira um erro estruturado.
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { findWikiLinks } from './links.ts';
import type { FrontmatterError, FrontmatterLink, FrontmatterSplit } from './types.ts';

// Abre com `---` na primeira linha e fecha com `---` (ou `...`, o fim de documento do YAML) em linha própria.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const BOM = 0xfeff;

function countNewlines(text: string): number {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

const firstLine = (message: string): string => message.split('\n', 1)[0] ?? message;

/** Percorre um valor do frontmatter (texto, lista ou mapa aninhado) e recolhe os wikilinks dos textos. */
function collectLinks(node: unknown, property: string, lineOf: (offset: number) => number, out: FrontmatterLink[]) {
  if (isAlias(node)) return;
  if (isScalar(node)) {
    if (typeof node.value !== 'string') return;
    const line = lineOf(node.range?.[0] ?? 0);
    for (const link of findWikiLinks(node.value)) {
      out.push({ property, target: link.target, anchor: link.anchor, alias: link.alias, line });
    }
  } else if (isSeq(node)) {
    for (const item of node.items) collectLinks(item, property, lineOf, out);
  } else if (isMap(node)) {
    for (const pair of node.items) collectLinks(pair.value, property, lineOf, out);
  }
}

/** Um texto do frontmatter (valor ou chave, em qualquer profundidade), já decodificado, com a posição no arquivo. */
export interface FrontmatterString {
  /** O texto como o parser o entrega: sem aspas e com os escapes do YAML (`\x01`, `\e`, `g`) já resolvidos. */
  readonly value: string;
  /** Linha do arquivo (a partir de 1) em que o texto começa. */
  readonly line: number;
  /** Coluna (a partir de 1) em que o texto começa. */
  readonly column: number;
  /** As linhas do arquivo que o texto ocupa, como estão no arquivo (sem `\r`), unidas por `\n`. */
  readonly source: string;
}

/**
 * Todos os textos do frontmatter de uma nota (chaves e valores, dentro de listas e mapas), já decodificados. É o que
 * o scanner de segredos olha além do texto cru: no YAML, `"\x01ghp_..."` ou `"\x67hp_..."` escondem do texto cru um
 * token que o parser entrega inteiro. O YAML com erro também é percorrido (outro programa pode lê-lo de outro jeito).
 * Sem frontmatter, a lista vem vazia.
 */
export function frontmatterStrings(text: string): FrontmatterString[] {
  const source = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  const match = FRONTMATTER_RE.exec(source);
  if (match === null) return [];
  const raw = match[1] ?? '';
  const rawLines = raw.split('\n').map((line) => line.replace(/\r$/, ''));
  const lineCounter = new LineCounter();
  const out: FrontmatterString[] = [];
  const add = (node: unknown): void => {
    if (!isScalar(node) || typeof node.value !== 'string' || node.range == null) return;
    const start = lineCounter.linePos(node.range[0]);
    const end = lineCounter.linePos(Math.max(node.range[0], node.range[1] - 1));
    out.push({
      value: node.value,
      // o YAML começa na linha 2 do arquivo, depois do `---` de abertura
      line: start.line + 1,
      column: start.col,
      source: rawLines.slice(start.line - 1, end.line).join('\n'),
    });
  };
  const walk = (node: unknown): void => {
    if (isAlias(node)) return;
    if (isScalar(node)) add(node);
    else if (isSeq(node)) for (const item of node.items) walk(item);
    else if (isMap(node)) {
      for (const pair of node.items) {
        walk(pair.key);
        walk(pair.value);
      }
    }
  };
  try {
    walk(parseDocument(raw, { lineCounter }).contents);
  } catch {
    // o parser não lança com YAML inválido; isto é só defesa
  }
  return out;
}

/**
 * Separa frontmatter e corpo. Tira o BOM e aceita `\r\n`.
 * Um `---` de abertura sem fechamento não é frontmatter: o texto inteiro é corpo, sem erro (como no Obsidian).
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const source = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  const match = FRONTMATTER_RE.exec(source);
  if (match === null) {
    return { hasFrontmatter: false, data: {}, error: null, raw: null, body: source, bodyStartLine: 1, links: [] };
  }
  const raw = match[1] ?? '';
  const base = {
    hasFrontmatter: true,
    raw,
    body: source.slice(match[0].length),
    bodyStartLine: countNewlines(match[0]) + 1,
  };
  const failure = (error: FrontmatterError): FrontmatterSplit => ({ ...base, data: {}, error, links: [] });

  const lineCounter = new LineCounter();
  // o YAML começa na linha 2 do arquivo, depois do `---` de abertura
  const lineOf = (offset: number): number => lineCounter.linePos(offset).line + 1;
  try {
    const doc = parseDocument(raw, { lineCounter });
    const problem = doc.errors[0];
    if (problem !== undefined) {
      const line = problem.linePos?.[0].line;
      return failure({
        code: 'invalid_yaml',
        message: firstLine(problem.message),
        line: line === undefined ? null : line + 1,
      });
    }
    if (doc.contents === null) return { ...base, data: {}, error: null, links: [] };
    if (!isMap(doc.contents)) {
      return failure({ code: 'not_a_mapping', message: 'o frontmatter não é um mapa de chave e valor', line: 2 });
    }
    const data = doc.toJS() as Record<string, unknown>;
    const links: FrontmatterLink[] = [];
    for (const pair of doc.contents.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      collectLinks(pair.value, key, lineOf, links);
    }
    return { ...base, data, error: null, links };
  } catch (cause) {
    // `toJS` lança, por exemplo, quando há referências (`*x`) demais ou sem âncora
    const message = cause instanceof Error ? cause.message : String(cause);
    return failure({ code: 'invalid_yaml', message: firstLine(message), line: null });
  }
}
