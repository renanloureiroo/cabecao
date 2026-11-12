// Wikilinks e links Markdown dentro de uma linha, e a normalização de alvo para comparação.

// O alvo não aceita `[`, `]`, `|` nem `#`; a âncora vai até o `|`; o apelido vai até o `]]`.
const WIKILINK_RE = /(!?)\[\[([^[\]\n|#]*)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/g;
// Destino de um link Markdown, a partir do `(`: caminho sem espaço e título opcional entre aspas.
// Os limites de tamanho mantêm o custo linear em linhas hostis.
const MARKDOWN_DESTINATION_RE = /\(<?([^)\s>]{1,2048})>?(?:\s+"[^"]{0,1024}")?\)/y;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Comentário de várias linhas ainda aberto: o texto que o fecha. */
export type OpenComment = '%%' | '-->';

export interface MaskedLine {
  /** A linha com código inline, comentários e colchetes escapados trocados por espaços (mesmo comprimento). */
  readonly text: string;
  /** Comentário que continua aberto no fim da linha. */
  readonly open: OpenComment | null;
}

/** Wikilink como aparece no texto, ainda sem linha nem seção. */
export interface InlineWikiLink {
  readonly embed: boolean;
  readonly target: string;
  readonly anchor: string | null;
  readonly alias: string | null;
  /** Índice (a partir de 0) do começo do link no texto. */
  readonly index: number;
}

export interface InlineMarkdownLink {
  readonly embed: boolean;
  readonly target: string;
  readonly anchor: string | null;
  readonly text: string | null;
  readonly index: number;
}

/**
 * Normaliza o alvo de um link para comparação, como o Obsidian: forma Unicode NFC e minúsculas.
 * Também apara espaços e tira a extensão `.md`, para `[[Nota.md]]` e `[[nota]]` darem a mesma chave.
 * Use só para comparar; para exibir ou gravar, use o alvo original.
 */
export function normalizeLinkTarget(target: string): string {
  // `toLowerCase` não depende do idioma do sistema (ao contrário de `toLocaleLowerCase`).
  return target.trim().replace(/\.md$/i, '').normalize('NFC').toLowerCase();
}

const spaces = (count: number): string => ' '.repeat(count);

/** Tamanho da sequência de crases que começa em `from`. */
function backtickRun(line: string, from: number): number {
  let end = from;
  while (line.charCodeAt(end) === 96) end++;
  return end - from;
}

/** Posição logo depois do fechamento de um código inline aberto por `run` crases, ou -1 se não fecha na linha. */
function codeSpanEnd(line: string, from: number, run: number): number {
  let cursor = from;
  while (cursor < line.length) {
    const start = line.indexOf('`', cursor);
    if (start === -1) return -1;
    const length = backtickRun(line, start);
    if (length === run) return start + length;
    cursor = start + length;
  }
  return -1;
}

/**
 * Apaga de uma linha tudo o que não pode conter link: código inline, comentários `%%...%%` e `<!-- ... -->`
 * (inclusive os que continuam de linhas anteriores, em `open`) e colchetes escapados (`\[`).
 * O resultado tem o mesmo comprimento da linha, então os índices continuam valendo como colunas.
 */
export function maskLine(line: string, open: OpenComment | null): MaskedLine {
  let i = 0;
  let out = '';
  if (open !== null) {
    const end = line.indexOf(open);
    if (end === -1) return { text: spaces(line.length), open };
    i = end + open.length;
    out = spaces(i);
  } else if (!line.includes('`') && !line.includes('%%') && !line.includes('<!--') && !line.includes('\\')) {
    return { text: line, open: null };
  }
  let copied = i; // tudo antes de `copied` já está em `out`
  const blank = (until: number): void => {
    out += line.slice(copied, i) + spaces(until - i);
    i = until;
    copied = until;
  };
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === 92 /* \ */) {
      const next = line.charCodeAt(i + 1);
      // `\[` e `` \` `` deixam de ser sintaxe; os outros escapes ficam (o `\|` das tabelas é tratado no link)
      if (next === 91 || next === 96) blank(i + 2);
      else i += 2;
    } else if (code === 96 /* ` */) {
      const run = backtickRun(line, i);
      const end = codeSpanEnd(line, i + run, run);
      if (end === -1) i += run;
      else blank(end);
    } else if (code === 37 /* % */ && line.charCodeAt(i + 1) === 37) {
      const end = line.indexOf('%%', i + 2);
      if (end === -1) return { text: out + line.slice(copied, i) + spaces(line.length - i), open: '%%' };
      blank(end + 2);
    } else if (code === 60 /* < */ && line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      if (end === -1) return { text: out + line.slice(copied, i) + spaces(line.length - i), open: '-->' };
      blank(end + 3);
    } else {
      i++;
    }
  }
  return { text: out + line.slice(copied), open: null };
}

/** Wikilinks de um texto em que tudo é conteúdo (uma linha já mascarada ou um valor do frontmatter). */
export function findWikiLinks(text: string): InlineWikiLink[] {
  const found: InlineWikiLink[] = [];
  if (!text.includes('[[')) return found;
  for (const match of text.matchAll(WIKILINK_RE)) {
    // em tabelas o Obsidian escreve [[nota\|apelido]]: a barra de escape não faz parte do alvo
    const target = (match[2] ?? '').replace(/\\$/, '').trim();
    const anchor = match[3] === undefined ? null : match[3].replace(/\\$/, '').trim();
    if (target === '' && (anchor === null || anchor === '')) continue;
    const alias = match[4]?.trim();
    found.push({
      embed: match[1] === '!',
      target,
      anchor: anchor === '' ? null : anchor,
      alias: alias === undefined || alias === '' ? null : alias,
      index: match.index,
    });
  }
  return found;
}

/**
 * Links Markdown relativos de uma linha já mascarada. Links com esquema e âncoras locais (`#x`) são ignorados.
 * `original` é a linha antes da máscara (mesmo comprimento): o texto do link sai dela, para manter o código inline.
 */
export function findMarkdownLinks(text: string, original: string = text): InlineMarkdownLink[] {
  const found: InlineMarkdownLink[] = [];
  if (!text.includes('](')) return found;
  // os wikilinks saem antes, para `[[a]](b)` não virar link Markdown
  const clean = text.replace(WIKILINK_RE, (whole) => spaces(whole.length));
  // Parte de cada `](` e volta até o `[` mais próximo, sem passar do link anterior: custo linear no tamanho da
  // linha, mesmo em linhas hostis (uma regex que tentasse cada `[` seria quadrática).
  let floor = 0;
  for (let close = clean.indexOf(']('); close !== -1; close = clean.indexOf('](', floor)) {
    let open = close - 1;
    while (open >= floor && clean.charCodeAt(open) !== 91 /* [ */ && clean.charCodeAt(open) !== 93 /* ] */) open--;
    const searchFloor = floor;
    floor = close + 2;
    if (open < searchFloor || clean.charCodeAt(open) !== 91) continue;
    MARKDOWN_DESTINATION_RE.lastIndex = close + 1;
    const match = MARKDOWN_DESTINATION_RE.exec(clean);
    if (match === null) continue;
    floor = MARKDOWN_DESTINATION_RE.lastIndex;
    const href = match[1] ?? '';
    if (URL_SCHEME_RE.test(href) || href.startsWith('#')) continue;
    const hash = href.indexOf('#');
    const path = hash === -1 ? href : href.slice(0, hash);
    let target: string;
    try {
      target = decodeURIComponent(path);
    } catch {
      target = path;
    }
    const embed = open > 0 && clean.charCodeAt(open - 1) === 33; /* ! */
    const label = original.slice(open + 1, close);
    found.push({
      embed,
      target: target.replace(/\.md$/i, ''),
      anchor: hash === -1 ? null : href.slice(hash + 1),
      text: label === '' ? null : label,
      index: embed ? open - 1 : open,
    });
  }
  return found;
}
