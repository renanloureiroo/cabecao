import { randomBytes } from 'node:crypto';
import type { Brain, RecallOutput } from '@cabecao/core';
import { homeDir, resolveBrain, withBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { Briefing } from '../hook/briefing.ts';
import { EMPTY_HOOK_OUTPUT, recallText, renderHookBriefing, sessionStartOutput } from '../hook/briefing.ts';
import { hookBrain, readHookInput } from '../hook/input.ts';
import { projectOf } from '../hook/project.ts';
import type { CommandContext, CommandResult } from '../types.ts';

// `cabecao recall`: o briefing do cérebro. Para você, no terminal (`recall "<tarefa>"`); para o Claude Code, no hook de
// início de sessão (`recall --hook`), que precisa ser rápido e nunca pode falhar a sessão. Não carrega o servidor MCP
// nem o runtime de embeddings: o `recall` do núcleo busca só por palavra-chave.

/** Orçamento do núcleo no modo hook. Folgado: o corte fino é por caracteres, em `renderHookBriefing`. */
export const HOOK_BUDGET_TOKENS = 4_000;
/** Prazo do modo hook inteiro. Passou disso, a sessão segue sem o briefing (o hook do plugin tem prazo próprio). */
export const HOOK_DEADLINE_MS = 5_000;

export interface RecallDeps {
  deadlineMs: number;
  /** Código aleatório da marca do bloco de dados. */
  nonce: () => string;
}

const DEFAULT_DEPS: RecallDeps = {
  deadlineMs: HOOK_DEADLINE_MS,
  nonce: () => randomBytes(9).toString('hex'),
};

function count(output: RecallOutput): number {
  return (
    output.rules.length +
    (output.handoff === null ? 0 : 1) +
    output.preferences.length +
    output.gotchas.length +
    output.memories.length
  );
}

function nonEmptyAbsolute(value: string | undefined): string | null {
  return value !== undefined && value !== '' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value) ? value : null;
}

/** Briefing do modo hook: escopo pela pasta do projeto e, se nesse escopo não houver nada, todos os escopos. */
async function hookBriefing(ctx: CommandContext, deps: RecallDeps): Promise<Briefing> {
  const input = await readHookInput(ctx);
  const root = await resolveBrain({ ...ctx, brain: hookBrain(ctx) });
  const cwd = nonEmptyAbsolute(ctx.env.CLAUDE_PROJECT_DIR) ?? input.cwd ?? ctx.cwd;
  let home: string | null;
  try {
    home = homeDir(ctx);
  } catch {
    home = null;
  }
  return withBrain(ctx, root, async (brain: Brain) => {
    const project = await projectOf(cwd, { brainRoot: brain.root, home });
    const task = project?.name ?? 'início de sessão';
    let output: RecallOutput;
    let scopeNote: string;
    if (project === null) {
      output = await brain.recall({ task, budget_tokens: HOOK_BUDGET_TOKENS });
      scopeNote = 'todos os escopos (a pasta da sessão não é de um projeto)';
    } else {
      const scope = `project:${project.slug}`;
      output = await brain.recall({ task, scope, budget_tokens: HOOK_BUDGET_TOKENS });
      scopeNote = `${scope}, pela pasta "${project.name}" (inclui o global)`;
      if (count(output) === 0) {
        output = await brain.recall({ task, budget_tokens: HOOK_BUDGET_TOKENS });
        scopeNote = `todos os escopos (nada em ${scope} nem no global)`;
      }
    }
    return renderHookBriefing(output, { nonce: deps.nonce(), scopeNote });
  });
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const hint = (error as { hint?: unknown } | null)?.hint;
  return typeof hint === 'string' ? `${message} (${hint})` : message;
}

/**
 * Modo hook: escreve em stdout exatamente o JSON que o SessionStart do Claude Code espera e sai com 0. Qualquer
 * problema (cérebro ausente, banco travado, prazo estourado, erro inesperado) vira a saída vazia `{}`, com o
 * diagnóstico só no stderr: a sessão sempre começa.
 */
async function runHook(ctx: CommandContext, deps: RecallDeps): Promise<CommandResult> {
  let written = false;
  const emit = (text: string): void => {
    if (written) return;
    written = true;
    ctx.stdout.write(`${text}\n`);
  };
  const fail = (message: string): void => {
    ctx.stderr.write(`cabecao recall --hook: ${message}. A sessão segue sem o briefing.\n`);
    emit(EMPTY_HOOK_OUTPUT);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.deadlineMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([hookBriefing(ctx, deps), deadline]);
    if (result === 'timeout') {
      fail(`o briefing passou de ${deps.deadlineMs} ms`);
      // a operação pendurada (banco ocupado, disco lento) não pode prender o Claude Code
      ctx.exit?.(0);
      return { code: 0 };
    }
    emit(sessionStartOutput(result.text));
  } catch (error) {
    fail(describe(error));
  } finally {
    clearTimeout(timer);
  }
  return { code: 0 };
}

function budgetOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const budget = Number(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value) || budget < 100 || budget > 50_000) {
    throw new UsageError('--budget deveria ser um número de tokens entre 100 e 50000');
  }
  return budget;
}

export async function runRecall(ctx: CommandContext, deps: RecallDeps = DEFAULT_DEPS): Promise<CommandResult> {
  if (ctx.values.hook === true) return runHook(ctx, deps);
  const task = ctx.positionals.join(' ').trim();
  if (task === '') throw new UsageError('diga a tarefa: cabecao recall "<tarefa>"');
  const scope = typeof ctx.values.scope === 'string' ? ctx.values.scope : undefined;
  const budget = budgetOf(ctx.values.budget);
  const root = await resolveBrain(ctx);
  const output = await withBrain(ctx, root, (brain) =>
    brain.recall({
      task,
      ...(scope === undefined ? {} : { scope }),
      ...(budget === undefined ? {} : { budget_tokens: budget }),
    }),
  );
  // o comando é dono do stdout (por causa do modo hook): escreve aqui o texto ou o JSON de `--json`
  ctx.stdout.write(
    ctx.json ? `${JSON.stringify({ ok: true, command: 'recall', data: output })}\n` : `${recallText(output)}\n`,
  );
  return { code: 0 };
}

export function run(ctx: CommandContext): Promise<CommandResult> {
  return runRecall(ctx);
}
