// Esquemas Zod das tools do ciclo de vida da memória (marco 4): a saída do `remember` (com duplicatas e
// contradições) e as tools `handoff_save`, `ingest`, `forget`, `lint` e `consolidate`. Mesmas regras de `schemas.ts`:
// aqui só a forma; a validação de verdade é do núcleo. A saída espelha a do núcleo e é conferida em `checks.ts`.
import { HANDOFF_ITEM_MAX_CHARS, HANDOFF_MAX_ITEMS } from '@cabecao/core';
import * as z from 'zod';
import { dataNotice, issue, shortText, text } from './schemas.ts';

// ---------------------------------------------------------------------------------------------------------------
// handoff_save

const handoffItems = (what: string) =>
  z
    .array(text(HANDOFF_ITEM_MAX_CHARS))
    .max(HANDOFF_MAX_ITEMS, { error: `lista grande demais: o limite é ${HANDOFF_MAX_ITEMS} itens` })
    .describe(`${what}; one item per line.`)
    .exactOptional();

export const handoffSaveInput = z.object({
  session_handle: shortText().min(1).describe('session_handle returned by recall (required).'),
  done: handoffItems('What was done'),
  next: handoffItems('What is left, in order'),
  decisions: handoffItems('Decisions and why'),
  gotchas: handoffItems('Gotchas found'),
  scope: shortText().describe('"global" (default) or "project:<slug>".').exactOptional(),
  title: shortText().exactOptional(),
});

export const noteRef = z.object({ id: z.string().nullable(), path: z.string() });

export const handoffSaveOutput = z.object({
  op: z.string(),
  commit: z.string().nullable(),
  handoff: noteRef,
  episode: noteRef.nullable(),
  supersedes: noteRef.nullable(),
  expires_at: z.string(),
  warnings: z.array(issue),
  next_step: z.string(),
});

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
