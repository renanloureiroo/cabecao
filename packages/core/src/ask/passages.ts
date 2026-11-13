// Recuperação do `ask`: a busca existente (híbrida quando há embeddings, com `as_of`, escopo e tipos) e, para cada nota
// encontrada, a SEÇÃO do melhor trecho lida do disco, cortada em janelas de ~350 tokens (o mesmo tamanho dos trechos
// da busca). Até 2 janelas por nota, escolhidas pelos termos da pergunta, e até 3 vizinhas do grafo no fim.
//
// Só usa a API pública do cérebro (`search` e `read`): funciona igual na CLI (como o usuário) e no servidor MCP (como
// agente), sem acesso direto ao banco.
import type { Brain } from '../brain/brain.ts';
import type { ReadOutput, SearchInput, SearchOutput } from '../brain/read.ts';
import type { Validity } from '../db/search.ts';
import { DEFAULT_CHUNK_TOKENS, HEADING_PATH_SEPARATOR } from '../markdown/chunks.ts';
import { scanSecrets } from '../security/scan.ts';
import { hasPrivateBodyTag } from './policy.ts';

/** O que o `ask` usa do cérebro aberto. */
export type AskBrain = Pick<Brain, 'search' | 'read' | 'config' | 'privateNotes'>;

export interface AskInput {
  readonly question: string;
  readonly scope?: string;
  readonly types?: readonly string[];
  readonly as_of?: string;
  /** Máximo de notas que contribuem trechos (padrão 10, de 1 a 20). */
  readonly limit?: number;
}

export const DEFAULT_ASK_LIMIT = 10;
export const MAX_ASK_LIMIT = 20;
export const MAX_QUESTION_CHARS = 2000;
/** Quantas notas a busca devolve antes do filtro (a pré-checagem e o filtro ainda tiram algumas). */
export const ASK_SEARCH_LIMIT = 30;
/** Tamanho de uma janela de texto: ~350 tokens, como os trechos dos embeddings. */
export const PASSAGE_CHARS = DEFAULT_CHUNK_TOKENS * 4;
export const PASSAGES_PER_NOTE = 2;
export const RELATED_PASSAGES = 3;

/** Um trecho recuperado, com identificação, validade e proveniência. */
export interface Passage {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly scope: string | null;
  /** Seção de onde o texto veio (vazia: começo da nota). Passe a `read` como `section` para abrir o original. */
  readonly heading_path: readonly string[];
  readonly validity: Validity;
  readonly trust: string | null;
  readonly origin: string | null;
  readonly edited_by: string | null;
  /** `updated` do frontmatter, quando há. */
  readonly updated: string | null;
  /** Data em que deixou de valer (`valid_until` ou `expires_at`), quando há. */
  readonly ended_on: string | null;
  /** Data em que passa a valer (`valid_from`), quando há. */
  readonly starts_on: string | null;
  /** Entrou como vizinha no grafo dos melhores resultados, não pela busca. */
  readonly related: boolean;
  /** Pontuação da busca (`null` nas vizinhas do grafo). */
  readonly score: number | null;
  /** O texto, exatamente como está na nota. */
  readonly content: string;
  /** Frontmatter da nota (para o filtro de `private`); não vai para a saída. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** O frontmatter da nota não pôde ser lido: na dúvida, o trecho não sai. */
  readonly unreadable: boolean;
  /** A nota tem a tag `#private` (ou `#private/...`) no corpo: é privada, como pelo frontmatter. */
  readonly bodyPrivate: boolean;
  /** O trecho cruza um segredo achado na NOTA INTEIRA (por exemplo, o meio de uma chave PEM que passa da janela). */
  readonly tainted: boolean;
}

export interface Retrieval {
  readonly search: SearchOutput;
  readonly passages: readonly Passage[];
}

/** Forma comparável de um texto: sem acentos, minúsculas, espaços colapsados, aspas retas. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Corta um texto em janelas de até `max` caracteres, nos parágrafos (ou, num parágrafo longo, no fim de frase). */
export function textWindows(
  text: string,
  max: number = PASSAGE_CHARS,
  avoid: ReadonlySet<string> = new Set(),
): string[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    let rest = paragraph;
    while (rest.length > max) {
      const slice = rest.slice(0, max);
      const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'), slice.lastIndexOf('; '));
      let at = cut > max * 0.3 ? cut + 1 : Math.max(slice.lastIndexOf(' '), Math.floor(max * 0.5));
      // nunca corta uma linha com segredo no meio: o corte vai para antes dela (ou, se ela abre o pedaço, depois dela)
      for (const secret of avoid) {
        const start = rest.indexOf(secret);
        if (start !== -1 && start < at && at < start + secret.length) at = start > 0 ? start : start + secret.length;
      }
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest !== '') pieces.push(rest);
  }
  const windows: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current !== '' && current.length + piece.length + 2 > max) {
      windows.push(current);
      current = piece;
    } else current = current === '' ? piece : `${current}\n\n${piece}`;
  }
  if (current !== '') windows.push(current);
  return windows;
}

function termsOf(search: SearchOutput, question: string): string[] {
  const fromSearch = search.terms.map((term) => normalizeForMatch(term.replace(/\*$/, ''))).filter((t) => t.length > 1);
  if (fromSearch.length > 0) return [...new Set(fromSearch)];
  return [
    ...new Set(
      normalizeForMatch(question)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 3),
    ),
  ];
}

function windowScore(text: string, terms: readonly string[]): number {
  const norm = normalizeForMatch(text);
  let score = 0;
  for (const term of terms) {
    if (norm.includes(term)) score += 1 + Math.min(4, norm.split(term).length - 2) * 0.1;
  }
  return score;
}

const dateText = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
};

interface NoteRef {
  readonly id: string;
  readonly path: string;
  readonly validity: Validity;
  readonly score: number | null;
  readonly headingPath: readonly string[];
  readonly related: boolean;
}

async function readSection(brain: AskBrain, ref: NoteRef): Promise<ReadOutput | null> {
  if (ref.headingPath.length > 0) {
    try {
      return await brain.read({ id: ref.id, section: ref.headingPath.join(HEADING_PATH_SEPARATOR) });
    } catch {
      // seção que não se resolve (títulos repetidos, nota mudou desde o índice): lê a nota inteira
    }
  }
  try {
    return await brain.read({ id: ref.id });
  } catch {
    try {
      return await brain.read({ path: ref.path });
    } catch {
      return null;
    }
  }
}

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/**
 * As linhas da nota inteira que fazem parte de um segredo: as que o scanner acusa e, num bloco de chave privada PEM,
 * todas do `BEGIN` ao `END` (o scanner só reconhece o cabeçalho, e o material do meio cairia numa janela sem ele).
 */
export function secretLines(body: string): Set<string> {
  const lines = body.split(/\r?\n/);
  const out = new Set<string>();
  for (const finding of scanSecrets(body, { honorAllowMarker: false })) {
    const line = lines[finding.line - 1]?.trim();
    if (line !== undefined && line !== '') out.add(line);
  }
  for (const match of body.matchAll(PEM_BLOCK)) {
    for (const line of match[0].split(/\r?\n/)) if (line.trim() !== '') out.add(line.trim());
  }
  return out;
}

function touchesSecret(window: string, secret: ReadonlySet<string>): boolean {
  if (secret.size === 0) return false;
  const lines = window
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.some((line, index) => {
    if (secret.has(line)) return true;
    // a janela cortada no meio de uma linha com segredo: o pedaço da ponta conta, de qualquer tamanho (um valor curto
    // sozinho na janela seguinte, por exemplo); no meio da janela, um pedaço longo também
    const edge = index === 0 || index === lines.length - 1;
    return [...secret].some((s) => (s.includes(line) && (edge || line.length >= 16)) || line.includes(s));
  });
}

async function passagesFor(brain: AskBrain, ref: NoteRef, terms: readonly string[], max: number): Promise<Passage[]> {
  const read = await readSection(brain, ref);
  if (read === null) return [];
  const note = read.note;
  // o segredo é procurado na nota inteira, não só na seção ou na janela
  let body = note.content;
  if (read.section !== null) {
    try {
      body = (await brain.read({ id: note.id })).note.content;
    } catch {
      // sem a nota inteira, fica a seção
    }
  }
  const secret = secretLines(body);
  const windows = textWindows(note.content, PASSAGE_CHARS, secret)
    .map((text, index) => ({ text, index, score: windowScore(text, terms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = windows.slice(0, 1);
  const second = windows[1];
  if (max > 1 && second !== undefined && second.score > 0) chosen.push(second);
  const fm = read.frontmatter;
  const headingPath = read.section === null ? [] : ref.headingPath;
  return chosen.map(
    (window): Passage => ({
      id: note.id,
      path: note.path,
      title: note.title,
      type: note.type,
      scope: note.scope,
      heading_path: [...headingPath],
      validity: ref.validity,
      trust: note.trust,
      origin: note.origin,
      edited_by: note.edited_by,
      updated: dateText(fm.updated),
      ended_on: dateText(fm.valid_until) ?? dateText(fm.expires_at),
      starts_on: dateText(fm.valid_from),
      related: ref.related,
      score: ref.score,
      content: window.text,
      frontmatter: fm,
      unreadable: read.frontmatter_error !== null,
      bodyPrivate: hasPrivateBodyTag(body),
      tainted: touchesSecret(window.text, secret),
    }),
  );
}

/** Busca e lê os trechos. Erro de argumento (tipo ou escopo inválido, data errada) vem da busca, como `BrainError`. */
export async function retrievePassages(brain: AskBrain, input: AskInput, limit: number): Promise<Retrieval> {
  const searchInput: SearchInput = {
    query: input.question,
    limit: ASK_SEARCH_LIMIT,
    ...(input.as_of === undefined ? {} : { as_of: input.as_of }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.types === undefined ? {} : { types: input.types }),
  };
  const search = await brain.search(searchInput);
  const terms = termsOf(search, input.question);
  const refs: NoteRef[] = search.hits.slice(0, limit).map((hit) => ({
    id: hit.id,
    path: hit.path,
    validity: hit.validity,
    score: hit.score,
    headingPath: hit.heading_path,
    related: false,
  }));
  const seen = new Set(refs.map((ref) => ref.id));
  for (const item of search.related) {
    if (refs.length >= limit + RELATED_PASSAGES || seen.has(item.id)) continue;
    if (refs.filter((ref) => ref.related).length >= RELATED_PASSAGES) break;
    seen.add(item.id);
    refs.push({ id: item.id, path: item.path, validity: item.validity, score: null, headingPath: [], related: true });
  }
  const passages: Passage[] = [];
  for (const ref of refs) passages.push(...(await passagesFor(brain, ref, terms, ref.related ? 1 : PASSAGES_PER_NOTE)));
  return { search, passages };
}
