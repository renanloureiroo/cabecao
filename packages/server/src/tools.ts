// As tools dos marcos 1 e 3 (as do marco 3 moram em `tools-graph.ts`). Cada uma é uma casca fina sobre a camada de operações do núcleo (`Brain`): valida a
// forma da entrada (Zod), chama a operação e devolve a saída como veio. Nenhuma regra é reimplementada aqui.
import type { Brain, ReadInput, SyncOutput } from '@cabecao/core';
import type { McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import type { BrainProvider } from './brains.ts';
import { resolveClientName } from './client-name.ts';
import { errorResult, okResult, toToolError } from './results.ts';
import {
  patchPageInput,
  readInput,
  readOutput,
  recallInput,
  recallOutput,
  rememberInput,
  searchInput,
  searchOutput,
  statusInput,
  statusOutput,
  syncInput,
  syncOutput,
  undoInput,
  undoOutput,
  writeOutput,
  writePageInput,
} from './schemas.ts';
import { rememberOutput } from './schemas-lifecycle.ts';
import type { AskRunner } from './tools-ask.ts';
import { registerAskTool } from './tools-ask.ts';
import { registerGraphReadTools, registerRelateTool } from './tools-graph.ts';
import {
  registerConsolidateTool,
  registerForgetTool,
  registerHandoffTool,
  registerIngestTool,
  registerLintTool,
  runConfirmable,
} from './tools-lifecycle.ts';

/** Roda o sync em outro processo (a CLI faz isso); recebe o `session_handle` do agente, se houver. */
export type SyncRunner = (input: { session_handle?: string }) => Promise<SyncOutput>;

/** O que dura o processo inteiro e é compartilhado por todas as instâncias de servidor. */
export interface ServerRuntime {
  /** Versão do pacote `cabecao`, anunciada em `serverInfo`. */
  readonly version: string;
  readonly brains: BrainProvider;
  /** Quando presente, a tool `sync` usa isto; senão, roda o sync no próprio processo. */
  readonly syncRunner?: SyncRunner;
  /**
   * Respostas geradas (`ask`), quando há provedor ativo nesta máquina e o cérebro permite. Sem isto, a tool `ask` não é
   * registrada nem aparece em `tools/list`.
   */
  readonly ask?: AskRunner;
  /** Diagnóstico; vai para o stderr, nunca para o stdout. */
  readonly log: (message: string) => void;
}

/** A tool que só existe com um provedor de respostas ativo (registrada logo depois de `search`). */
export const ASK_TOOL_NAME = 'ask';

/** Nomes das tools, na ordem em que são registradas (sem `ask`, que é condicional). */
export const TOOL_NAMES = [
  'recall',
  'search',
  'read',
  'graph',
  'facts',
  'status',
  'lint',
  'remember',
  'handoff_save',
  'write_page',
  'patch_page',
  'relate',
  'ingest',
  'forget',
  'sync',
  'consolidate',
  'undo',
] as const;

/**
 * Nome do cliente desta requisição: o `clientInfo` do envelope `_meta` (geração 2026-07-28) ou o do `initialize`
 * (2025-11-25). Lido a cada chamada, sem estado de conexão.
 */
export function clientOf(server: McpServer, ctx: ServerContext): string {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = (envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion()) as { name?: unknown } | undefined;
  return resolveClientName(info?.name);
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerTools(server: McpServer, runtime: ServerRuntime): void {
  /** Executa a operação e monta o resultado; nenhum erro escapa daqui (nem derruba o processo). */
  const run = async (ctx: ServerContext, operation: (brain: () => Promise<Brain>) => Promise<object>) => {
    try {
      return okResult(await operation(() => runtime.brains.get(clientOf(server, ctx))));
    } catch (error) {
      return errorResult(toToolError(error, runtime.log));
    }
  };
  const brainOf = (ctx: ServerContext): Promise<Brain> => runtime.brains.get(clientOf(server, ctx));

  server.registerTool(
    'recall',
    {
      title: 'Recall',
      description:
        "Start-of-task briefing from the user's second brain: rules, latest handoff, preferences, gotchas and memories relevant to the task. Call it first. Returns a session_handle to pass to the write tools.",
      inputSchema: recallInput,
      outputSchema: recallOutput,
      // gera um session_handle novo a cada chamada, mas não grava nada
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).recall(args)),
  );

  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        "Search the user's second brain: hybrid (keywords + meaning) when semantic search is enabled on this machine, else keywords; mode_used and mode_reason say which ran. Each hit has validity on as_of (current, expired or not_yet_valid; default today) and provenance; a separate related block lists graph neighbors of the top hits. Search before stating anything about the user's history.",
      inputSchema: searchInput,
      outputSchema: searchOutput,
      annotations: READ_ONLY,
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).search(args)),
  );

  if (runtime.ask !== undefined) registerAskTool(server, run, runtime.ask);

  server.registerTool(
    'read',
    {
      title: 'Read note',
      description:
        'Read one note by path or id, optionally a single section: body, frontmatter, headings, outgoing links and backlinks.',
      inputSchema: readInput,
      outputSchema: readOutput,
      annotations: READ_ONLY,
    },
    // "path ou id, só um dos dois" é conferido pelo núcleo
    (args, ctx) => run(ctx, async (brain) => (await brain()).read(args as unknown as ReadInput)),
  );

  registerGraphReadTools(server, run, READ_ONLY);

  server.registerTool(
    'status',
    {
      title: 'Status',
      description: 'Brain health: note counts, local index, sync state, pending conflicts and broken links.',
      inputSchema: statusInput,
      outputSchema: statusOutput,
      annotations: READ_ONLY,
    },
    (_args, ctx) => run(ctx, async (brain) => (await brain()).status()),
  );

  registerLintTool(server, run, READ_ONLY);

  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        "Save a durable, non-obvious memory (preference, correction, decision and why, gotcha, fact...), committed to git. Same scope and type are checked first: duplicates are skipped, supersets update, a fact with a new object supersedes; ambiguous cases return candidates for a second call with resolution. A rule (type: rule) needs the user's explicit request: the first call returns decision needs_confirmation with a summary and confirm_token. Never store secrets.",
      inputSchema: rememberInput,
      outputSchema: rememberOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) =>
      runConfirmable(server, ctx, brainOf, runtime.log, args.confirm_token !== undefined, (brain, options) =>
        brain.remember(args, options),
      ),
  );

  registerHandoffTool(server, run);

  server.registerTool(
    'write_page',
    {
      title: 'Write page',
      description:
        "Create, overwrite or append to a note by path. Validated against the schema, scanned for secrets and committed to git; undo reverts it. Needs the user's explicit request (the first call returns status confirmation_required with a summary and confirm_token; show it, ask, and call again with the token only if the user said yes): rules (type: rule, memory/rules/), the brain's control files and AI-client instruction files (AGENTS.md, CLAUDE.md, GEMINI.md, log.md, .cabecao.json...; as plain text, no frontmatter), changes to raw/ sources and trust: high. index.md and sync conflict copies are never written. Editing a note not created by an agent records edited_by (and lowers trust: high to medium).",
      inputSchema: writePageInput,
      outputSchema: writeOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) =>
      runConfirmable(server, ctx, brainOf, runtime.log, args.confirm_token !== undefined, (brain, options) =>
        brain.writePage(args, options),
      ),
  );

  server.registerTool(
    'patch_page',
    {
      title: 'Patch page',
      description:
        'Replace one exact snippet of a note body (or of a control file). Read it first and copy `old` verbatim; it must appear exactly once. Same confirmation as write_page for rules, control/instruction files and raw/.',
      inputSchema: patchPageInput,
      outputSchema: writeOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) =>
      runConfirmable(server, ctx, brainOf, runtime.log, args.confirm_token !== undefined, (brain, options) =>
        brain.patchPage(args, options),
      ),
  );

  registerRelateTool(server, (ctx, hasToken, operation) =>
    runConfirmable(server, ctx, brainOf, runtime.log, hasToken, operation),
  );
  registerIngestTool(server, run);
  registerForgetTool(server, brainOf, runtime.log);

  server.registerTool(
    'sync',
    {
      title: 'Sync',
      description:
        'Sync the brain with its git remote: commit outside edits, pull, push and reindex. Conflicting edits keep both versions.',
      inputSchema: syncInput,
      outputSchema: syncOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args, ctx) =>
      run(ctx, async (brain) =>
        runtime.syncRunner === undefined ? (await brain()).sync(args) : runtime.syncRunner(args),
      ),
  );

  registerConsolidateTool(server, run);

  server.registerTool(
    'undo',
    {
      title: 'Undo',
      description:
        "Undo with git revert: your last operation, one operation (the op id returned by a write) or every agent write of a session (the full session_handle). Undoing a user operation, or giving only the start of an id, needs the user's explicit request (first call returns confirmation_required with a summary and confirm_token). Undoing an undo redoes it.",
      inputSchema: undoInput,
      outputSchema: undoOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) =>
      runConfirmable(server, ctx, brainOf, runtime.log, args.confirm_token !== undefined, (brain, options) =>
        brain.undo(args, options),
      ),
  );
}
