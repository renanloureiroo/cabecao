// Esquemas Zod das tools do ciclo de vida da memória (marco 4): a saída do `remember` (com duplicatas e
// contradições) e as tools `handoff_save`, `ingest`, `forget`, `lint` e `consolidate`. Mesmas regras de `schemas.ts`:
// aqui só a forma; a validação de verdade é do núcleo. A saída espelha a do núcleo e é conferida em `checks.ts`.
import * as z from 'zod';
import { dataNotice, issue } from './schemas.ts';

// ---------------------------------------------------------------------------------------------------------------
// remember

export const rememberOutput = z.object({
  data_notice: dataNotice,
  decision: z.enum(['created', 'updated', 'superseded', 'skipped', 'needs_resolution']),
  op: z.string(),
  path: z.string().nullable(),
  id: z.string().nullable(),
  action: z.enum(['add', 'update']).nullable(),
  changed: z.boolean(),
  commit: z.string().nullable(),
  warnings: z.array(issue),
  superseded: z.object({ id: z.string(), path: z.string() }).nullable(),
  candidates: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      title: z.string().nullable(),
      type: z.string().nullable(),
      scope: z.string().nullable(),
      trust: z.string().nullable(),
      origin: z.string().nullable(),
      edited_by: z.string().nullable(),
      verdict: z.enum(['duplicate', 'subsumed', 'complement', 'contradiction', 'ambiguous', 'distinct']),
      similarity: z.number(),
      cosine: z.number().nullable(),
      reason: z.string(),
      content: z.string(),
    }),
  ),
  reason: z.string(),
  next_step: z.string().exactOptional(),
});
