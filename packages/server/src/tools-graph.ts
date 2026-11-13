// As três tools do marco 3: `graph` e `facts` (leitura) e `relate` (escrita). Cascas finas sobre o núcleo, como as
// de `tools.ts`: a forma da entrada é conferida pelo Zod e as regras (resolução da nota, data, restrições de agente)
// são do núcleo.
import type { Brain, ConfirmOptions } from '@cabecao/core';
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { factsInput, factsOutput, graphInput, graphOutput, relateInput, relateOutput } from './schemas-graph.ts';

/** Executa a operação e monta o resultado (o `run` de `tools.ts`). */
export type ToolRunner = (
  ctx: ServerContext,
  operation: (brain: () => Promise<Brain>) => Promise<object>,
) => Promise<CallToolResult>;

/** `graph` e `facts`, registradas logo depois de `read`. */
export function registerGraphReadTools(server: McpServer, run: ToolRunner, readOnly: ToolAnnotations): void {
  server.registerTool(
    'graph',
    {
      title: 'Graph',
      description:
        "Neighbors of a note in the brain's graph (1 or 2 hops): typed relations, wikilinks, facts, supersedes chains and unlinked mentions, each with its type, direction and validity on as_of. Use it to follow links from a search hit.",
      inputSchema: graphInput,
      outputSchema: graphOutput,
      annotations: readOnly,
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).graph(args)),
  );

  server.registerTool(
    'facts',
    {
      title: 'Facts',
      description:
        'Atomic facts (subject, predicate, object) and whether each holds on as_of (default today), with the supersedes / superseded_by chain. Expired facts are listed, never hidden. Subject and object accept a note title, path or id.',
      inputSchema: factsInput,
      outputSchema: factsOutput,
      annotations: readOnly,
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).facts(args)),
  );
}

/** Executa uma escrita que pode pedir confirmação (o `runConfirmable` de `tools-lifecycle.ts`). */
export type ConfirmableRunner = (
  ctx: ServerContext,
  hasToken: boolean,
  operation: (brain: Brain, options: ConfirmOptions) => Promise<object>,
) => Promise<CallToolResult | InputRequiredResult>;

/** `relate`, registrada logo depois de `patch_page`. */
export function registerRelateTool(server: McpServer, run: ConfirmableRunner): void {
  server.registerTool(
    'relate',
    {
      title: 'Relate',
      description:
        "Add a typed relation (uses, part_of, depends_on, decided_by, works_on, related_to, supersedes...) from one existing note to another, as a wikilink in the note's frontmatter, committed to git. Idempotent. Same limits as write_page: rules and raw/ notes need the user's explicit request (confirm_token); editing a user note records edited_by.",
      inputSchema: relateInput,
      outputSchema: relateOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx, args.confirm_token !== undefined, (brain, options) => brain.relate(args, options)),
  );
}
