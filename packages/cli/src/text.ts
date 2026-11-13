// Pequenos ajudantes de texto para a saída dos comandos no terminal.

/** `1 nota`, `3 notas`. */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Data ISO 8601 como `AAAA-MM-DD HH:mm`, no fuso desta máquina. Texto que não é data volta como veio. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Recuo de todas as linhas de um bloco. */
export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${prefix}${line}`))
    .join('\n');
}

/** Caminho para o terminal: o que está dentro da pasta do usuário aparece como `~/...` (como o `gh` mostra). */
export function displayPath(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path;
  const base = home.replace(/[\\/]+$/, '');
  if (path === base) return '~';
  for (const sep of ['/', '\\']) {
    if (path.startsWith(`${base}${sep}`)) return `~${sep}${path.slice(base.length + 1)}`;
  }
  return path;
}

/** Duração para o terminal: `40 s`, `12 min`, `3 h`, `2 dias`. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h`;
  return plural(Math.round(hours / 24), 'dia', 'dias');
}

const leading = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;
const LIST_ITEM = /^(?:\d+\.|-|\*)\s/;
const LABEL = /^[a-z][\w -]{0,24}:\s/;

/** Palavras de uma linha, sem separar o que está entre colchetes, sinais de menor e maior ou aspas. */
export function words(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of line) {
    if (quote !== '') {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"') quote = char;
    if (char === '[' || char === '<') depth += 1;
    if ((char === ']' || char === '>') && depth > 0) depth -= 1;
    if (char === ' ' && depth === 0) {
      if (current !== '') out.push(current);
      current = '';
    } else current += char;
  }
  if (current !== '') out.push(current);
  return out;
}

/** Junta palavras em linhas de até `width` colunas: a primeira com `first` na frente, as outras com `rest`. */
export function fill(items: readonly string[], width: number, first: string, rest: string): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const item of items) {
    const candidate = empty ? `${line}${item}` : `${line} ${item}`;
    if (!empty && candidate.length > width) {
      lines.push(line);
      line = `${rest}${item}`;
    } else line = candidate;
    empty = false;
  }
  lines.push(line);
  return lines;
}

/**
 * Reflui um texto escrito com quebras fixas para `width` colunas. Parágrafos são separados por linha em branco, item
 * de lista (`1.`, `-`) ou rótulo (`on: ...`) depois de uma frase terminada; as linhas mais recuadas que a primeira
 * continuam o parágrafo e dão o recuo das linhas seguintes. Nada que estava entre colchetes ou aspas é quebrado.
 */
export function reflow(text: string, width: number): string {
  const paragraphs: string[][] = [];
  let current: string[] | null = null;
  let previous = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const startsNew =
      current === null ||
      trimmed === '' ||
      previous.trim() === '' ||
      LIST_ITEM.test(trimmed) ||
      (LABEL.test(trimmed) && /[.:;]$/.test(previous.trim()));
    if (trimmed === '') {
      paragraphs.push(['']);
      current = null;
    } else if (startsNew || current === null) {
      current = [line];
      paragraphs.push(current);
    } else current.push(line);
    previous = line;
  }
  return paragraphs
    .map((lines) => {
      const [head = ''] = lines;
      if (head.trim() === '') return '';
      const indent = ' '.repeat(leading(head));
      const second = lines[1];
      const marker = /^(?:\d+\.|-|\*)\s+/.exec(head.trim())?.[0].length ?? 0;
      const hanging =
        second !== undefined && leading(second) > leading(head)
          ? ' '.repeat(leading(second))
          : ' '.repeat(leading(head) + (marker > 0 ? marker : LABEL.test(head.trim()) ? 4 : 0));
      const all = lines.flatMap((line) => words(line.trim()));
      return fill(all, width, indent, hanging).join('\n');
    })
    .join('\n');
}

/** Uma linha que pode passar da largura: quebra mantendo `hanging` de recuo nas seguintes. */
export function wrapLine(line: string, width: number, hanging: string): string {
  if (line.length <= width) return line;
  const indent = ' '.repeat(leading(line));
  return fill(words(line.trim()), width, indent, hanging).join('\n');
}

/** Tamanho em bytes para o terminal: `812 B`, `14,2 kB`, `7,8 MB` (potências de 1000, como o `npm pack`). */
export function formatBytes(bytes: number): string {
  const units: readonly [number, string][] = [
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'kB'],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) return `${(bytes / size).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${unit}`;
  }
  return `${bytes} B`;
}
