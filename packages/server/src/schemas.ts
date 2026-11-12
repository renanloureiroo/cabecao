// Esquemas Zod das tools: entrada (o que o agente manda) e saída (o `structuredContent`, que espelha a saída da
// camada de operações do núcleo, em `snake_case`). As regras de verdade (caminho seguro, esquema da nota, segredos,
// quem pode criar regra) moram no núcleo; aqui só há a forma, para o cliente validar e o agente saber o que mandar.
//
// Campos opcionais usam `exactOptional()`: com `exactOptionalPropertyTypes`, o tipo resultante (`campo?: T`, sem
// `undefined`) é o mesmo das entradas do núcleo, e o JSON Schema publicado é o de um campo opcional comum.
//
// A saída é publicada com `additionalProperties: false`: todo campo que o núcleo devolve tem de estar declarado aqui.
// `checks.ts` confere isso em tempo de compilação, contra os tipos do núcleo.
import { NOTE_TYPES, RECALL_PRIORITY, WRITE_MODES } from '@cabecao/core';
import * as z from 'zod';

// ---------------------------------------------------------------------------------------------------------------
// Peças comuns

const sessionHandle = z
  .string()
  .describe('session_handle returned by recall; ties the commits of this task together.')
  .exactOptional();
const scope = z.string().describe('"global" or "project:<slug>".');
const noteType = z.enum(NOTE_TYPES);

const issue = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  field: z.string().nullable(),
  message: z.string(),
});

const dataItemShape = {
  id: z.string(),
  path: z.string(),
  type: z.string().nullable(),
  title: z.string().nullable(),
  scope: z.string().nullable(),
  validity: z.enum(['current', 'expired']),
  trust: z.string().nullable(),
  origin: z.string().nullable(),
  sources: z.array(z.string()),
  content_kind: z.enum(['note', 'section', 'snippet', 'excerpt']),
  content: z.string(),
};
const dataItem = z.object(dataItemShape);
const dataNotice = z.string();

// ---------------------------------------------------------------------------------------------------------------
// recall

export const recallInput = z.object({
  task: z.string().min(1).describe('What you are about to do; used to find relevant memories.'),
  scope: scope.exactOptional(),
  budget_tokens: z
    .number()
    .int()
    .min(1)
    .describe('Approximate token budget for the briefing (default 2000).')
    .exactOptional(),
});

export const recallOutput = z.object({
  data_notice: dataNotice,
  session_handle: z.string(),
  task: z.string(),
  scope: z.string().nullable(),
  rules: z.array(dataItem),
  handoff: dataItem.nullable(),
  preferences: z.array(dataItem),
  gotchas: z.array(dataItem),
  memories: z.array(dataItem),
  priority: z.array(z.enum(RECALL_PRIORITY)),
  budget_tokens: z.number(),
  used_tokens: z.number(),
  truncated: z.boolean(),
  omitted: z.number(),
  next_step: z.string(),
});

// ---------------------------------------------------------------------------------------------------------------
// search

export const searchInput = z.object({
  query: z.string().min(1).describe('Keywords. Matches all terms first, then any term.'),
  scope: scope.describe('"project:<slug>" also returns global notes; "global" returns only global.').exactOptional(),
  types: z.array(noteType).describe('Only these note types.').exactOptional(),
  limit: z.number().int().min(1).max(100).describe('Max hits (default 10).').exactOptional(),
  budget_tokens: z.number().int().min(1).exactOptional(),
});

export const searchOutput = z.object({
  data_notice: dataNotice,
  query: z.string(),
  mode: z.enum(['and', 'or', 'none']),
  terms: z.array(z.string()),
  hits: z.array(z.object({ ...dataItemShape, score: z.number(), heading_path: z.array(z.string()) })),
  truncated: z.boolean(),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// read

export const readInput = z.object({
  path: z.string().min(1).describe('Note path relative to the brain, e.g. "wiki/entities/SQS.md".').exactOptional(),
  id: z.string().min(1).describe('Note id (ULID). Give path or id, not both.').exactOptional(),
  section: z.string().min(1).describe('Heading text (or "Parent › Child") to read only that section.').exactOptional(),
});

export const readOutput = z.object({
  data_notice: dataNotice,
  note: dataItem,
  frontmatter: z.record(z.string(), z.unknown()),
  frontmatter_error: z.string().nullable(),
  section: z.string().nullable(),
  headings: z.array(z.string()),
  archived: z.boolean(),
  outgoing_links: z.array(
    z.object({
      origin: z.string(),
      type: z.string(),
      target: z.string(),
      path: z.string().nullable(),
      title: z.string().nullable(),
      note_type: z.string().nullable(),
      broken: z.boolean(),
    }),
  ),
  backlinks: z.array(
    z.object({
      origin: z.string(),
      type: z.string(),
      path: z.string(),
      title: z.string().nullable(),
      note_type: z.string().nullable(),
      archived: z.boolean(),
      line: z.number().nullable(),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------------------------
// status

export const statusInput = z.object({});

export const statusOutput = z.object({
  healthy: z.boolean(),
  problems: z.array(z.string()),
  root: z.string(),
  client: z.string(),
  machine: z.string(),
  brain_schema_version: z.number(),
  note_dirs: z.array(z.string()),
  notes: z.object({
    total: z.number(),
    by_type: z.record(z.string(), z.number()),
    untyped: z.number(),
    archived: z.number(),
    unmanaged: z.number(),
  }),
  index: z.object({
    schema_version: z.number(),
    expected_schema_version: z.number(),
    chunks: z.number(),
    edges: z.number(),
    facts: z.number(),
    last_scan_at: z.string().nullable(),
    last_scan_ms: z.number().nullable(),
  }),
  broken_links: z.number(),
  sync: z
    .object({
      branch: z.string().nullable(),
      remote_configured: z.boolean(),
      remote: z.object({ name: z.string(), url: z.string(), branch: z.string() }).nullable(),
      last_sync: z.object({ at: z.string(), status: z.string(), message: z.string() }).nullable(),
      unpushed: z.number().nullable(),
      unpulled: z.number().nullable(),
      pending_changes: z.number(),
      running: z.boolean(),
    })
    .nullable(),
  conflicts: z.array(
    z.object({
      copy: z.string(),
      original: z.string(),
      original_exists: z.boolean(),
      machine: z.string(),
      date: z.string(),
    }),
  ),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// Escritas

export const rememberInput = z.object({
  content: z.string().describe('Note body in Markdown, in the user language.'),
  type: noteType.describe('preference, gotcha, decision, fact, procedure, episode, handoff... "rule" is user-only.'),
  title: z.string().describe('Short title; defaults to the first line of content.').exactOptional(),
  scope: scope.describe('"global" (default) or "project:<slug>".').exactOptional(),
  tags: z.array(z.string()).exactOptional(),
  relations: z
    .record(z.string(), z.array(z.string()))
    .describe('Typed relations, e.g. {"uses": ["SQS"], "part_of": ["Projeto Atlas"]}.')
    .exactOptional(),
  subject: z.string().describe('type fact only.').exactOptional(),
  predicate: z.string().describe('type fact only.').exactOptional(),
  object: z.string().describe('type fact only.').exactOptional(),
  valid_from: z.string().describe('YYYY-MM-DD').exactOptional(),
  valid_until: z.string().describe('YYYY-MM-DD').exactOptional(),
  expires_at: z.string().describe('YYYY-MM-DD').exactOptional(),
  sources: z.array(z.string()).describe('Source notes; become wikilinks.').exactOptional(),
  session_handle: sessionHandle,
});

export const writePageInput = z.object({
  path: z.string().min(1).describe('Note path relative to the brain, ending in .md.'),
  content: z.string().describe('Body in Markdown (no frontmatter).'),
  mode: z
    .enum(WRITE_MODES)
    .describe(
      'create: must not exist, needs frontmatter.type. overwrite: replaces the body (and the frontmatter, if given). append: adds to the end of the body.',
    ),
  frontmatter: z
    .record(z.string(), z.unknown())
    .describe('YAML fields; id/created/updated/origin are managed.')
    .exactOptional(),
  session_handle: sessionHandle,
});

export const patchPageInput = z.object({
  path: z.string().min(1),
  old: z.string().min(1).describe('Exact text from the body; must appear exactly once.'),
  new: z.string().describe('Replacement text.'),
  session_handle: sessionHandle,
});

export const writeOutput = z.object({
  op: z.string(),
  path: z.string(),
  id: z.string().nullable(),
  action: z.enum(['add', 'update']),
  changed: z.boolean(),
  commit: z.string().nullable(),
  warnings: z.array(issue),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// sync

export const syncInput = z.object({ session_handle: sessionHandle });

export const syncOutput = z.object({
  status: z.enum(['ok', 'busy', 'blocked', 'offline', 'error']),
  message: z.string(),
  pulled: z.number(),
  pushed: z.number(),
  committed: z.number(),
  conflicts: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['content', 'delete']),
      copy: z.string().nullable(),
      kept: z.enum(['remote', 'local']).nullable(),
    }),
  ),
  changed_paths: z.array(z.string()),
  secrets: z.array(
    z.object({
      path: z.string(),
      line: z.number(),
      column: z.number(),
      rule: z.string(),
      description: z.string(),
      where: z.enum(['pending', 'outgoing']),
    }),
  ),
  attempts: z.number(),
  ms: z.number(),
  branch: z.string().nullable(),
  remote: z.string().nullable(),
  integration: z.enum(['none', 'fast-forward', 'replay', 'merge']),
  reason: z.enum(['secrets', 'git-operation', 'detached-head']).nullable(),
  remote_error: z.object({ category: z.string(), detail: z.string() }).nullable(),
  recovered: z.array(z.string()),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// undo

export const undoInput = z.object({
  op: z
    .string()
    .min(1)
    .describe('Operation id (op from a write result) or its prefix. Omit to undo the last one.')
    .exactOptional(),
  session: z.string().min(1).describe('Undo every write of this session_handle, in one commit.').exactOptional(),
  session_handle: sessionHandle,
});

export const undoOutput = z.object({
  op: z.string(),
  commit: z.string().nullable(),
  undone: z.array(z.object({ op: z.string(), commit: z.string(), changes: z.array(z.string()) })),
  changed_paths: z.array(z.string()),
  warnings: z.array(issue),
  next_step: z.string().exactOptional(),
});
