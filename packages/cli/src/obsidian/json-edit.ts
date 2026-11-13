// Edição cirúrgica dos JSON do `.obsidian/`, sobre o leitor de JSONC do `install-client`: cada mudança mexe só no
// trecho necessário do texto e deixa a ordem das chaves, a indentação, as quebras de linha e o resto do arquivo como
// estavam. Uma mudança por vez, relendo o texto entre elas (as posições de uma leitura não valem depois de editar).
import type { JsonArrayNode, JsonNode, JsonObjectNode, JsonValue } from '../install-client/jsonc.ts';
import { applyEdits, findProp, insertProp, parseJsonc, removeProp, toValue } from '../install-client/jsonc.ts';

/** O texto lido como objeto, ou o motivo de não ser. */
export function parseObject(text: string): { root: JsonObjectNode } | { error: string } {
  try {
    const root = parseJsonc(text);
    if (root.type !== 'object') return { error: 'o conteúdo não é um objeto JSON' };
    return { root };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function root(text: string): JsonObjectNode {
  const parsed = parseObject(text);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.root;
}

/** Nó do caminho `["types"]`, `[]` = raiz. */
function nodeAt(text: string, path: readonly string[]): JsonNode | undefined {
  let node: JsonNode = root(text);
  for (const key of path) {
    if (node.type !== 'object') return undefined;
    const prop = findProp(node, key);
    if (prop === undefined) return undefined;
    node = prop.value;
  }
  return node;
}

/** Valor em `path`, ou `undefined` se não existe. */
export function valueAt(text: string, path: readonly string[]): JsonValue | undefined {
  const node = nodeAt(text, path);
  return node === undefined ? undefined : toValue(node);
}

/** Acrescenta `key: value` no objeto em `path` (que tem de existir). Não mexe se a chave já existe. */
export function addKey(text: string, path: readonly string[], key: string, value: JsonValue): string {
  const node = nodeAt(text, path);
  if (node?.type !== 'object' || findProp(node, key) !== undefined) return text;
  return applyEdits(text, insertProp(text, node, key, value));
}

/** Tira `key` do objeto em `path`. */
export function removeKey(text: string, path: readonly string[], key: string): string {
  const node = nodeAt(text, path);
  if (node?.type !== 'object') return text;
  const prop = findProp(node, key);
  return prop === undefined ? text : applyEdits(text, removeProp(text, node, prop));
}

const lineStart = (text: string, offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;
const startsItsLine = (text: string, offset: number): boolean =>
  /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset));
const indentOf = (text: string, offset: number): string =>
  /^[ \t]*/.exec(text.slice(lineStart(text, offset), offset))?.[0] ?? '';
const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');
const unitOf = (text: string): string => /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';

function render(value: JsonValue, unit: string, indent: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
}

/** Acrescenta `value` no fim da lista em `path` (que tem de existir), no estilo das linhas que ela já tem. */
export function appendItem(text: string, path: readonly string[], value: JsonValue): string {
  const node = nodeAt(text, path);
  if (node?.type !== 'array') return text;
  const array: JsonArrayNode = node;
  const eol = eolOf(text);
  const unit = unitOf(text);
  const last = array.items.at(-1);
  if (last === undefined) {
    // lista vazia: os itens vão um por linha, um nível abaixo da linha da lista
    const indent = indentOf(text, array.start);
    const inner = `${eol}${indent}${unit}${render(value, unit, indent + unit, eol)}${eol}${indent}`;
    return applyEdits(text, [{ start: array.start + 1, end: array.end - 1, text: inner }]);
  }
  if (!startsItsLine(text, last.start)) {
    return applyEdits(text, [{ start: last.end, end: last.end, text: `, ${JSON.stringify(value)}` }]);
  }
  const indent = indentOf(text, last.start);
  return applyEdits(text, [
    { start: last.end, end: last.end, text: `,${eol}${indent}${render(value, unit, indent, eol)}` },
  ]);
}

/** Tira o item `index` da lista em `path`, com a vírgula e o espaço que o separavam. */
export function removeItem(text: string, path: readonly string[], index: number): string {
  const node = nodeAt(text, path);
  if (node?.type !== 'array') return text;
  const item = node.items[index];
  if (item === undefined) return text;
  if (node.items.length === 1) return applyEdits(text, [{ start: node.start + 1, end: node.end - 1, text: '' }]);
  const next = node.items[index + 1];
  if (next !== undefined) return applyEdits(text, [{ start: item.start, end: next.start, text: '' }]);
  const previous = node.items[index - 1] as JsonNode;
  return applyEdits(text, [{ start: previous.end, end: item.end, text: '' }]);
}

/** JSON novo no formato que o Obsidian grava (2 espaços, sem quebra de linha no fim). */
export function freshJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}
