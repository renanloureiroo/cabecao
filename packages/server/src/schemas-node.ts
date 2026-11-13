// Peças de esquema do grafo (marco 3) usadas também pela busca: a nota do grafo (sem conteúdo, com validade e
// proveniência), o item do bloco `related` e a data `as_of`. Ficam num arquivo próprio para `schemas.ts` e
// `schemas-graph.ts` usarem sem um importar o outro.
import { VALIDITIES } from '@cabecao/core';
import * as z from 'zod';

export const validity = z.enum(VALIDITIES);

export const graphNodeShape = {
  id: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  type: z.string().nullable(),
  scope: z.string().nullable(),
  validity,
  trust: z.string().nullable(),
  origin: z.string().nullable(),
  edited_by: z.string().nullable(),
};

export const asOfInput = z
  .string()
  .max(64)
  .describe(
    'Date YYYY-MM-DD (default today). Validity is computed on this date; pass a past date for questions about the past.',
  );

export const relatedItem = z.object({
  ...graphNodeShape,
  score: z.number(),
  reasons: z.array(
    z.object({
      from: z.string(),
      type: z.string(),
      origin: z.string(),
      direction: z.enum(['out', 'in']),
      validity,
    }),
  ),
});
