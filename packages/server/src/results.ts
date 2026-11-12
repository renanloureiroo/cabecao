// Formato dos resultados das tools.
//
// Sucesso: o objeto da camada de operações vai em `structuredContent` E, como JSON, no texto. O Claude Code entrega
// ao modelo o `structuredContent` no lugar do texto; outros clientes leem o texto. Por isso a orientação ao agente
// (`next_step`) mora dentro do objeto, nunca só no texto.
//
// Erro: `isError: true` com o texto `{"error": {code, message, next_step?, details?}}`, sem `structuredContent`. O
// esquema de saída declarado descreve o sucesso; um erro com `structuredContent` fora dele seria recusado por
// clientes que validam a saída mesmo em erro. Sem `structuredContent`, todo cliente entrega o texto ao modelo.
import type { BrainErrorCode, BrainErrorDetails } from '@cabecao/core';
import { BRAIN_ERROR_CODES, BrainError } from '@cabecao/core';
import type { CallToolResult } from '@modelcontextprotocol/server';

/** Códigos de erro que só o servidor produz. */
export type ServerErrorCode = 'internal_error';

/** Forma JSON de um erro de tool (a mesma de `BrainError.toJSON()`). */
export interface ToolErrorJson {
  readonly code: BrainErrorCode | ServerErrorCode;
  readonly message: string;
  readonly next_step?: string;
  readonly details?: BrainErrorDetails;
}

export function okResult(output: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: { ...output },
  };
}

export function errorResult(error: ToolErrorJson): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Erro com a forma de um `BrainError` que não é instância da classe: o `SyncRunner` da CLI roda o sync em outro
 * processo e pode devolver o erro reconstruído a partir do JSON.
 */
function brainErrorLike(error: unknown): ToolErrorJson | null {
  if (!isRecord(error)) return null;
  const code = error.code;
  if (typeof code !== 'string' || !(BRAIN_ERROR_CODES as readonly string[]).includes(code)) return null;
  if (typeof error.message !== 'string') return null;
  const nextStep = typeof error.nextStep === 'string' ? error.nextStep : error.next_step;
  const details = error.details;
  return {
    code: code as BrainErrorCode,
    message: error.message,
    ...(typeof nextStep === 'string' ? { next_step: nextStep } : {}),
    ...(isRecord(details) && Object.keys(details).length > 0 ? { details: details as BrainErrorDetails } : {}),
  };
}

/**
 * Converte qualquer erro lançado por uma tool no JSON que vai ao agente. `BrainError` mantém código, mensagem,
 * `next_step` e detalhes; o resto vira `internal_error` com uma mensagem curta, nunca com a pilha (que vai para o
 * stderr pelo `log`).
 */
export function toToolError(error: unknown, log: (message: string) => void): ToolErrorJson {
  if (error instanceof BrainError) return error.toJSON();
  const like = brainErrorLike(error);
  if (like !== null) return like;
  log(`erro inesperado numa tool: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: 'internal_error',
    message: `erro inesperado no servidor do Cabeção: ${detail.split('\n')[0]?.slice(0, 300) ?? ''}`,
    next_step:
      'Confira com status ou read se a operação aconteceu antes de repetir; se o erro continuar, rode "cabecao doctor".',
  };
}
