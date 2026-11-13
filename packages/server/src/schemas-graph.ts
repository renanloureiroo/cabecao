// Esquemas Zod das tools do marco 3: `graph`, `facts` e `relate`. Mesmas regras de `schemas.ts`: aqui só a forma;
// a validação de verdade (data possível, tipo de relação conhecido, referência que resolve, restrições de agente)
// é do núcleo. A saída espelha a do núcleo e é conferida em tempo de compilação em `checks.ts`.
import { MAX_FACTS_LIMIT, MAX_GRAPH_LIMIT } from '@cabecao/core';
import * as z from 'zod';
import { dataItemShape, dataNotice, INPUT_LIMITS, sessionHandle, shortText, text, writeOutput } from './schemas.ts';
import { asOfInput, graphNodeShape, validity } from './schemas-node.ts';

const noteRef = (what: string) =>
  text(INPUT_LIMITS.path).min(1).describe(`${what}: note title, path, [[wikilink]] or id.`);

// ---------------------------------------------------------------------------------------------------------------
// graph

export const graphInput = z.object({
  node: noteRef('The note'),
  depth: z.number().int().min(1).max(2).describe('1 (default) or 2 hops.').exactOptional(),
  relation_types: z
    .array(shortText())
    .max(50)
    .describe(
      'Only these edge kinds: typed relations (uses, part_of, depends_on, decided_by, works_on, related_to, or custom ones), supersedes, superseded_by, wikilink, fact, mention.',
    )
    .exactOptional(),
  as_of: asOfInput.exactOptional(),
  limit: z.number().int().min(1).max(MAX_GRAPH_LIMIT).describe('Max neighbors (default 50).').exactOptional(),
  budget_tokens: z.number().int().min(1).describe('Approximate token budget (default 3000).').exactOptional(),
});

const graphLink = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string(),
  origin: z.string(),
  direction: z.enum(['out', 'in']),
  validity,
});

export const graphOutput = z.object({
  data_notice: dataNotice,
  node: z.object(graphNodeShape),
  resolved_by: z.enum(['id', 'path', 'link', 'title', 'alias']),
  as_of: z.string(),
  depth: z.union([z.literal(1), z.literal(2)]),
  relation_types: z.array(z.string()).nullable(),
  neighbors: z.array(z.object({ ...graphNodeShape, distance: z.number(), links: z.array(graphLink) })),
  total: z.number(),
  truncated: z.boolean(),
  omitted: z.number(),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// facts

export const factsInput = z.object({
  subject: noteRef('Subject').exactOptional(),
  predicate: shortText().min(1).describe('Predicate, e.g. "uses_queue", "led_by".').exactOptional(),
  object: noteRef('Object (or a plain value)').exactOptional(),
  as_of: asOfInput.exactOptional(),
  limit: z.number().int().min(1).max(MAX_FACTS_LIMIT).describe('Max facts (default 50).').exactOptional(),
});

const factRef = z.object({ query: z.string(), path: z.string().nullable() });

export const factsOutput = z.object({
  data_notice: dataNotice,
  as_of: z.string(),
  subject: factRef.nullable(),
  predicate: z.string().nullable(),
  object: factRef.nullable(),
  facts: z.array(
    z.object({
      ...dataItemShape,
      subject: z.string().nullable(),
      subject_path: z.string().nullable(),
      predicate: z.string().nullable(),
      object: z.string().nullable(),
      object_path: z.string().nullable(),
      valid_from: z.string().nullable(),
      valid_until: z.string().nullable(),
      superseded_on: z.string().nullable(),
      supersedes: z.array(z.string()),
      superseded_by: z.array(z.string()),
    }),
  ),
  total: z.number(),
  truncated: z.boolean(),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// relate

export const relateInput = z.object({
  from: noteRef('Note that gets the relation'),
  type: shortText()
    .min(1)
    .describe(
      'Relation: uses, part_of, depends_on, decided_by, works_on, related_to, supersedes, superseded_by, or one from .cabecao.json.',
    ),
  to: noteRef('Target note (must exist)'),
  session_handle: sessionHandle,
});

export const relateOutput = writeOutput.extend({
  relation: z.object({ from: z.string(), type: z.string(), to: z.string(), link: z.string() }),
});
