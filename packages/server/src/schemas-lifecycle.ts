// Esquemas Zod das tools do ciclo de vida da memória (marco 4): a saída do `remember` (com duplicatas e
// contradições) e as tools `handoff_save`, `ingest`, `forget`, `lint` e `consolidate`. Mesmas regras de `schemas.ts`:
// aqui só a forma; a validação de verdade é do núcleo. A saída espelha a do núcleo e é conferida em `checks.ts`.
import { HANDOFF_ITEM_MAX_CHARS, HANDOFF_MAX_ITEMS, LINT_RULES, MAX_LINT_LIMIT } from '@cabecao/core';
import * as z from 'zod';
import { dataNotice, INPUT_LIMITS, issue, sessionHandle, shortText, text } from './schemas.ts';

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

// ---------------------------------------------------------------------------------------------------------------
// ingest

export const ingestInput = z.object({
  path: text(INPUT_LIMITS.path)
    .min(1)
    .describe('A text file inside the brain (relative path). Files outside the brain cannot be read.')
    .exactOptional(),
  content: text(INPUT_LIMITS.content).describe('The source text (with title), up to 1,000,000 chars.').exactOptional(),
  title: shortText().exactOptional(),
  source: shortText().describe('Where it came from: URL or original file name.').exactOptional(),
  scope: shortText()
    .describe('Scope for the notes in the plan: "global" (default) or "project:<slug>".')
    .exactOptional(),
  session_handle: sessionHandle,
});

export const ingestOutput = z.object({
  data_notice: dataNotice,
  op: z.string(),
  commit: z.string().nullable(),
  source: z.object({
    path: z.string(),
    title: z.string(),
    origin: z.string(),
    trust: z.literal('low'),
    chars: z.number(),
    registered: z.boolean(),
  }),
  plan: z.object({
    read: z.array(z.string()),
    create: z.array(z.object({ path: z.string(), frontmatter: z.record(z.string(), z.unknown()) })),
    update: z.array(
      z.object({
        path: z.string(),
        title: z.string().nullable(),
        type: z.string().nullable(),
        reason: z.enum(['mention', 'related']),
      }),
    ),
    steps: z.array(z.string()),
  }),
  warnings: z.array(issue),
  next_step: z.string(),
});

// ---------------------------------------------------------------------------------------------------------------
// lint

export const lintInput = z.object({
  rules: z.array(z.enum(LINT_RULES)).describe('Only these rules (default: all).').exactOptional(),
  scope: shortText().describe('"project:<slug>" (plus global) or "global".').exactOptional(),
  limit: z.number().int().min(1).max(MAX_LINT_LIMIT).describe('Max findings (default 200).').exactOptional(),
});

export const lintFinding = z.object({
  rule: z.enum(LINT_RULES),
  severity: z.enum(['error', 'warning', 'info']),
  path: z.string(),
  line: z.number().nullable(),
  message: z.string(),
  fix: z.string(),
  related: z.array(z.string()),
});

export const lintOutput = z.object({
  data_notice: dataNotice,
  findings: z.array(lintFinding),
  counts: z.object({ error: z.number(), warning: z.number(), info: z.number() }),
  by_rule: z.record(z.string(), z.number()),
  checked_notes: z.number(),
  total: z.number(),
  truncated: z.boolean(),
  next_step: z.string().exactOptional(),
});
