// Entrada dos hooks do Claude Code. O Claude Code manda um JSON no stdin (`session_id`, `cwd`, `hook_event_name`,
// `source` no SessionStart, `reason` no SessionEnd...). É entrada NÃO confiável: o tamanho é limitado na leitura e
// cada campo é conferido aqui; o que não passa é ignorado, e o hook segue sem ele (nunca falha por causa da entrada).
import { isAbsolute, resolve } from 'node:path';
import type { CliIo } from '../types.ts';

/** Teto da entrada de um hook. O JSON de SessionStart e SessionEnd tem menos de 1 kB. */
export const HOOK_STDIN_MAX_BYTES = 256 * 1024;
/** Quanto o hook espera pelo fim da entrada antes de seguir sem ela. */
export const HOOK_STDIN_TIMEOUT_MS = 1_000;
/** Teto de um caminho aceito vindo do hook. */
const MAX_PATH_CHARS = 4_096;
/** Teto dos campos de texto curtos (identificadores, motivo). */
const MAX_FIELD_CHARS = 200;

export interface HookInput {
  /** Evento que disparou o hook (`SessionStart`, `SessionEnd`). */
  readonly event: string | null;
  /** Identificador da sessão do Claude Code (não é o `session_handle` do Cabeção). */
  readonly sessionId: string | null;
  /** Pasta da sessão: absoluta, sem caractere de controle. */
  readonly cwd: string | null;
  /** `startup`, `resume`, `clear`, `compact`... (SessionStart). */
  readonly source: string | null;
  /** `clear`, `logout`, `prompt_input_exit`, `other`... (SessionEnd). */
  readonly reason: string | null;
}

export const EMPTY_HOOK_INPUT: HookInput = { event: null, sessionId: null, cwd: null, source: null, reason: null };

// biome-ignore lint/suspicious/noControlCharactersInRegex: é justamente o que a validação recusa
const CONTROL = /[\u0000-\u001f\u007f]/;
const SHORT_FIELD = /^[\w.:@-]+$/;

function shortField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS && SHORT_FIELD.test(value)
    ? value
    : null;
}

function pathField(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH_CHARS || CONTROL.test(value)) return null;
  return isAbsolute(value) ? value : null;
}

/** Interpreta o JSON do hook. Texto que não é um objeto JSON vira a entrada vazia. */
export function parseHookInput(text: string | null): HookInput {
  if (text === null || text.trim() === '') return EMPTY_HOOK_INPUT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_HOOK_INPUT;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_HOOK_INPUT;
  const record = parsed as Record<string, unknown>;
  return {
    event: shortField(record.hook_event_name),
    sessionId: shortField(record.session_id),
    cwd: pathField(record.cwd),
    source: shortField(record.source),
    reason: shortField(record.reason),
  };
}

/** Lê e interpreta a entrada do hook, se o processo tiver uma. */
export async function readHookInput(io: Pick<CliIo, 'readStdin'>): Promise<HookInput> {
  if (io.readStdin === undefined) return EMPTY_HOOK_INPUT;
  try {
    return parseHookInput(await io.readStdin({ maxBytes: HOOK_STDIN_MAX_BYTES, timeoutMs: HOOK_STDIN_TIMEOUT_MS }));
  } catch {
    return EMPTY_HOOK_INPUT;
  }
}

/**
 * Variável que o Claude Code passa aos hooks de um plugin com a opção `brain_dir` (o `userConfig` do plugin). Os hooks
 * de comando não recebem `${user_config.*}` na linha de comando; recebem esta variável.
 */
export const PLUGIN_BRAIN_ENV = 'CLAUDE_PLUGIN_OPTION_BRAIN_DIR';

/**
 * Cérebro pedido para um hook: o explícito (`--brain`, `CABECAO_BRAIN`) ou, sem ele, a opção do plugin. `undefined`
 * deixa a resolução normal (cérebro padrão da máquina, pasta atual).
 */
export function hookBrain(ctx: Pick<CliIo, 'env' | 'cwd'> & { brain: string | undefined }): string | undefined {
  if (ctx.brain !== undefined) return ctx.brain;
  const option = ctx.env[PLUGIN_BRAIN_ENV];
  if (option === undefined || option.trim() === '' || option.includes('${') || CONTROL.test(option)) return undefined;
  return resolve(ctx.cwd, option.trim());
}
