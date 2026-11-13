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
import { registerGraphReadTools, registerRelateTool } from './tools-graph.ts';

/** Roda o sync em outro processo (a CLI faz isso); recebe o `session_handle` do agente, se houver. */
export type SyncRunner = (input: { session_handle?: string }) => Promise<SyncOutput>;

/** O que dura o processo inteiro e é compartilhado por todas as instâncias de servidor. */
export interface ServerRuntime {
  /** Versão do pacote `cabecao`, anunciada em `serverInfo`. */
  readonly version: string;
  readonly brains: BrainProvider;
  /** Quando presente, a tool `sync` usa isto; senão, roda o sync no próprio processo. */
  readonly syncRunner?: SyncRunner;
  /** Diagnóstico; vai para o stderr, nunca para o stdout. */
  readonly log: (message: string) => void;
}

/** Nomes das tools, na ordem em que são registradas. */
export const TOOL_NAMES = [
  'recall',
  'search',
  'read',
  'graph',
  'facts',
  'status',
  'remember',
  'write_page',
  'patch_page',
  'relate',
  'sync',
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

  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        'Save a durable, non-obvious memory (preference, correction, decision and why, gotcha, fact, handoff...) as a new note, committed to git. Never store passwords, tokens or keys.',
      inputSchema: rememberInput,
      outputSchema: writeOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).remember(args)),
  );

  server.registerTool(
    'write_page',
    {
      title: 'Write page',
      description:
        "Create, overwrite or append to a note by path. Validated against the schema, scanned for secrets and committed to git; undo reverts it. raw/ holds immutable sources (create only); the brain's control files (index.md, log.md), files named like AI-client instructions (AGENTS.md, CLAUDE.md, GEMINI.md...) in any folder, sync conflict copies (*.conflict-*) and memory/rules/ are user-only. Editing a note not created by an agent records edited_by (and lowers trust: high to medium).",
      inputSchema: writePageInput,
      outputSchema: writeOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).writePage(args)),
  );

  server.registerTool(
    'patch_page',
    {
      title: 'Patch page',
      description:
        'Replace one exact snippet of a note body. Read the note first and copy `old` verbatim; it must appear exactly once.',
      inputSchema: patchPageInput,
      outputSchema: writeOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).patchPage(args)),
  );

  registerRelateTool(server, run);

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

  server.registerTool(
    'undo',
    {
      title: 'Undo',
      description:
        'Undo with git revert: your last operation, one operation (the full op id returned by a write) or every write of a session (the full session_handle). Only agent operations can be undone here; the user undoes the rest with the CLI. Undoing an undo redoes it.',
      inputSchema: undoInput,
      outputSchema: undoOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).undo(args)),
  );
}
