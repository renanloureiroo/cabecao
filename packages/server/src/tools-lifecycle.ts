// As tools do ciclo de vida da memória (marco 4): `handoff_save`, `ingest`, `forget`, `lint` e `consolidate`.
// Cascas finas sobre o núcleo, como as de `tools.ts`: a forma da entrada é conferida pelo Zod e as regras (restrições
// de agente, caminho dentro do cérebro, `confirm_token`, ponto de restauração) são do núcleo. A exceção é a
// elicitação do `forget`, que é do protocolo: o servidor pergunta direto ao usuário quando o cliente declara suporte.
import type { McpServer } from '@modelcontextprotocol/server';
import { handoffSaveInput, handoffSaveOutput } from './schemas-lifecycle.ts';
import type { ToolRunner } from './tools-graph.ts';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** `handoff_save`, registrada logo depois de `remember`. */
export function registerHandoffTool(server: McpServer, run: ToolRunner): void {
  server.registerTool(
    'handoff_save',
    {
      title: 'Save handoff',
      description:
        'Before ending a session: save what was done, what is next, decisions and gotchas for the next session (the next recall returns it). Also records the session episode. Needs the session_handle from recall.',
      inputSchema: handoffSaveInput,
      outputSchema: handoffSaveOutput,
      annotations: WRITE,
    },
    (args, ctx) => run(ctx, async (brain) => (await brain()).handoffSave(args)),
  );
}
