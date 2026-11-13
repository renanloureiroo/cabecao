// API pública do parser de Markdown e frontmatter.
export {
  buildContextPrefix,
  buildEmbedText,
  computeChunkKey,
  DEFAULT_CHUNK_TOKENS,
  estimateTokens,
  formatHeadingPath,
  HEADING_PATH_SEPARATOR,
} from './chunks.ts';
export { type FrontmatterString, frontmatterStrings, splitFrontmatter } from './frontmatter.ts';
export { normalizeLinkTarget } from './links.ts';
export { parseNote } from './parse.ts';
export type {
  Chunk,
  FrontmatterError,
  FrontmatterErrorCode,
  FrontmatterLink,
  FrontmatterSplit,
  Heading,
  HeadingLevel,
  MarkdownLink,
  ParsedNote,
  ParseNoteOptions,
  Section,
  WikiLink,
} from './types.ts';
