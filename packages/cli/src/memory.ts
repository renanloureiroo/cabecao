// Apoio dos comandos de memória que espelham as tools do servidor MCP (`remember`, `write`, `patch`, `relate`,
// `handoff`, `read`, `forget`, `undo`): a entrada (argumento, arquivo, stdin ou um JSON pelo stdin com os mesmos campos
// da tool), a conferência com os MESMOS esquemas de entrada das tools (limites de tamanho iguais) e o fluxo de
// confirmação das ações elevadas (decisão 37).
//
// Este módulo carrega o núcleo e o Zod: importe-o só de dentro de um comando.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ConfirmationFields, ConfirmOptions } from '@cabecao/core';
import { CliError, UsageError } from './errors.ts';
import type { CommandContext } from './types.ts';

/**
 * Teto da entrada pelo stdin: o conteúdo de uma nota tem até 1.000.000 caracteres (o mesmo limite das tools), que em
 * UTF-8 ocupam até 4 MB; com folga para o JSON de `--json-input` (escapes e os demais campos).
 */
export const STDIN_MAX_BYTES = 8 * 1024 * 1024;
/** Quanto a leitura do stdin espera o fim da entrada. */
export const STDIN_TIMEOUT_MS = 60_000;

/** Lê o stdin inteiro (para conteúdo ou `--json-input`). Falha com explicação quando não há, passa do teto ou trava. */
export async function readAllStdin(ctx: CommandContext, what: string): Promise<string> {
  if (ctx.readStdin === undefined) {
    throw new CliError(`não há entrada padrão para ler ${what}`, { code: 'invalid_argument' });
  }
  const text = await ctx.readStdin({ maxBytes: STDIN_MAX_BYTES, timeoutMs: STDIN_TIMEOUT_MS });
  if (text === null) {
    throw new CliError(
      `não consegui ler ${what} da entrada padrão: ela é um terminal, passou de ${STDIN_MAX_BYTES / 1024 / 1024} MB ou não terminou em ${STDIN_TIMEOUT_MS / 1000} s`,
      {
        code: 'invalid_argument',
        hint: 'Mande o texto por um pipe ou arquivo (cabecao remember --type gotcha < nota.md), ou use --file <arquivo>.',
      },
    );
  }
  return text;
}

/** Texto de um arquivo indicado pelo chamador (`-` é a entrada padrão), em UTF-8. */
export async function readTextFile(ctx: CommandContext, path: string, what: string): Promise<string> {
  if (path === '-') return readAllStdin(ctx, what);
  try {
    return await readFile(resolve(ctx.cwd, path), 'utf8');
  } catch (error) {
    throw new CliError(`não consegui ler ${path}: ${(error as Error).message}`, { code: 'invalid_argument' });
  }
}

/** `--json-input`: um objeto JSON pelo stdin, com os mesmos campos da tool. */
export async function readJsonInput(ctx: CommandContext): Promise<Record<string, unknown>> {
  const text = await readAllStdin(ctx, 'o JSON de --json-input');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CliError(`--json-input: o stdin não é JSON válido (${(error as Error).message})`, {
      code: 'invalid_argument',
    });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError('--json-input: o stdin deveria ser um objeto JSON com os campos da tool', {
      code: 'invalid_argument',
    });
  }
  return value as Record<string, unknown>;
}

/** Valor de uma opção de texto, ou `undefined`. */
export const stringOption = (ctx: CommandContext, name: string): string | undefined => {
  const value = ctx.values[name];
  return typeof value === 'string' ? value : undefined;
};

/** Valores de uma opção repetível. */
export const listOption = (ctx: CommandContext, name: string): string[] | undefined => {
  const value = ctx.values[name];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map(String);
};

/** O esquema de entrada de uma tool (Zod): só o que a CLI usa dele. */
interface InputSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
}
interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Confere a entrada com o esquema da tool (`@cabecao/server/input-schemas`): os mesmos campos e os mesmos limites de
 * tamanho. Campos a mais são descartados, como no servidor (nenhum vira opção interna, como "confirmado pelo usuário").
 */
export function checkInput<T>(schema: InputSchema<T>, value: unknown, tool: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length === 0 ? '(entrada)' : issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
  throw new CliError(`entrada inválida para ${tool}: ${problems}`, {
    code: 'invalid_argument',
    hint: 'Confira os campos e os limites (os mesmos da tool do servidor MCP).',
  });
}

/** Resposta que pode pedir confirmação. */
type Confirmable = ConfirmationFields & { readonly next_step?: string };

export interface Confirmed<T> {
  readonly output: T;
  /** 0, ou `EXIT_CONFIRM` (3) quando nada foi feito por falta de confirmação. */
  readonly code: number;
}

/** O código de saída de uma resposta que ficou pendente de confirmação. */
export const EXIT_CONFIRM = 3;

/** Uma resposta afirmativa digitada no terminal. */
const YES = new Set(['s', 'sim', 'y', 'yes']);

/**
 * Fluxo de confirmação de uma ação elevada (decisão 37), igual ao das tools:
 * - a primeira chamada, se a ação for elevada, volta `confirmation_required` sem fazer nada;
 * - o USUÁRIO no terminal confirma digitando (a pergunta vai direto ao terminal controlador, nunca ao stdin) e a ação
 *   roda como confirmada por ele;
 * - um AGENTE recebe o resumo, o `confirm_token` e o `next_step`, com o código de saída 3; para executar, repete o
 *   comando com `--confirm <token>` depois de o usuário dizer sim.
 */
export async function withConfirmation<T extends Confirmable>(
  ctx: CommandContext,
  call: (options: ConfirmOptions) => Promise<T>,
): Promise<Confirmed<T>> {
  const first = await call({});
  if (first.status !== 'confirmation_required') return { output: first, code: 0 };
  if (ctx.actor.actor !== 'human' || ctx.prompt === undefined) return { output: first, code: EXIT_CONFIRM };
  const answer = await ctx.prompt(
    `${first.summary ?? ''}\nIsto exige a sua confirmação (${(first.reasons ?? []).join('; ')}). Fazer? Digite "sim": `,
  );
  if (answer !== null && YES.has(answer.trim().toLowerCase())) {
    return { output: await call({ userConfirmed: true }), code: 0 };
  }
  const { confirm_token: _token, token_expires_at: _expires, ...rest } = first;
  return {
    output: { ...rest, status: 'declined', next_step: 'Você não confirmou; nada foi feito.' } as unknown as T,
    code: 0,
  };
}

/** Texto, para o terminal, de uma resposta que pediu confirmação (ou que foi recusada). */
export function confirmationText(output: Confirmable, command: string): string | null {
  if (output.status === 'declined') return 'Nada foi feito.';
  if (output.status !== 'confirmation_required') return null;
  return [
    'Nada foi feito: esta ação exige o pedido explícito do usuário.',
    `Resumo: ${output.summary ?? ''}`,
    `Por quê: ${(output.reasons ?? []).join('; ')}`,
    `Se o usuário pediu exatamente isto, repita "${command}" com os mesmos argumentos e --confirm ${output.confirm_token ?? '<token>'} (vale até ${output.token_expires_at ?? '?'}).`,
    `Próximo passo: ${output.next_step ?? ''}`,
  ].join('\n');
}

/** `--confirm` para o campo `confirm_token` da entrada. */
export function confirmTokenOf(ctx: CommandContext): { confirm_token?: string } {
  const token = stringOption(ctx, 'confirm');
  if (token === '') throw new UsageError('a opção --confirm precisa do token devolvido pela primeira chamada');
  return token === undefined ? {} : { confirm_token: token };
}
