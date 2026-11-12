// Gravação do frontmatter: YAML estável e, na edição de uma nota existente, mexendo só nas linhas dos campos alterados.
import { isDeepStrictEqual } from 'node:util';
import { Document, isMap, isScalar, isSeq, LineCounter, parseDocument, Scalar } from 'yaml';
import type { RelationsConfig } from './schema.ts';
import { fieldOrder } from './schema.ts';

/** Relações extras do `.cabecao.json` (um `BrainConfig` serve), para entrarem na ordem canônica junto das fixas. */
export type SerializeOptions = RelationsConfig;

const STRINGIFY_OPTIONS = { lineWidth: 0, flowCollectionPadding: false, nullStr: '' } as const;

/** Chaves na ordem de gravação: as conhecidas na ordem canônica e, depois, as desconhecidas na ordem em que vieram. */
function orderedKeys(data: Readonly<Record<string, unknown>>, options: SerializeOptions): string[] {
  const known = fieldOrder(options);
  const keys = known.filter((key) => data[key] !== undefined);
  for (const key of Object.keys(data)) if (data[key] !== undefined && !known.includes(key)) keys.push(key);
  return keys;
}

/**
 * Frontmatter em YAML, sem os delimitadores `---`, com uma linha por campo e terminado em LF (vazio se não há campo).
 *
 * - Ordem canônica dos campos conhecidos; os desconhecidos vêm depois, na ordem recebida.
 * - Wikilinks sempre entre aspas duplas (`"[[Nota]]"`), porque `[[` sem aspas é uma lista dentro de lista no YAML.
 * - Datas sem aspas (`2026-05-03`), como o Obsidian grava.
 * - Campo vazio (`null`) como `valid_until:`; lista vazia como `[]`; listas de valores simples em uma linha.
 * - Campos com `undefined` são omitidos. A saída não depende do sistema nem do idioma da máquina.
 */
export function serializeFrontmatter(data: Readonly<Record<string, unknown>>, options: SerializeOptions = {}): string {
  const keys = orderedKeys(data, options);
  if (keys.length === 0) return '';
  const doc = new Document({});
  const quoteLinks = (node: unknown): void => {
    if (isScalar(node) && typeof node.value === 'string' && node.value.includes('[[')) node.type = Scalar.QUOTE_DOUBLE;
  };
  for (const key of keys) {
    const node = doc.createNode(data[key]);
    quoteLinks(node);
    if (isSeq(node) && node.items.every((item) => isScalar(item))) {
      node.flow = true;
      for (const item of node.items) quoteLinks(item);
    }
    doc.set(key, node);
  }
  return doc.toString(STRINGIFY_OPTIONS);
}

/**
 * Monta o arquivo de uma nota: `---`, o frontmatter, `---` e o corpo, terminando em LF.
 * Sem campos no frontmatter, o bloco `---` é omitido (fonte bruta). O corpo é mantido como veio; só ganha a quebra
 * de linha final se faltar. Parsear o resultado devolve o mesmo frontmatter e o mesmo corpo.
 */
export function serializeNote(
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
  options: SerializeOptions = {},
): string {
  const yaml = serializeFrontmatter(frontmatter, options);
  const header = yaml === '' ? '' : `---\n${yaml}---\n`;
  // sem frontmatter, um corpo que começa com `---` seria lido como frontmatter: uma linha em branco evita isso
  const guard = header === '' && /^---[ \t]*\r?\n/.test(body) ? '\n' : '';
  const text = `${header}${guard}${body}`;
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

export interface FrontmatterEdit {
  /** Campos a gravar (substitui o valor existente ou acrescenta). */
  readonly set: Readonly<Record<string, unknown>>;
  /** Campos a remover. */
  readonly remove?: readonly string[];
}

/** Linha em branco ou comentário na coluna 0: fica onde está quando o campo de cima é trocado ou removido. */
const DETACHED_LINE_RE = /^(?:#.*)?\s*$/;

/**
 * Aplica uma edição ao YAML cru do frontmatter mexendo SÓ nas linhas dos campos alterados: ordem, aspas, comentários
 * e formatação do resto ficam byte a byte como estavam (menos ruído no git e menos conflito entre máquinas).
 * Campo novo entra na posição da ordem canônica; campo desconhecido novo vai para o fim.
 *
 * Devolve `null` quando não dá para editar com segurança (YAML que não é um mapa em bloco, chave repetida ou
 * complexa); o chamador então regrava o frontmatter inteiro com `serializeFrontmatter`.
 */
export function editFrontmatterText(raw: string, edit: FrontmatterEdit, options: SerializeOptions = {}): string | null {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw === '' ? [] : raw.split(/\r?\n/);
  const lineCounter = new LineCounter();
  let expected: Record<string, unknown>;
  const entries: { key: string; start: number; end: number }[] = [];
  try {
    const doc = parseDocument(raw, { lineCounter });
    if (doc.errors.length > 0) return null;
    if (doc.contents !== null) {
      if (!isMap(doc.contents) || doc.contents.flow === true) return null;
      for (const pair of doc.contents.items) {
        const key = pair.key;
        if (!isScalar(key) || typeof key.value !== 'string' || key.range == null) return null;
        const position = lineCounter.linePos(key.range[0]);
        if (position.col !== 1) return null;
        entries.push({ key: key.value, start: position.line - 1, end: lines.length });
      }
    }
    expected = (doc.toJS() ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  entries.forEach((entry, i) => {
    const next = entries[i + 1];
    if (next !== undefined) entry.end = next.start;
  });
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) return null;

  const removed = new Set(edit.remove ?? []);
  const toSet = new Map(Object.entries(edit.set).filter(([, value]) => value !== undefined));
  for (const key of removed) delete expected[key];
  for (const [key, value] of toSet) expected[key] = value;

  const fieldLines = (key: string, value: unknown): string[] =>
    serializeFrontmatter({ [key]: value }, options)
      .replace(/\n$/, '')
      .split('\n');
  /** Fim do campo sem as linhas soltas (em branco ou comentário) que vêm depois dele. */
  const contentEnd = (entry: { start: number; end: number }): number => {
    let end = entry.end;
    while (end > entry.start + 1 && DETACHED_LINE_RE.test(lines[end - 1] ?? '')) end--;
    return end;
  };

  // blocos de linhas: o preâmbulo (comentários antes do primeiro campo) e um bloco por campo
  const order = fieldOrder(options);
  const rankOf = (key: string): number => {
    const rank = order.indexOf(key);
    return rank === -1 ? Number.POSITIVE_INFINITY : rank;
  };
  const blocks: { key: string | null; lines: string[] }[] = [
    { key: null, lines: lines.slice(0, entries[0]?.start ?? lines.length) },
  ];
  for (const entry of entries) {
    const end = contentEnd(entry);
    const trailing = lines.slice(end, entry.end);
    if (removed.has(entry.key) && !toSet.has(entry.key)) {
      blocks.push({ key: null, lines: trailing });
    } else if (toSet.has(entry.key)) {
      blocks.push(
        { key: entry.key, lines: fieldLines(entry.key, toSet.get(entry.key)) },
        { key: null, lines: trailing },
      );
      toSet.delete(entry.key);
    } else {
      blocks.push({ key: entry.key, lines: lines.slice(entry.start, end) }, { key: null, lines: trailing });
    }
  }
  // campos novos, na ordem canônica entre si
  const added = [...toSet.keys()].sort((a, b) => rankOf(a) - rankOf(b));
  for (const key of added) {
    const rank = rankOf(key);
    let at = blocks.length;
    if (rank !== Number.POSITIVE_INFINITY) {
      // logo depois do último campo que vem antes dele na ordem canônica; se não houver, no começo
      let last = 0;
      blocks.forEach((block, i) => {
        if (block.key !== null && rankOf(block.key) < rank) last = i;
      });
      at = last + 1;
    } else {
      // no fim, mas antes das linhas soltas finais
      while (at > 1 && blocks[at - 1]?.key === null) at--;
    }
    blocks.splice(at, 0, { key, lines: fieldLines(key, toSet.get(key)) });
  }

  const out = blocks.flatMap((block) => block.lines).join(eol);
  // rede de segurança: o texto editado tem de significar exatamente o que foi pedido
  try {
    const check = parseDocument(out);
    if (check.errors.length > 0 || !isDeepStrictEqual(check.toJS() ?? {}, expected)) return null;
  } catch {
    return null;
  }
  return out;
}
