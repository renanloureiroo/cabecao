// Tipos públicos do parser de notas. Tudo é somente leitura: o resultado de `parseNote` é um valor, não um rascunho.
// Linhas e colunas contam a partir de 1 e se referem ao arquivo original (frontmatter incluído).

/** Por que o frontmatter não pôde ser lido. */
export type FrontmatterErrorCode =
  /** O YAML entre os `---` é inválido. */
  | 'invalid_yaml'
  /** O YAML é válido, mas a raiz não é um mapa (é uma lista ou um valor solto). */
  | 'not_a_mapping';

/** Erro estruturado do frontmatter. O corpo da nota é devolvido mesmo assim. */
export interface FrontmatterError {
  readonly code: FrontmatterErrorCode;
  /** Primeira linha da mensagem do parser de YAML (em inglês, vinda da biblioteca) ou descrição do problema. */
  readonly message: string;
  /** Linha do arquivo onde o erro foi detectado, quando a biblioteca informa. */
  readonly line: number | null;
}

/** Resultado de separar o frontmatter do corpo. */
export interface FrontmatterSplit {
  /** Existe um bloco `---` ... `---` no começo do arquivo (mesmo que vazio ou inválido). */
  readonly hasFrontmatter: boolean;
  /** Dados do frontmatter; `{}` quando não há bloco, quando ele é vazio ou quando deu erro. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly error: FrontmatterError | null;
  /** YAML cru entre os delimitadores (sem BOM), ou `null` quando não há bloco. */
  readonly raw: string | null;
  /** Texto depois do frontmatter, sem BOM, com as quebras de linha originais. */
  readonly body: string;
  /** Linha do arquivo em que o corpo começa (1 quando não há frontmatter). */
  readonly bodyStartLine: number;
  /** Wikilinks encontrados nos valores do frontmatter. */
  readonly links: readonly FrontmatterLink[];
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface Heading {
  readonly level: HeadingLevel;
  /** Texto do título sem as marcas de código e de ênfase com asterisco; wikilinks ficam como foram escritos. */
  readonly text: string;
  /** Títulos dos ancestrais e o próprio, do nível mais alto para o mais baixo. */
  readonly headingPath: readonly string[];
  /** Linha do título (no setext, a primeira linha do texto do título). */
  readonly line: number;
  readonly style: 'atx' | 'setext';
}

/**
 * Seção "rasa": vai de um título até a linha anterior ao próximo título de qualquer nível.
 * O texto antes do primeiro título forma uma seção sem título (`heading: null`, `headingPath: []`).
 */
export interface Section {
  readonly heading: Heading | null;
  readonly headingPath: readonly string[];
  readonly startLine: number;
  /** Última linha da seção (inclusiva). */
  readonly endLine: number;
}

/** `[[alvo]]`, `[[alvo|apelido]]`, `[[alvo#seção]]` ou `![[embed]]` no corpo da nota. */
export interface WikiLink {
  /** `true` para `![[...]]`. */
  readonly embed: boolean;
  /** Alvo como foi escrito (aparado). Vazio em links para a própria nota, como `[[#Seção]]`. */
  readonly target: string;
  /** Texto depois do `#` (seção, `Seção#Subseção` ou `^bloco`), ou `null`. */
  readonly anchor: string | null;
  /** Texto depois do `|`, ou `null`. */
  readonly alias: string | null;
  readonly line: number;
  /** Coluna do `[[` (ou do `!`), em unidades UTF-16. */
  readonly column: number;
  /** Seção em que o link aparece. */
  readonly headingPath: readonly string[];
}

/** Link Markdown relativo (`[texto](Pasta/Nota.md#seção)`) ou imagem (`![alt](a.png)`). Links com esquema (`https:`) ficam de fora. */
export interface MarkdownLink {
  /** `true` para `![alt](...)`. */
  readonly embed: boolean;
  /** Caminho decodificado (`%20` vira espaço) e sem a extensão `.md`. */
  readonly target: string;
  readonly anchor: string | null;
  /** Texto entre colchetes, ou `null` se vazio. */
  readonly text: string | null;
  readonly line: number;
  readonly column: number;
  readonly headingPath: readonly string[];
}

/**
 * Wikilink dentro de um valor do frontmatter. Cobre as relações tipadas (uma propriedade por relação, com uma lista
 * de wikilinks: `uses`, `part_of`, `supersedes`...) e os campos `subject` e `object` dos fatos.
 */
export interface FrontmatterLink {
  /** Chave de primeiro nível do frontmatter (`uses`, `subject`, `sources`...). */
  readonly property: string;
  readonly target: string;
  readonly anchor: string | null;
  readonly alias: string | null;
  /** Linha do arquivo em que o valor começa. */
  readonly line: number;
}

/** Trecho de uma seção, na unidade em que a nota é indexada e embutida. */
export interface Chunk {
  /** Posição do trecho na nota, a partir de 0. */
  readonly ord: number;
  readonly headingPath: readonly string[];
  /** Prefixo de contexto `Título › Seção`; vazio quando a nota não tem título nem seção. */
  readonly contextPrefix: string;
  /** Texto do trecho, com `\n` como quebra de linha, sem a linha do título da seção. */
  readonly text: string;
  /** Texto que vai para o modelo de embeddings: o prefixo de contexto na primeira linha e o trecho em seguida. */
  readonly embedText: string;
  /** Estimativa de tokens de `text` (ver `estimateTokens`). */
  readonly tokenCount: number;
  /** SHA-256 de `embedText` em UTF-8, truncado em 16 bytes, em hexadecimal (32 caracteres). */
  readonly chunkKey: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ParseNoteOptions {
  /** Alvo de tokens por trecho. Padrão: 350. */
  readonly targetTokens?: number;
  /**
   * Título usado quando a nota não tem `title` no frontmatter nem título de nível 1. Entra no prefixo de contexto
   * e, portanto, no `chunkKey`: se vier do nome do arquivo, renomear o arquivo recalcula os embeddings da nota.
   */
  readonly fallbackTitle?: string;
}

export interface ParsedNote {
  readonly hasFrontmatter: boolean;
  /** Dados do frontmatter; `{}` quando ausente, vazio ou inválido. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Preenchido quando o frontmatter existe mas não pôde ser lido. Nunca é lançado como exceção. */
  readonly frontmatterError: FrontmatterError | null;
  /** Texto depois do frontmatter, sem BOM, com as quebras de linha originais. */
  readonly body: string;
  /** Linha do arquivo em que o corpo começa. */
  readonly bodyStartLine: number;
  /** `title` do frontmatter; senão o primeiro título de nível 1; senão `fallbackTitle`; senão `null`. */
  readonly title: string | null;
  readonly headings: readonly Heading[];
  readonly sections: readonly Section[];
  /** Wikilinks e embeds do corpo, na ordem em que aparecem. */
  readonly links: readonly WikiLink[];
  /** Links Markdown relativos do corpo. */
  readonly markdownLinks: readonly MarkdownLink[];
  /** Wikilinks nos valores do frontmatter (relações tipadas e fatos). */
  readonly frontmatterLinks: readonly FrontmatterLink[];
  readonly chunks: readonly Chunk[];
}
