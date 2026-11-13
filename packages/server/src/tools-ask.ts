// A tool `ask` (decisão 38): resposta gerada pelo provedor que o USUÁRIO ativou nesta máquina, com cada citação
// conferida pelo Cabeção. Só é registrada (e só aparece em `tools/list`) quando a CLI passa um `AskRunner`, isto é,
// quando há provedor ativo e o cérebro permite. O agente não escolhe nem vê o provedor ou o modelo: a entrada só tem
// opções de recuperação, e a saída é a mesma para qualquer provedor. Falha de provedor nunca vira erro MCP: volta
// `status: "unavailable"` com os trechos recuperados; erro MCP só para entrada inválida.
import type { AskInput, AskOutput, Brain } from '@cabecao/core';
import {
  ASK_STATUSES,
  MAX_ASK_LIMIT,
  MAX_QUESTION_CHARS,
  NOTE_TYPES,
  UNAVAILABLE_REASONS,
  VALIDITIES,
} from '@cabecao/core';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { dataNotice, shortText } from './schemas.ts';
import { asOfInput } from './schemas-node.ts';
import type { ToolRunner } from './tools-graph.ts';

/** Faz a pergunta com os provedores da máquina (a CLI injeta). `signal`: o cliente desistiu da chamada. */
export type AskRunner = (brain: Brain, input: AskInput, signal?: AbortSignal) => Promise<AskOutput>;

export const askInput = z.object({
  question: z
    .string()
    .min(1)
    .max(MAX_QUESTION_CHARS, { error: `pergunta grande demais: o limite é ${MAX_QUESTION_CHARS} caracteres` })
    .describe("A question about the user's notes, in natural language."),
  scope: shortText().describe('"project:<slug>" (also uses global notes) or "global".').exactOptional(),
  types: z.array(z.enum(NOTE_TYPES)).max(20).describe('Only these note types.').exactOptional(),
  as_of: asOfInput.exactOptional(),
  limit: z.number().int().min(1).max(MAX_ASK_LIMIT).describe('Max notes used as sources (default 10).').exactOptional(),
});

const validity = z.enum(VALIDITIES);

export const askOutput = z.object({
  data_notice: dataNotice,
  status: z.enum(ASK_STATUSES),
  question: z.string(),
  answer: z.string(),
  claims: z.array(z.object({ text: z.string(), supported: z.boolean(), citations: z.array(z.number()) })),
  citations: z.array(
    z.object({
      n: z.number(),
      id: z.string(),
      path: z.string(),
      title: z.string().nullable(),
      heading_path: z.array(z.string()),
      section: z.string().nullable(),
      quote: z.string(),
      validity,
      trust: z.string().nullable(),
      origin: z.string().nullable(),
      edited_by: z.string().nullable(),
      related: z.boolean(),
    }),
  ),
  unsupported_claims: z.number(),
  removed_citations: z.number(),
  missing: z.string().nullable(),
  omitted: z.object({
    private: z.number(),
    policy: z.number(),
    secret: z.number(),
    control: z.number(),
    budget: z.number(),
  }),
  as_of: z.string(),
  unavailable_reason: z.enum(UNAVAILABLE_REASONS).exactOptional(),
  passages: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        title: z.string().nullable(),
        type: z.string().nullable(),
        heading_path: z.array(z.string()),
        validity,
        trust: z.string().nullable(),
        origin: z.string().nullable(),
        edited_by: z.string().nullable(),
        related: z.boolean(),
        content: z.string(),
      }),
    )
    .exactOptional(),
  next_step: z.string(),
});

export const ASK_INSTRUCTIONS =
  ' Para uma pergunta que pede síntese de várias notas, `ask` devolve uma resposta pronta com citações conferidas; para algo simples, prefira `search`. Se `ask` voltar `unavailable`, responda você mesmo a partir de `passages`.';

export function registerAskTool(server: McpServer, run: ToolRunner, runner: AskRunner): void {
  server.registerTool(
    'ask',
    {
      title: 'Ask',
      description:
        "Answer a question from the user's second brain. Retrieves passages (like search), has them answered by the answer provider the user enabled on this machine, and checks every citation: the cited passage must exist and the quote must appear in it verbatim. Claims without a checked citation are marked [sem apoio]; with none, status is not_found (do not make up an answer). If no provider is available, status is unavailable and passages holds what was retrieved, so you can answer yourself. Each citation has id and section for read. Read-only.",
      inputSchema: askInput,
      outputSchema: askOutput,
      // lê o cérebro e chama um serviço de fora (o provedor que o usuário ativou); não grava nada
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx: ServerContext) => run(ctx, async (brain) => runner(await brain(), args as AskInput, ctx.mcpReq.signal)),
  );
}
