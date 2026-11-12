/** Erro de uso: opção desconhecida, argumento faltando. A CLI sai com código 2 e aponta para a ajuda. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliErrorOptions {
  /** Identificador estável para quem lê a saída `--json` (por exemplo `EBRAIN`). */
  code?: string;
  /** Linha extra dizendo o que fazer a seguir. */
  hint?: string;
  cause?: unknown;
}

/**
 * Erro de execução previsto: a mensagem já está pronta para o usuário, em português. A CLI sai com código 1
 * e não mostra stack (só com `CABECAO_DEBUG=1`).
 */
export class CliError extends Error {
  readonly code: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.code = options.code;
    this.hint = options.hint;
  }
}
