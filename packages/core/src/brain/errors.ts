// Erros da camada de operações: um `code` estável que o servidor MCP e a CLI conferem, mensagem em português pronta
// para mostrar e, quando há o que o agente fazer, um `next_step`.
import { GitError, GitStateError } from '../git/index.ts';
import { FileChangedError, LockTimeoutError } from '../util/index.ts';
import type { NoteIssue } from '../vault/index.ts';
import { VaultError } from '../vault/index.ts';

export const BRAIN_ERROR_CODES = [
  /** A pasta não tem `.cabecao.json`. */
  'not_a_brain',
  /** `.cabecao.json` existe, mas está quebrado ou é de um esquema mais novo. */
  'invalid_config',
  /** A pasta do cérebro não é um repositório git (ou ainda não tem commits). */
  'not_a_repository',
  /** Nota, seção, operação ou sessão que não existe. */
  'not_found',
  /** Caminho absoluto, com `..`, dentro de `.git` ou que sai do cérebro por link simbólico. */
  'unsafe_path',
  /** Caminho dentro do cérebro, mas que não serve para nota (não é `.md`, pasta oculta, fora de `noteDirs`, nome não portável). */
  'invalid_path',
  /** Argumento ausente ou com formato errado. */
  'invalid_argument',
  /** A nota não passa no esquema; ver `details.issues`. */
  'invalid_note',
  /** `write_page` em modo `create` num caminho que já existe. */
  'already_exists',
  /** O scanner achou um possível segredo; ver `details.secrets` (sem o segredo). */
  'secret_detected',
  /** Regras (`type: rule`) só o usuário cria e altera. */
  'rule_requires_human',
  /** `patch_page`: o trecho antigo não aparece no corpo. */
  'patch_not_found',
  /** `patch_page`: o trecho antigo aparece mais de uma vez. */
  'ambiguous_patch',
  /** A nota mudou no disco durante a operação, ou o `undo` não aplica sem conflito. Nada foi alterado. */
  'conflict',
  /** Outro processo segurou a trava da pasta de trabalho por tempo demais. Nada foi alterado. */
  'locked',
  /** `undo` sem nada que desfazer. */
  'nothing_to_undo',
  /** `undo` de uma operação que já foi desfeita. */
  'already_undone',
  /** Falha inesperada do git. */
  'git_failed',
  /** O banco local (`.cabecao/cabecao.db`) não pôde ser aberto. */
  'index_failed',
  /** O cérebro já foi fechado com `close()`. */
  'closed',
] as const;
export type BrainErrorCode = (typeof BRAIN_ERROR_CODES)[number];

/** Onde o scanner achou um possível segredo. O segredo em si NUNCA aparece aqui. */
export interface SecretHit {
  /** `content`: o corpo enviado; `frontmatter`: um campo enviado; `pending`: edição feita fora do Cabeção no mesmo arquivo. */
  readonly where: 'content' | 'frontmatter' | 'pending';
  /** Campo do frontmatter, em `frontmatter`; caminho do arquivo, em `pending`. */
  readonly field: string | null;
  /** Linha (a partir de 1) dentro do texto em `where`. */
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly description: string;
}

/** Problema de esquema, no formato que vai para o agente. */
export interface IssueOutput {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly field: string | null;
  readonly message: string;
}

export interface BrainErrorDetails {
  readonly path?: string;
  readonly issues?: readonly IssueOutput[];
  readonly secrets?: readonly SecretHit[];
  /** `ambiguous_patch`: quantas vezes o trecho apareceu. */
  readonly occurrences?: number;
  /** `not_found` de seção: os títulos que existem. */
  readonly headings?: readonly string[];
  /** Operações envolvidas (`undo`). */
  readonly ops?: readonly string[];
}

/** Forma JSON de um erro, para o `structuredContent` do MCP e para `--json` da CLI. */
export interface BrainErrorJson {
  readonly code: BrainErrorCode;
  readonly message: string;
  readonly next_step?: string;
  readonly details?: BrainErrorDetails;
}

export class BrainError extends Error {
  readonly code: BrainErrorCode;
  readonly nextStep: string | null;
  readonly details: BrainErrorDetails;

  constructor(
    code: BrainErrorCode,
    message: string,
    options: { nextStep?: string; details?: BrainErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrainError';
    this.code = code;
    this.nextStep = options.nextStep ?? null;
    this.details = options.details ?? {};
  }

  toJSON(): BrainErrorJson {
    return {
      code: this.code,
      message: this.message,
      ...(this.nextStep === null ? {} : { next_step: this.nextStep }),
      ...(Object.keys(this.details).length === 0 ? {} : { details: this.details }),
    };
  }
}

export function issueOutput(issue: NoteIssue): IssueOutput {
  return { severity: issue.severity, code: issue.code, field: issue.field, message: issue.message };
}

const VAULT_CODES: Readonly<Record<string, BrainErrorCode>> = {
  config_not_found: 'not_a_brain',
  config_invalid_json: 'invalid_config',
  config_invalid: 'invalid_config',
  config_schema_too_new: 'invalid_config',
  unsafe_path: 'unsafe_path',
  invalid_note_path: 'invalid_path',
  invalid_file_name: 'invalid_path',
  note_not_found: 'not_found',
  note_exists: 'already_exists',
  invalid_note: 'invalid_note',
  invalid_frontmatter: 'invalid_note',
  immutable_field: 'invalid_note',
  unknown_relation: 'invalid_argument',
  invalid_link_target: 'invalid_argument',
  rule_requires_human: 'rule_requires_human',
  patch_empty: 'invalid_argument',
  patch_not_found: 'patch_not_found',
  patch_ambiguous: 'ambiguous_patch',
  already_archived: 'invalid_argument',
};

const NEXT_STEPS: Partial<Record<BrainErrorCode, string>> = {
  not_a_brain: 'Rode "cabecao init" nesta pasta ou aponte para a pasta de um cérebro.',
  invalid_note: 'Corrija os campos apontados em details.issues e tente de novo.',
  rule_requires_human:
    'Regras só o usuário cria. Grave como preferência (type: preference) ou peça ao usuário que crie a regra.',
  patch_not_found: 'Leia a nota de novo com read e copie o trecho exato que quer substituir.',
  ambiguous_patch: 'Inclua mais contexto em old (linhas vizinhas) para o trecho aparecer uma vez só.',
  conflict: 'Leia a nota de novo com read e refaça a alteração sobre a versão atual.',
  locked: 'Outro processo está gravando no cérebro; tente de novo em alguns segundos.',
  already_exists: 'Use mode "overwrite" ou "append", ou escolha outro caminho.',
};

/**
 * Converte o erro de qualquer módulo do núcleo num `BrainError`. Erros que já são `BrainError` passam intactos; o
 * que não é reconhecido vira `git_failed` (falha do git) ou é relançado como está (defeito de programa).
 */
export function toBrainError(error: unknown): BrainError {
  if (error instanceof BrainError) return error;
  if (error instanceof VaultError) {
    const code = VAULT_CODES[error.code] ?? 'invalid_note';
    const details: BrainErrorDetails = {
      ...(error.path === null ? {} : { path: error.path }),
      ...(error.issues.length === 0 ? {} : { issues: error.issues.map(issueOutput) }),
      ...(error.occurrences === null ? {} : { occurrences: error.occurrences }),
    };
    const nextStep = NEXT_STEPS[code];
    return new BrainError(code, error.message, {
      details,
      cause: error,
      ...(nextStep === undefined ? {} : { nextStep }),
    });
  }
  if (error instanceof FileChangedError) {
    return new BrainError('conflict', `a nota ${error.path} mudou no disco durante a operação; nada foi gravado`, {
      details: { path: error.path },
      nextStep: NEXT_STEPS.conflict ?? '',
      cause: error,
    });
  }
  if (error instanceof LockTimeoutError) {
    return new BrainError('locked', `o cérebro está ocupado por outro processo (${error.message})`, {
      nextStep: NEXT_STEPS.locked ?? '',
      cause: error,
    });
  }
  if (error instanceof GitStateError) {
    return new BrainError('conflict', error.message, {
      nextStep: 'Termine ou desfaça o que está preparado no índice do git ("git status") e tente de novo.',
      cause: error,
    });
  }
  if (error instanceof GitError) {
    return new BrainError('git_failed', error.message, { cause: error });
  }
  throw error;
}
