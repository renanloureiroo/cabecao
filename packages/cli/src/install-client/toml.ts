// Edição cuidadosa de TOML, sem dependências e sem reescrever o arquivo.
// Não é um parser completo: ele só reconhece a estrutura (cabeçalhos de tabela e pares chave = valor, pulando
// textos, arrays e tabelas inline) para achar e trocar UMA tabela. Todo o resto do arquivo fica byte a byte igual.
// Quando a estrutura não é a esperada, ele recusa em vez de adivinhar.

/** O arquivo não pôde ser lido como TOML. `line` começa em 1. */
export class TomlError extends Error {
  readonly line: number;

  constructor(problem: string, text: string, offset: number) {
    const line = text.slice(0, offset).split('\n').length;
    super(`${problem} (linha ${line})`);
    this.name = 'TomlError';
    this.line = line;
  }
}

/** A tabela existe, mas escrita de um jeito que não dá para editar com segurança (inline, chave pontilhada). */
export class TomlUnsupportedError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'TomlUnsupportedError';
  }
}

interface HeaderStatement {
  kind: 'table' | 'array';
  path: string[];
  /** Começo da linha. */
  start: number;
  /** Depois da quebra de linha. */
  end: number;
}

interface PairStatement {
  kind: 'pair';
  path: string[];
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

type Statement = HeaderStatement | PairStatement;

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_VALUE = /[A-Za-z0-9_+.:-]+(?: \d{2}:[A-Za-z0-9_+.:-]+)?/y;

function scan(text: string): Statement[] {
  const statements: Statement[] = [];
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  function fail(problem: string, at: number = pos): never {
    throw new TomlError(problem, text, at);
  }

  function skipSpaces(): void {
    while (text[pos] === ' ' || text[pos] === '\t') pos += 1;
  }

  function skipComment(): void {
    if (text[pos] !== '#') return;
    const newline = text.indexOf('\n', pos);
    pos = newline === -1 ? text.length : newline;
  }

  /** Espaços, quebras de linha e comentários: o que pode haver dentro de um array. */
  function skipBlank(): void {
    for (;;) {
      const ch = text[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') pos += 1;
      else if (ch === '#') skipComment();
      else return;
    }
  }

  function endLine(): void {
    skipSpaces();
    skipComment();
    if (text[pos] === '\r') pos += 1;
    if (pos >= text.length) return;
    if (text[pos] !== '\n') fail('esperava o fim da linha');
    pos += 1;
  }

  function quoted(quote: '"' | "'"): string {
    const start = pos;
    pos += 1;
    for (;;) {
      const ch = text[pos];
      if (ch === undefined || ch === '\n') fail('texto sem aspas de fechamento', start);
      if (ch === '\\' && quote === '"') {
        pos += 2;
      } else if (ch === quote) {
        pos += 1;
        break;
      } else {
        pos += 1;
      }
    }
    const raw = text.slice(start + 1, pos - 1);
    if (quote === "'") return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  }

  function multiline(quote: '"' | "'"): void {
    const start = pos;
    const fence = quote.repeat(3);
    pos += 3;
    for (;;) {
      const ch = text[pos];
      if (ch === undefined) fail('texto de várias linhas sem fechamento', start);
      if (ch === '\\' && quote === '"') {
        pos += 2;
      } else if (text.startsWith(fence, pos)) {
        pos += 3;
        // Até duas aspas a mais ainda fazem parte do conteúdo.
        for (let extra = 0; extra < 2 && text[pos] === quote; extra++) pos += 1;
        return;
      } else {
        pos += 1;
      }
    }
  }

  function key(): string[] {
    const path: string[] = [];
    for (;;) {
      skipSpaces();
      const ch = text[pos];
      if (ch === '"' || ch === "'") {
        path.push(quoted(ch));
      } else {
        BARE_KEY.lastIndex = pos;
        const match = BARE_KEY.exec(text);
        if (match === null) fail('esperava uma chave');
        path.push(match[0]);
        pos += match[0].length;
      }
      skipSpaces();
      if (text[pos] !== '.') return path;
      pos += 1;
    }
  }

  function value(): void {
    const ch = text[pos];
    if (ch === '"' || ch === "'") {
      if (text.startsWith(ch.repeat(3), pos)) multiline(ch);
      else quoted(ch);
      return;
    }
    if (ch === '[') {
      const start = pos;
      pos += 1;
      for (;;) {
        skipBlank();
        if (text[pos] === undefined) fail('array sem fechamento', start);
        if (text[pos] === ']') break;
        value();
        skipBlank();
        if (text[pos] === undefined) fail('array sem fechamento', start);
        if (text[pos] === ',') pos += 1;
        else if (text[pos] !== ']') fail('esperava "," ou "]"');
      }
      pos += 1;
      return;
    }
    if (ch === '{') {
      const start = pos;
      pos += 1;
      for (;;) {
        skipBlank();
        if (text[pos] === undefined) fail('tabela inline sem fechamento', start);
        if (text[pos] === '}') break;
        key();
        if (text[pos] !== '=') fail('esperava "=" depois da chave');
        pos += 1;
        skipSpaces();
        value();
        skipBlank();
        if (text[pos] === ',') pos += 1;
        else if (text[pos] !== '}') fail('esperava "," ou "}"');
      }
      pos += 1;
      return;
    }
    // Número, booleano, `inf`/`nan` ou data. Um espaço só é aceito entre data e hora (`1979-05-27 07:32:00`).
    BARE_VALUE.lastIndex = pos;
    const match = BARE_VALUE.exec(text);
    if (match === null) fail('esperava um valor');
    pos += match[0].length;
  }

  for (;;) {
    skipBlank();
    if (pos >= text.length) return statements;
    const start = text.lastIndexOf('\n', pos - 1) + 1;
    if (text[pos] === '[') {
      const array = text[pos + 1] === '[';
      pos += array ? 2 : 1;
      const path = key();
      if (!text.startsWith(array ? ']]' : ']', pos)) fail('cabeçalho de tabela sem fechamento');
      pos += array ? 2 : 1;
      endLine();
      statements.push({ kind: array ? 'array' : 'table', path, start, end: pos });
    } else {
      const path = key();
      if (text[pos] !== '=') fail('esperava "=" depois da chave');
      pos += 1;
      skipSpaces();
      const valueStart = pos;
      value();
      const valueEnd = pos;
      endLine();
      statements.push({ kind: 'pair', path, start, end: pos, valueStart, valueEnd });
    }
  }
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

interface Section {
  /** `undefined` para os pares soltos antes do primeiro cabeçalho. */
  header: HeaderStatement | undefined;
  pairs: PairStatement[];
}

function sections(statements: readonly Statement[]): Section[] {
  const result: Section[] = [{ header: undefined, pairs: [] }];
  for (const statement of statements) {
    if (statement.kind === 'pair') result.at(-1)?.pairs.push(statement);
    else result.push({ header: statement, pairs: [] });
  }
  return result;
}

interface Located {
  /** A tabela `[a.b]` em si. */
  main: Section | undefined;
  /** Subtabelas `[a.b.c]`. */
  children: Section[];
}

/** Acha a tabela `[...path]` e recusa quando ela (ou a mãe) está escrita de um jeito que não é uma tabela comum. */
function locate(text: string, path: readonly string[]): Located {
  const unsupported = (how: string): never => {
    throw new TomlUnsupportedError(
      `"${path.join('.')}" está declarado ${how}, um formato que o cabecao não edita com segurança`,
    );
  };

  let main: Section | undefined;
  const children: Section[] = [];
  for (const section of sections(scan(text))) {
    const at = section.header?.path ?? [];
    if (section.header?.kind === 'array' && startsWith(at, path)) unsupported('como array de tabelas');
    if (section.header !== undefined && sameArray(at, path)) {
      if (main !== undefined) unsupported('mais de uma vez');
      main = section;
    } else if (section.header !== undefined && startsWith(at, path)) {
      children.push(section);
    } else {
      // Pares de outra tabela que alcançam a nossa: `mcp_servers = {...}` e `mcp_servers.x.command = ...` na
      // raiz, ou `x = {...}` e `x.command = ...` dentro de `[mcp_servers]`.
      for (const pair of section.pairs) {
        const full = [...at, ...pair.path];
        if (startsWith(full, path)) unsupported('com chave pontilhada ou tabela inline');
        if (startsWith(path, full)) unsupported(`dentro de "${full.join('.')}", que não é uma tabela comum`);
      }
    }
  }
  return { main, children };
}

/** Texto TOML de um valor simples. O texto básico do TOML aceita os mesmos escapes do JSON. */
export function tomlValue(value: string | readonly string[]): string {
  if (typeof value !== 'string') return `[${value.map((item) => tomlValue(item)).join(', ')}]`;
  return JSON.stringify(value).replaceAll('\u007f', '\\u007F');
}

function headerLine(path: readonly string[]): string {
  return `[${path.map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : tomlValue(part))).join('.')}]`;
}

/** O bloco de uma tabela nova, como o `--print` mostra e como ele entra num arquivo que ainda não a tem. */
export function tomlTable(
  path: readonly string[],
  entries: Readonly<Record<string, string | readonly string[]>>,
  eol = '\n',
): string {
  const lines = [headerLine(path), ...Object.entries(entries).map(([key, value]) => `${key} = ${tomlValue(value)}`)];
  return `${lines.join(eol)}${eol}`;
}

export function hasTomlTable(text: string, path: readonly string[]): boolean {
  const { main, children } = locate(text, path);
  return main !== undefined || children.length > 0;
}

/**
 * Define as chaves `entries` na tabela `[...path]`. Se a tabela existe, troca só o valor dessas chaves e deixa
 * as outras (e as subtabelas, como `env`) como estavam; se não existe, acrescenta no fim do arquivo.
 */
export function setTomlTable(
  text: string,
  path: readonly string[],
  entries: Readonly<Record<string, string | readonly string[]>>,
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const { main } = locate(text, path);

  if (main?.header === undefined) {
    const block = tomlTable(path, entries, eol);
    if (text.trim() === '') return block;
    const body = text.endsWith('\n') ? text : `${text}${eol}`;
    return `${body}${/\n\r?\n$/.test(body) ? '' : eol}${block}`;
  }

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const missing: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const pair = main.pairs.findLast((candidate) => candidate.path.length === 1 && candidate.path[0] === key);
    if (pair === undefined) missing.push(`${key} = ${tomlValue(value)}${eol}`);
    else edits.push({ start: pair.valueStart, end: pair.valueEnd, text: tomlValue(value) });
  }
  if (missing.length > 0) {
    // O cabeçalho pode ser a última linha do arquivo, sem quebra no fim.
    const prefix = text.slice(main.header.start, main.header.end).endsWith('\n') ? '' : eol;
    edits.push({ start: main.header.end, end: main.header.end, text: `${prefix}${missing.join('')}` });
  }
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** Tira a tabela `[...path]` e as subtabelas dela. Devolve o texto igual se ela não existe. */
export function removeTomlTable(text: string, path: readonly string[]): string {
  const { main, children } = locate(text, path);
  const spans = [main, ...children]
    .filter((section): section is Section & { header: HeaderStatement } => section?.header !== undefined)
    .map((section) => ({ start: section.header.start, end: section.pairs.at(-1)?.end ?? section.header.end }))
    .sort((a, b) => b.start - a.start);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let result = text;
  for (const span of spans) {
    const before = result.slice(0, span.start);
    const after = result.slice(span.end);
    // Não deixa um buraco de linhas em branco onde a tabela estava: no máximo uma, e só se já havia.
    const head = before.trim() === '' ? '' : before.replace(/(\r?\n)(?:[ \t]*\r?\n)+$/, '$1');
    const tail = after.replace(/^(?:[ \t]*\r?\n)+/, '');
    const hadGap = head !== before || tail !== after;
    result = head + (head !== '' && tail !== '' && hadGap ? eol : '') + tail;
  }
  return result;
}
