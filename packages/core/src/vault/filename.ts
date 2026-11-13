// Nome de arquivo de uma nota nova, a partir do título. Tem de valer em Windows, macOS e Linux.
//
// A REGRA (o cérebro de exemplo mistura título legível e slug; esta é a regra que gera os dois):
//
// 1. Estilo pelo tipo (`FILE_NAME_STYLES`):
//    - título legível para o que NOMEIA uma coisa: source, concept, entity, synthesis (`Projeto Atlas.md`);
//    - slug para o que é uma frase: decision, rule, preference, gotcha, procedure, fact (`usar-sqs-para-filas.md`);
//    - data + slug para o que é um acontecimento: episode, handoff (`2026-11-10-atlas-consumidores.md`), com a data
//      do `created` (data local), sem repetir a data se o título já começa por ela.
// 2. Título legível: NFC; `< > : " / \ | ? * # ^ [ ]` e caracteres de controle viram espaço; espaços repetidos viram
//    um; espaços e pontos das pontas saem. Caixa e acentos ficam.
// 3. Slug: tira acento de letra latina (`ç` → `c`), minúsculas, e cada sequência de não letra/dígito vira `-`.
//    Letras de outros alfabetos ficam (um título em japonês não vira nome vazio).
// 4. No máximo 160 bytes de UTF-8 sem a extensão (corte em fronteira de caractere), para sobrar espaço para o
//    desempate e para o sufixo de cópia em conflito do sync dentro dos 255 bytes do Linux.
// 5. Nome de dispositivo do Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`, `LPT1`...) ganha `_` na frente.
// 6. Nada aproveitável no título: o `id` em minúsculas.
// 7. Colisão, comparando em NFC e sem diferenciar maiúsculas, com os arquivos da pasta de destino E com os nomes das
//    notas do cérebro inteiro (para `[[nome]]` não ficar ambíguo): `Nome 2.md`, `Nome 3.md`... no estilo legível e
//    `nome-2.md`, `nome-3.md`... nos slugs.
import { checkFileNameLength, normalizeNfc } from '../util/index.ts';
import type { NoteType } from './schema.ts';

/**
 * Estilo do nome por tipo, seguindo o que o cérebro de exemplo já faz:
 *
 * - `title`: o título legível (`Projeto Atlas.md`). Para páginas da wiki que nomeiam uma coisa, porque o nome do
 *   arquivo É o texto do wikilink (`[[Projeto Atlas]]`) e o nome que aparece no grafo do Obsidian.
 * - `slug`: minúsculas sem acento, com hífens (`usar-sqs-para-filas.md`). Para decisões e memórias, cujo título é
 *   uma frase.
 * - `dated-slug`: `AAAA-MM-DD-` + slug (`2026-11-10-migracao-dos-consumidores.md`). Para o que é um acontecimento.
 */
export type FileNameStyle = 'title' | 'slug' | 'dated-slug';

export const FILE_NAME_STYLES: Readonly<Record<NoteType, FileNameStyle>> = {
  source: 'title',
  concept: 'title',
  entity: 'title',
  synthesis: 'title',
  decision: 'slug',
  rule: 'slug',
  preference: 'slug',
  gotcha: 'slug',
  procedure: 'slug',
  fact: 'slug',
  episode: 'dated-slug',
  handoff: 'dated-slug',
};

/**
 * Tamanho máximo, em bytes de UTF-8, do nome SEM a extensão. Fica bem abaixo dos 255 do Linux para sobrar espaço
 * para `.md`, para o sufixo de desempate (`-2`) e para o sufixo que o sync põe numa cópia em conflito
 * (`.conflict-<máquina>-<data>`).
 */
export const MAX_NOTE_BASENAME_BYTES = 160;

// Proibidos no Windows (`<>:"/\|?*` e controles) e os que quebram wikilink no Obsidian (`#`, `^`, `[`, `]`).
// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const FORBIDDEN_RE = /[<>:"/\\|?*#^[\]\u0000-\u001f\u007f]+/g;
/** Nomes de dispositivo do Windows; valem com qualquer caixa e com qualquer extensão (`CON.md` também é reservado). */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Corta em fronteira de caractere para caber em `maxBytes` de UTF-8. */
function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/** Ajustes finais comuns aos dois estilos: pontas, nome reservado do Windows e tamanho. */
function finish(name: string, trim: RegExp): string {
  let out = truncateBytes(name.replace(trim, ''), MAX_NOTE_BASENAME_BYTES).replace(trim, '');
  // O Windows reserva o nome do dispositivo considerando só o que vem antes do primeiro ponto.
  if (WINDOWS_RESERVED_RE.test((out.split('.')[0] ?? '').trim())) out = `_${out}`;
  return out;
}

/**
 * Slug: minúsculas, sem acento nas letras latinas, e tudo que não é letra ou dígito vira hífen.
 * Letras de outros alfabetos são mantidas (um título em japonês não vira um nome vazio). Pode devolver vazio.
 */
export function slugify(text: string): string {
  const base = text
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-');
  return finish(base, /^-+|-+$/g);
}

/**
 * Título legível como nome de arquivo: mantém acentos, espaços e caixa; troca por espaço os caracteres proibidos no
 * Windows ou que quebram wikilink; tira espaços e pontos das pontas (o Windows ignora os do fim; ponto no começo
 * esconde o arquivo). Pode devolver vazio.
 */
export function sanitizeTitleFileName(title: string): string {
  const base = normalizeNfc(title).replace(FORBIDDEN_RE, ' ').replace(/\s+/g, ' ');
  return finish(base, /^[\s.]+|[\s.]+$/g);
}

export interface NoteFileNameInput {
  readonly type: NoteType;
  /** Título da nota (num fato sem título, o texto `sujeito predicado objeto`). */
  readonly title: string;
  /** Data `AAAA-MM-DD` para o estilo `dated-slug` (normalmente o `created`). */
  readonly date?: string;
  /** Usado quando o título não rende nenhum caractere aproveitável; normalmente o `id`. */
  readonly fallback: string;
}

/** Nome base (sem `.md` e sem sufixo de desempate) de uma nota nova. Nunca é vazio se `fallback` não for. */
export function noteBaseName(input: NoteFileNameInput): string {
  const style = FILE_NAME_STYLES[input.type];
  if (style === 'title') return sanitizeTitleFileName(input.title) || input.fallback.toLowerCase();
  const slug = slugify(input.title) || input.fallback.toLowerCase();
  if (style === 'slug') return slug;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(input.date ?? '')?.[0];
  // um título que já começa pela data não ganha a data de novo; com a data, o limite de bytes vale para o conjunto
  return date === undefined || slug.startsWith(date) ? slug : finish(`${date}-${slug}`, /^-+|-+$/g);
}

/** Chave de comparação de nomes de arquivo: NFC e minúsculas (macOS e Windows não diferenciam maiúsculas). */
export function fileNameKey(name: string): string {
  return normalizeNfc(name).toLowerCase();
}

/**
 * Devolve `base.md` ou, se já existe, `base-2.md`, `base-3.md`... (`base 2.md` no estilo `title`).
 * `taken` recebe o nome candidato já como chave (`fileNameKey`, sem `.md`).
 */
export function uniqueFileName(base: string, taken: (key: string) => boolean, separator: '-' | ' ' = '-'): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}${separator}${n}`;
    if (!taken(fileNameKey(candidate))) return `${candidate}.md`;
  }
}

// Só os proibidos no Windows (sem os de wikilink).
// biome-ignore lint/suspicious/noControlCharactersInRegex: os caracteres de controle são justamente o alvo
const WINDOWS_FORBIDDEN_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

/**
 * Por que o nome de uma PASTA do caminho de uma nota não serve, ou `null`. Uma pasta inválida no Windows (`aux`,
 * `a:b`, `pasta. `, `x|y?`) quebra o checkout naquela máquina e, com ele, o sync do cérebro inteiro.
 *
 * - Pasta que ainda não existe (`existing: false`, o padrão): as mesmas regras do nome de arquivo
 *   (`fileNameProblem`), inclusive `#`, `^`, `[` e `]`, que quebram o wikilink com caminho (`[[pasta/Nota]]`).
 * - Pasta que já existe: só as regras do Windows. Uma pasta do usuário como `C#` continua aceita; uma que já não
 *   funciona no Windows, não (gravar mais nela só aumenta o estrago).
 */
export function dirNameProblem(name: string, options: { readonly existing?: boolean } = {}): string | null {
  if (name === '') return 'o nome da pasta está vazio';
  if (name !== normalizeNfc(name)) return 'o nome da pasta não está em NFC';
  if (options.existing !== true) {
    FORBIDDEN_RE.lastIndex = 0;
    if (FORBIDDEN_RE.test(name)) return 'o nome da pasta tem caracteres que não funcionam no Windows ou em wikilinks';
  } else if (WINDOWS_FORBIDDEN_RE.test(name)) {
    return 'o nome da pasta tem caracteres que não funcionam no Windows';
  }
  if (/^[\s.]|[\s.]$/.test(name)) return 'o nome da pasta começa ou termina com espaço ou ponto';
  if (WINDOWS_RESERVED_RE.test((name.split('.')[0] ?? '').trim())) return 'o nome da pasta é reservado no Windows';
  const length = checkFileNameLength(name);
  if (!length.ok) return `o nome da pasta tem ${length.bytes} bytes; o limite é ${length.limit}`;
  return null;
}

/** Por que um nome de arquivo dado pelo chamador não serve, ou `null` se serve em Windows, macOS e Linux. */
export function fileNameProblem(name: string): string | null {
  const stem = name.replace(/\.md$/i, '');
  if (stem === '') return 'o nome está vazio';
  if (name !== normalizeNfc(name)) return 'o nome não está em NFC';
  FORBIDDEN_RE.lastIndex = 0;
  // `#`, `^`, `[` e `]` funcionam no disco, mas quebram wikilinks; ficam de fora junto dos proibidos no Windows
  if (FORBIDDEN_RE.test(stem)) return 'o nome tem caracteres que não funcionam no Windows ou em wikilinks';
  if (/^[\s.]|[\s.]$/.test(name)) return 'o nome começa ou termina com espaço ou ponto';
  if (WINDOWS_RESERVED_RE.test((stem.split('.')[0] ?? '').trim())) return 'o nome é reservado no Windows';
  const length = checkFileNameLength(name);
  if (!length.ok) return `o nome tem ${length.bytes} bytes; o limite é ${length.limit}`;
  return null;
}
