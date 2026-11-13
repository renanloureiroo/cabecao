// Prompts MCP (doc 05, "Resources e prompts"; marco 4): roteiros para as três rotinas do ciclo de vida. São só
// texto: o servidor não tem LLM (ADR 22), então o roteiro diz ao agente que tools chamar e em que ordem. Os prompts
// não leem o cérebro (subir e listar continua sem efeito colateral) e o argumento entra no texto como dado citado.
import { consolidateRoutine, ingestRoutine, reviewRoutine } from '@cabecao/core';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export const PROMPT_NAMES = ['ingest', 'review', 'consolidate'] as const;

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

// O texto dos roteiros mora no núcleo (`routines.ts`): o `cabecao consolidate --run` usa o mesmo da consolidação.
export const ingestPrompt = ingestRoutine;
export const reviewPrompt = reviewRoutine;
export const consolidatePrompt = consolidateRoutine;

const optionalText = (description: string) => z.string().max(1000).describe(description).optional();

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'ingest',
    {
      title: 'Ingest a source',
      description: 'Routine: register a source in raw/ and write the notes from the ingestion plan.',
      argsSchema: z.object({ source: optionalText('File inside the brain, or a short description of the source.') }),
    },
    ({ source }) => userMessage(ingestPrompt(source)),
  );
  server.registerPrompt(
    'review',
    {
      title: 'Review brain health',
      description: 'Routine: run lint and fix what is safe; ask the user about the rest.',
      argsSchema: z.object({ scope: optionalText('"global" or "project:<slug>".') }),
    },
    ({ scope }) => userMessage(reviewPrompt(scope)),
  );
  server.registerPrompt(
    'consolidate',
    {
      title: 'Consolidate memory',
      description: 'Routine: consolidate start, merge repeated episodes and duplicates, consolidate finish.',
      argsSchema: z.object({ scope: optionalText('"global" or "project:<slug>".') }),
    },
    ({ scope }) => userMessage(consolidatePrompt(scope)),
  );
}
