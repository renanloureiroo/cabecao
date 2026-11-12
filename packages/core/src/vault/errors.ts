import type { NoteIssue } from './schema.ts';

/** Motivos pelos quais o vault recusa uma operação. O chamador (tools do MCP, CLI) decide o que dizer ao usuário. */
export type VaultErrorCode =
  /** `.cabecao.json` não existe: a pasta não é um cérebro. */
  | 'config_not_found'
  /** `.cabecao.json` existe, mas não é JSON. */
  | 'config_invalid_json'
  /** `.cabecao.json` é JSON, mas um campo está faltando ou é inválido. */
  | 'config_invalid'
  /** `schemaVersion` é mais novo do que este Cabeção entende. */
  | 'config_schema_too_new'
  /** Caminho absoluto, com `..`, dentro de `.git`, ou que sai do cérebro por link simbólico. */
  | 'unsafe_path'
  /** Caminho de nota inválido: não termina em `.md`, passa por pasta oculta ou fica fora de `noteDirs`. */
  | 'invalid_note_path'
  /** O nome do arquivo não cabe em 255 bytes ou não é portável entre Windows, macOS e Linux. */
  | 'invalid_file_name'
  | 'note_not_found'
  | 'note_exists'
  /** A nota (ou a mudança pedida) não passa na validação do esquema; ver `issues`. */
  | 'invalid_note'
  /** O frontmatter do arquivo não pôde ser lido, então não dá para alterá-lo com segurança. */
  | 'invalid_frontmatter'
  /** Regras (`type: rule`) só o usuário cria. */
  | 'rule_requires_human'
  /** Tentativa de trocar `id` ou `type` de uma nota existente. */
  | 'immutable_field'
  /** `patchNote`: o trecho antigo é vazio. */
  | 'patch_empty'
  /** `patchNote`: o trecho antigo não aparece no corpo. */
  | 'patch_not_found'
  /** `patchNote`: o trecho antigo aparece mais de uma vez. */
  | 'patch_ambiguous'
  /** `addRelation`: tipo de relação que não está no conjunto fixo nem no `.cabecao.json`. */
  | 'unknown_relation'
  /** `addRelation`: o alvo não é um wikilink válido. */
  | 'invalid_link_target'
  | 'already_archived';

export interface VaultErrorDetails {
  /** Caminho relativo ao cérebro (ou absoluto, no caso do `.cabecao.json`). */
  path?: string;
  /** Problemas de validação, quando o código é `invalid_note`. */
  issues?: readonly NoteIssue[];
  /** Quantas vezes o trecho apareceu, em `patch_ambiguous`. */
  occurrences?: number;
  cause?: unknown;
}

/** Erro de uso do vault. A mensagem é em português e pronta para ser mostrada; `code` é o que o programa confere. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly path: string | null;
  readonly issues: readonly NoteIssue[];
  readonly occurrences: number | null;

  constructor(code: VaultErrorCode, message: string, details: VaultErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'VaultError';
    this.code = code;
    this.path = details.path ?? null;
    this.issues = details.issues ?? [];
    this.occurrences = details.occurrences ?? null;
  }
}
