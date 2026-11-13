// Leitor e editor de JSON com comentários (JSONC), sem dependências.
// Os arquivos de configuração dos clientes são do usuário: a edição mexe só no trecho necessário do texto e
// deixa comentários, ordem das chaves e formatação do resto como estavam.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonProp {
  key: string;
  keyStart: number;
  value: JsonNode;
  /** Posição da vírgula depois desta propriedade, quando há. */
  commaAfter: number | undefined;
}

export interface JsonObjectNode {
  type: 'object';
  start: number;
  end: number;
  props: JsonProp[];
}

export interface JsonArrayNode {
  type: 'array';
  start: number;
  end: number;
  items: JsonNode[];
}

export interface JsonScalarNode {
  type: 'scalar';
  start: number;
  end: number;
  value: string | number | boolean | null;
}

export type JsonNode = JsonObjectNode | JsonArrayNode | JsonScalarNode;

/** O texto não é JSON válido (com comentários e vírgula final tolerados). `line` e `column` começam em 1. */
export class JsoncError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(problem: string, text: string, offset: number) {
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    super(`${problem} (linha ${line}, coluna ${column})`);
    this.name = 'JsoncError';
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

const SCALAR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** Lê JSON aceitando comentários `//` e `/* *\/`, vírgula final e BOM. Guarda a posição de cada nó no texto. */
export function parseJsonc(text: string): JsonNode {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  function fail(problem: string, at: number = pos): never {
    throw new JsoncError(problem, text, at);
  }

  function skipBlank(): void {
    for (;;) {
      const ch = text[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        pos += 1;
      } else if (ch === '/' && text[pos + 1] === '/') {
        const newline = text.indexOf('\n', pos);
        pos = newline === -1 ? text.length : newline;
      } else if (ch === '/' && text[pos + 1] === '*') {
        const close = text.indexOf('*/', pos + 2);
        if (close === -1) fail('comentário sem fim');
        pos = close + 2;
      } else {
        return;
      }
    }
  }

  function parseString(): string {
    const start = pos;
    pos += 1;
    for (;;) {
      const ch = text[pos];
      if (ch === undefined || ch === '\n') fail('texto sem aspas de fechamento', start);
      if (ch === '\\') {
        pos += 2;
      } else if (ch === '"') {
        pos += 1;
        break;
      } else {
        pos += 1;
      }
    }
    try {
      return JSON.parse(text.slice(start, pos)) as string;
    } catch {
      return fail('texto inválido', start);
    }
  }

  function parseValue(): JsonNode {
    skipBlank();
    const start = pos;
    const ch = text[pos];
    if (ch === undefined) fail('o arquivo termina antes do esperado');

    if (ch === '{') {
      pos += 1;
      const props: JsonProp[] = [];
      for (;;) {
        skipBlank();
        if (text[pos] === undefined) fail('o arquivo termina antes do esperado');
        if (text[pos] === '}') break;
        if (text[pos] !== '"') fail('esperava uma chave entre aspas ou "}"');
        const keyStart = pos;
        const key = parseString();
        skipBlank();
        if (text[pos] !== ':') fail('esperava ":" depois da chave');
        pos += 1;
        const value = parseValue();
        skipBlank();
        let commaAfter: number | undefined;
        if (text[pos] === ',') {
          commaAfter = pos;
          pos += 1;
        } else if (text[pos] === undefined) {
          fail('o arquivo termina antes do esperado');
        } else if (text[pos] !== '}') {
          fail('esperava "," ou "}"');
        }
        props.push({ key, keyStart, value, commaAfter });
      }
      pos += 1;
      return { type: 'object', start, end: pos, props };
    }

    if (ch === '[') {
      pos += 1;
      const items: JsonNode[] = [];
      for (;;) {
        skipBlank();
        if (text[pos] === undefined) fail('o arquivo termina antes do esperado');
        if (text[pos] === ']') break;
        items.push(parseValue());
        skipBlank();
        if (text[pos] === ',') pos += 1;
        else if (text[pos] === undefined) fail('o arquivo termina antes do esperado');
        else if (text[pos] !== ']') fail('esperava "," ou "]"');
      }
      pos += 1;
      return { type: 'array', start, end: pos, items };
    }

    if (ch === '"') {
      const value = parseString();
      return { type: 'scalar', start, end: pos, value };
    }

    SCALAR.lastIndex = pos;
    const match = SCALAR.exec(text);
    if (match === null) fail('valor inesperado');
    pos += match[0].length;
    return { type: 'scalar', start, end: pos, value: JSON.parse(match[0]) as number | boolean | null };
  }

  const root = parseValue();
  skipBlank();
  if (pos < text.length) fail('há conteúdo depois do fim do documento');
  return root;
}

export function toValue(node: JsonNode): JsonValue {
  if (node.type === 'scalar') return node.value;
  if (node.type === 'array') return node.items.map(toValue);
  const result: { [key: string]: JsonValue } = {};
  for (const prop of node.props) result[prop.key] = toValue(prop.value);
  return result;
}

/** A última propriedade com essa chave (é a que vale quando há repetição). */
export function findProp(node: JsonObjectNode, key: string): JsonProp | undefined {
  return node.props.findLast((prop) => prop.key === key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Igualdade estrutural de valores JSON; a ordem das chaves não importa. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** Os espaços que abrem a linha onde `offset` está. */
function lineIndent(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset), offset))?.[0] ?? '';
}

/** Verdadeiro quando só há espaços entre o começo da linha e `offset`. */
function startsItsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset));
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function detectIndentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
}

function render(value: JsonValue, unit: string, indent: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
}

/**
 * Tamanho do comentário de linha que segue `from` na mesma linha (0 se não há). Ele pertence à propriedade
 * que termina ali, então a propriedade nova entra depois dele.
 */
function trailingLineComment(text: string, from: number, to: number): number {
  return /^[ \t]*\/\/[^\r\n]*/.exec(text.slice(from, to))?.[0].length ?? 0;
}

export function insertProp(text: string, object: JsonObjectNode, key: string, value: JsonValue): TextEdit[] {
  const eol = detectEol(text);
  const unit = detectIndentUnit(text);
  const last = object.props.at(-1);

  if (last === undefined) {
    const objectIndent = lineIndent(text, object.start);
    const indent = objectIndent + unit;
    const entry = `${eol}${indent}${JSON.stringify(key)}: ${render(value, unit, indent, eol)}`;
    const inner = text.slice(object.start + 1, object.end - 1);
    if (inner.trim() === '') {
      return [{ start: object.start + 1, end: object.end - 1, text: `${entry}${eol}${objectIndent}` }];
    }
    // Objeto só com comentários: entra logo depois da chave de abertura, e os comentários ficam onde estavam.
    return [{ start: object.start + 1, end: object.start + 1, text: entry }];
  }

  if (!startsItsLine(text, last.keyStart)) {
    // Objeto escrito numa linha só: continua na mesma linha.
    const entry = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    if (last.commaAfter !== undefined) {
      return [{ start: last.commaAfter + 1, end: last.commaAfter + 1, text: ` ${entry},` }];
    }
    return [{ start: last.value.end, end: last.value.end, text: `, ${entry}` }];
  }

  const indent = lineIndent(text, last.keyStart);
  const entry = `${eol}${indent}${JSON.stringify(key)}: ${render(value, unit, indent, eol)}`;
  if (last.commaAfter !== undefined) {
    // O arquivo usa vírgula final: mantém o estilo.
    const anchor = last.commaAfter + 1 + trailingLineComment(text, last.commaAfter + 1, object.end - 1);
    return [{ start: anchor, end: anchor, text: `${entry},` }];
  }
  const comment = trailingLineComment(text, last.value.end, object.end - 1);
  if (comment === 0) return [{ start: last.value.end, end: last.value.end, text: `,${entry}` }];
  const anchor = last.value.end + comment;
  return [
    { start: last.value.end, end: last.value.end, text: ',' },
    { start: anchor, end: anchor, text: entry },
  ];
}

export function removeProp(text: string, object: JsonObjectNode, prop: JsonProp): TextEdit[] {
  const previous = object.props[object.props.indexOf(prop) - 1];
  if (!startsItsLine(text, prop.keyStart)) {
    // Propriedade que divide a linha com outras: tira também o espaço que a separava da vizinha.
    if (prop.commaAfter !== undefined) {
      const spaces = /^[ \t]*/.exec(text.slice(prop.commaAfter + 1))?.[0].length ?? 0;
      return [{ start: prop.keyStart, end: prop.commaAfter + 1 + spaces, text: '' }];
    }
    if (previous?.commaAfter !== undefined && /^[ \t]*$/.test(text.slice(previous.commaAfter + 1, prop.keyStart))) {
      return [{ start: previous.commaAfter, end: prop.value.end, text: '' }];
    }
  }

  const edits: TextEdit[] = [];
  let start = prop.keyStart;
  let end = prop.value.end;
  if (prop.commaAfter !== undefined) {
    end = prop.commaAfter + 1;
  } else if (previous?.commaAfter !== undefined) {
    // Era a última: a vírgula da propriedade anterior fica sobrando.
    edits.push({ start: previous.commaAfter, end: previous.commaAfter + 1, text: '' });
  }
  if (startsItsLine(text, start)) {
    const rest = /^[ \t]*(\r?\n)?/.exec(text.slice(end))?.[0] ?? '';
    if (rest.endsWith('\n')) {
      // A propriedade ocupava linhas inteiras: some com elas.
      start = lineStart(text, start);
      end += rest.length;
    }
  }
  edits.push({ start, end, text: '' });
  return edits;
}

/**
 * Define `raiz[section][name] = value` mexendo só nesse trecho do texto. `root` é o resultado de
 * `parseJsonc(text)` e tem de ser um objeto; `raiz[section]`, se existir, também.
 */
export function setEntry(text: string, root: JsonObjectNode, section: string, name: string, value: JsonValue): string {
  const sectionProp = findProp(root, section);
  if (sectionProp === undefined) return applyEdits(text, insertProp(text, root, section, { [name]: value }));
  if (sectionProp.value.type !== 'object') throw new TypeError(`"${section}" não é um objeto`);
  const existing = findProp(sectionProp.value, name);
  if (existing === undefined) return applyEdits(text, insertProp(text, sectionProp.value, name, value));
  const indent = lineIndent(text, existing.keyStart);
  const rendered = startsItsLine(text, existing.keyStart)
    ? render(value, detectIndentUnit(text), indent, detectEol(text))
    : JSON.stringify(value);
  return applyEdits(text, [{ start: existing.value.start, end: existing.value.end, text: rendered }]);
}

/** Tira `raiz[section][name]` do texto. Devolve o texto igual se a entrada não existe. */
export function removeEntry(text: string, root: JsonObjectNode, section: string, name: string): string {
  const sectionProp = findProp(root, section);
  if (sectionProp === undefined || sectionProp.value.type !== 'object') return text;
  const sectionNode = sectionProp.value;
  // Com chave repetida, todas saem; a posição de cada uma continua valendo porque as edições não se cruzam.
  const edits = sectionNode.props
    .filter((prop) => prop.key === name)
    .flatMap((prop) => removeProp(text, sectionNode, prop));
  return applyEdits(text, edits);
}
