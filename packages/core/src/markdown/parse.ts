// Parser próprio de notas Markdown no estilo do Obsidian (decisão 19): varredura linha a linha, sem AST.
// Não é um parser CommonMark. Ele acha frontmatter, títulos, links e fronteiras de bloco, que é o que o índice usa.
import type { Block, TextSpan } from './chunks.ts';
import {
  buildContextPrefix,
  buildEmbedText,
  computeChunkKey,
  DEFAULT_CHUNK_TOKENS,
  estimateTokens,
  packBlocks,
} from './chunks.ts';
import { splitFrontmatter } from './frontmatter.ts';
import type { OpenComment } from './links.ts';
import { findMarkdownLinks, findWikiLinks, maskLine } from './links.ts';
import type {
  Chunk,
  Heading,
  HeadingLevel,
  MarkdownLink,
  ParsedNote,
  ParseNoteOptions,
  Section,
  WikiLink,
} from './types.ts';

const ATX_OPENING_RE = /^ {0,3}(#{1,6})(?=[ \t])/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// Cerca de código com qualquer indentação e dentro de citação ("> ```"): cobre cercas em itens de lista.
const FENCE_RE = /^[ \t]*((?:>[ \t]*)*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const QUOTE_RE = /^ {0,3}>/;

interface OpenFence {
  readonly char: string;
  readonly length: number;
  /** A cerca abriu dentro de uma citação; a primeira linha fora da citação a encerra. */
  readonly quoted: boolean;
}

/** Largura da indentação, com a tabulação indo até a próxima coluna múltipla de 4. */
function indentWidth(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 32) width++;
    else if (code === 9) width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Tira do título as marcas de código (crases) e de ênfase com asterisco. */
function plainHeadingText(text: string): string {
  return text.replace(/`+([^`]*)`+/g, '$1').replace(/(\*{1,3})(?=\S)([^*]+?)(?<=\S)\1/g, '$2');
}

/**
 * Lê um título ATX (`## Título` ou `## Título ##`). Devolve `null` se a linha não for título ou se o título for vazio.
 * O fim da linha é tratado à mão, e não por regex, para o custo ser linear mesmo com milhares de espaços.
 */
function parseAtxHeading(line: string): { level: HeadingLevel; text: string } | null {
  const opening = ATX_OPENING_RE.exec(line);
  if (opening === null) return null;
  const rest = line.slice(opening[0].length).trim();
  // sequência de fechamento: `#`s no fim, separados do texto por espaço
  let end = rest.length;
  while (end > 0 && rest.charCodeAt(end - 1) === 35) end--;
  const closed = end === 0 || rest.charCodeAt(end - 1) === 32 || rest.charCodeAt(end - 1) === 9;
  const text = plainHeadingText(closed ? rest.slice(0, end).trimEnd() : rest);
  return text === '' ? null : { level: (opening[1] ?? '#').length as HeadingLevel, text };
}

/** Link ainda sem seção; a seção é resolvida pela linha depois da varredura. */
type Unplaced<T> = Omit<T, 'headingPath'>;

/**
 * Lê uma nota: frontmatter, títulos, seções, links e trechos.
 * Nunca lança por causa do conteúdo: frontmatter inválido vem em `frontmatterError`, e o corpo é lido do mesmo jeito.
 */
export function parseNote(text: string, options: ParseNoteOptions = {}): ParsedNote {
  const targetTokens = options.targetTokens ?? DEFAULT_CHUNK_TOKENS;
  const frontmatter = splitFrontmatter(text);
  const lines = frontmatter.body.split(/\r?\n/);
  const firstLine = frontmatter.bodyStartLine;

  const headings: Heading[] = [];
  const wikiLinks: Unplaced<WikiLink>[] = [];
  const markdownLinks: Unplaced<MarkdownLink>[] = [];
  const spans: { span: TextSpan; headingPath: readonly string[] }[] = [];

  let stack: Heading[] = [];
  let headingPath: readonly string[] = [];
  let sectionBlocks: Block[] = [];

  // bloco em construção (linhas seguidas, sem linha em branco no meio)
  let blockLines: string[] = [];
  let blockStart = 0;
  let blockIsCode = false;
  // o bloco só tem linhas de texto corrido, então um sublinhado `===`/`---` faz dele um título setext
  let setextCandidate = false;

  let fence: OpenFence | null = null;
  let comment: OpenComment | null = null;
  let indentedCode = false;
  // coluna em que começa o conteúdo do item de lista mais recente, ou -1 fora de lista
  let listContentIndent = -1;
  let firstContentLine = 0;

  const lineNumber = (index: number): number => firstLine + index;

  const startBlockIfEmpty = (index: number): void => {
    if (blockLines.length > 0) return;
    blockStart = index;
    blockIsCode = false;
    setextCandidate = false;
  };

  const endBlock = (): void => {
    if (blockLines.length > 0) {
      const blockText = blockLines.join('\n').trimEnd();
      if (blockText.trim() !== '') {
        sectionBlocks.push({
          text: blockText,
          startLine: lineNumber(blockStart),
          endLine: lineNumber(blockStart) + blockLines.length - 1,
          code: blockIsCode,
        });
      }
    }
    blockLines = [];
    indentedCode = false;
    setextCandidate = false;
  };

  const endSection = (): void => {
    endBlock();
    for (const span of packBlocks(sectionBlocks, targetTokens)) spans.push({ span, headingPath });
    sectionBlocks = [];
  };

  const openHeading = (level: HeadingLevel, title: string, index: number, style: Heading['style']): void => {
    stack = stack.filter((ancestor) => ancestor.level < level);
    const heading: Heading = {
      level,
      text: title,
      headingPath: [...stack.map((ancestor) => ancestor.text), title],
      line: lineNumber(index),
      style,
    };
    stack.push(heading);
    headings.push(heading);
    headingPath = heading.headingPath;
    listContentIndent = -1;
  };

  /** Mascara a linha, atualiza o estado de comentário e guarda os links que sobraram. */
  const scanInline = (line: string, index: number): void => {
    if (comment === null && !line.includes('[') && !line.includes('%%') && !line.includes('<!--')) return;
    const masked = maskLine(line, comment);
    comment = masked.open;
    for (const link of findWikiLinks(masked.text)) {
      const { index: at, ...rest } = link;
      wikiLinks.push({ ...rest, line: lineNumber(index), column: at + 1 });
    }
    for (const link of findMarkdownLinks(masked.text, line)) {
      const { index: at, ...rest } = link;
      markdownLinks.push({ ...rest, line: lineNumber(index), column: at + 1 });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (fence !== null) {
      if (fence.quoted && !QUOTE_RE.test(line)) {
        // a citação acabou sem fechar a cerca: a cerca acaba junto e a linha é lida normalmente
        fence = null;
        endBlock();
      } else {
        blockLines.push(line);
        const closing = FENCE_RE.exec(line);
        if (
          closing !== null &&
          closing[2]?.[0] === fence.char &&
          (closing[2]?.length ?? 0) >= fence.length &&
          (closing[3] ?? '').trim() === ''
        ) {
          fence = null;
        }
        continue;
      }
    }

    if (comment !== null) {
      // comentário de várias linhas: o texto fica no bloco, mas não gera título nem link (até fechar)
      startBlockIfEmpty(i);
      setextCandidate = false;
      blockLines.push(line);
      scanInline(line, i);
      continue;
    }

    const opening = FENCE_RE.exec(line);
    // em cerca de crase, a "info string" não pode ter crase: ```x``` na mesma linha é código inline
    if (opening !== null && !(opening[2]?.[0] === '`' && (opening[3] ?? '').includes('`'))) {
      startBlockIfEmpty(i);
      blockIsCode = true;
      setextCandidate = false;
      indentedCode = false;
      fence = { char: opening[2]?.[0] ?? '`', length: opening[2]?.length ?? 3, quoted: opening[1] !== '' };
      blockLines.push(line);
      if (firstContentLine === 0) firstContentLine = lineNumber(i);
      continue;
    }

    const first = line.charCodeAt(0);
    const atx = first === 35 /* # */ || first === 32 ? parseAtxHeading(line) : null;
    if (atx !== null) {
      endSection();
      openHeading(atx.level, atx.text, i, 'atx');
      scanInline(line, i);
      continue;
    }

    if (line.trim() === '') {
      endBlock();
      continue;
    }
    if (firstContentLine === 0) firstContentLine = lineNumber(i);

    if ((first === 61 /* = */ || first === 45 /* - */ || first === 32) && SETEXT_UNDERLINE_RE.test(line)) {
      if (setextCandidate && blockLines.length > 0) {
        // título setext: o parágrafo acumulado vira o título (`===` nível 1, `---` nível 2)
        const title = plainHeadingText(blockLines.map((l) => l.trim()).join(' '));
        const start = blockStart;
        blockLines = [];
        endSection();
        openHeading(line.trim().startsWith('=') ? 1 : 2, title, start, 'setext');
        continue;
      }
    }
    if (THEMATIC_BREAK_RE.test(line)) {
      // linha horizontal: separa blocos e não entra em nenhum trecho
      endBlock();
      continue;
    }

    const indent = indentWidth(line);
    if (indentedCode) {
      if (indent >= 4) {
        blockLines.push(line);
        continue;
      }
      indentedCode = false;
    }
    // código indentado só começa um bloco; dentro de lista, a indentação conta a partir do conteúdo do item
    if (blockLines.length === 0 && indent >= 4 && (listContentIndent === -1 || indent >= listContentIndent + 4)) {
      startBlockIfEmpty(i);
      blockIsCode = true;
      indentedCode = true;
      blockLines.push(line);
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item !== null) {
      listContentIndent = indentWidth(item[1] ?? '') + (item[2] ?? '').length + 1;
    } else if (indent === 0) {
      listContentIndent = -1;
    }

    const plainText = item === null && first !== 124 /* | */ && !QUOTE_RE.test(line);
    const startsBlock = blockLines.length === 0;
    startBlockIfEmpty(i);
    setextCandidate = plainText && (startsBlock || setextCandidate);
    blockLines.push(line);
    scanInline(line, i);
    if (comment !== null) setextCandidate = false;
  }
  endSection();

  const lastLine = lineNumber(lines.length - 1) - (lines.length > 1 && lines[lines.length - 1] === '' ? 1 : 0);
  const sections: Section[] = [];
  const firstHeading = headings[0];
  if (firstContentLine !== 0 && (firstHeading === undefined || firstContentLine < firstHeading.line)) {
    sections.push({
      heading: null,
      headingPath: [],
      startLine: firstContentLine,
      endLine: firstHeading === undefined ? lastLine : firstHeading.line - 1,
    });
  }
  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    sections.push({
      heading,
      headingPath: heading.headingPath,
      startLine: heading.line,
      endLine: next === undefined ? lastLine : next.line - 1,
    });
  });

  // a seção de cada link é a do último título que começa na linha do link ou antes dela
  const placer = (): ((line: number) => readonly string[]) => {
    let cursor = -1;
    return (line) => {
      while ((headings[cursor + 1]?.line ?? Number.POSITIVE_INFINITY) <= line) cursor++;
      return headings[cursor]?.headingPath ?? [];
    };
  };
  const placeWiki = placer();
  const placeMarkdown = placer();

  const frontmatterTitle = frontmatter.data.title;
  const title =
    (typeof frontmatterTitle === 'string' && frontmatterTitle.trim() !== '' ? frontmatterTitle.trim() : null) ??
    (typeof frontmatterTitle === 'number' ? String(frontmatterTitle) : null) ??
    headings.find((heading) => heading.level === 1)?.text ??
    options.fallbackTitle ??
    null;

  const chunks: Chunk[] = spans.map(({ span, headingPath: path }, ord) => {
    const contextPrefix = buildContextPrefix(title, path);
    const embedText = buildEmbedText(contextPrefix, span.text);
    return {
      ord,
      headingPath: path,
      contextPrefix,
      text: span.text,
      embedText,
      tokenCount: estimateTokens(span.text),
      chunkKey: computeChunkKey(embedText),
      startLine: span.startLine,
      endLine: span.endLine,
    };
  });

  return {
    hasFrontmatter: frontmatter.hasFrontmatter,
    frontmatter: frontmatter.data,
    frontmatterError: frontmatter.error,
    body: frontmatter.body,
    bodyStartLine: frontmatter.bodyStartLine,
    title,
    headings,
    sections,
    links: wikiLinks.map((link) => ({ ...link, headingPath: placeWiki(link.line) })),
    markdownLinks: markdownLinks.map((link) => ({ ...link, headingPath: placeMarkdown(link.line) })),
    frontmatterLinks: frontmatter.links,
    chunks,
  };
}
