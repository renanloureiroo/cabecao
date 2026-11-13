// Esquemas Zod das tools: entrada (o que o agente manda) e saída (o `structuredContent`, que espelha a saída da
// camada de operações do núcleo, em `snake_case`). As regras de verdade (caminho seguro, esquema da nota, segredos,
// quem pode criar regra) moram no núcleo; aqui só há a forma, para o cliente validar e o agente saber o que mandar.
//
// Campos opcionais usam `exactOptional()`: com `exactOptionalPropertyTypes`, o tipo resultante (`campo?: T`, sem
// `undefined`) é o mesmo das entradas do núcleo, e o JSON Schema publicado é o de um campo opcional comum.
//
// A saída é publicada com `additionalProperties: false`: todo campo que o núcleo devolve tem de estar declarado aqui.
// `checks.ts` confere isso em tempo de compilação, contra os tipos do núcleo.
import { NOTE_TYPES, RECALL_PRIORITY, SEARCH_MODES, VALIDITIES, WRITE_MODES } from '@cabecao/core';
import * as z from 'zod';
import { asOfInput, relatedItem } from './schemas-node.ts';

// ---------------------------------------------------------------------------------------------------------------
// Limites de tamanho das entradas
//
// Em caracteres (o que o `.max()` do Zod conta). Existem para o agente receber um erro claro, com o limite, em vez
// de o pedido estourar o limite de uma mensagem do transporte stdio (`MAX_MESSAGE_BYTES`, em `stdio.ts`), que
// derrubaria a conexão. Uma nota de 1 MB já é enorme: o corpo tem folga para isso e não mais; os textos curtos
// (título, caminho, busca) têm limites de texto curto.
export const INPUT_LIMITS = {
  /** Corpo de uma nota (`remember`, `write_page`) e cada lado do `patch_page`. */
  content: 1_000_000,
  /** Caminho de nota. */
  path: 1_024,
  /** Título, sujeito, predicado e objeto de um fato, escopo, datas, identificadores, seção. */
  short: 1_000,
  /** O texto da busca (`search`) e a tarefa do `recall`. */
  query: 4_000,
  /** Itens de uma lista (`tags`, `sources`, alvos de relação) e chaves de relação. */
  listItems: 500,
} as const;

/** `z.string()` com teto e uma mensagem que diz qual é o teto. */
export const text = (max: number) =>
  z.string().max(max, { error: `texto grande demais: o limite é ${max.toLocaleString('pt-BR')} caracteres` });
export const shortText = () => text(INPUT_LIMITS.short);
const list = () =>
  z
    .array(shortText())
    .max(INPUT_LIMITS.listItems, { error: `lista grande demais: o limite é ${INPUT_LIMITS.listItems} itens` });

// ---------------------------------------------------------------------------------------------------------------
// Peças comuns

export const sessionHandle = shortText()
  .describe('session_handle returned by recall; ties the commits of this task together.')
  .exactOptional();
const scope = shortText().describe('"global" or "project:<slug>".');
const noteType = z.enum(NOTE_TYPES);

export const issue = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  field: z.string().nullable(),
  message: z.string(),
});

export const dataItemShape = {
  id: z.string(),
  path: z.string(),
  type: z.string().nullable(),
  title: z.string().nullable(),
  scope: z.string().nullable(),
  validity: z.enum(VALIDITIES),
  trust: z.string().nullable(),
  origin: z.string().nullable(),
  edited_by: z.string().nullable(),
  sources: z.array(z.string()),
  content_kind: z.enum(['note', 'section', 'snippet', 'excerpt']),
  content: z.string(),
};
const dataItem = z.object(dataItemShape);
export const dataNotice = z.string();

// ---------------------------------------------------------------------------------------------------------------
// recall

export const recallInput = z.object({
  task: text(INPUT_LIMITS.query).min(1).describe('What you are about to do; used to find relevant memories.'),
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
  query: text(INPUT_LIMITS.query).min(1).describe('What you are looking for: keywords or a natural-language question.'),
  scope: scope.describe('"project:<slug>" also returns global notes; "global" returns only global.').exactOptional(),
  types: z.array(noteType).describe('Only these note types.').exactOptional(),
  limit: z.number().int().min(1).max(100).describe('Max hits (default 10).').exactOptional(),
  budget_tokens: z.number().int().min(1).exactOptional(),
  as_of: asOfInput.exactOptional(),
  mode: z
    .enum(SEARCH_MODES)
    .describe(
      'auto (default): hybrid (keywords + meaning) when semantic search is enabled on this machine, else keywords. keyword, semantic or hybrid force a mode; mode_used says what ran.',
    )
    .exactOptional(),
});

export const searchOutput = z.object({
  data_notice: dataNotice,
  query: z.string(),
  mode: z.enum(['and', 'or', 'none']),
  mode_requested: z.enum(SEARCH_MODES),
  mode_used: z.enum(['keyword', 'semantic', 'hybrid']),
  mode_reason: z.string(),
  warnings: z.array(z.string()),
  terms: z.array(z.string()),
  as_of: z.string(),
  hits: z.array(z.object({ ...dataItemShape, score: z.number(), heading_path: z.array(z.string()) })),
  related: z.array(relatedItem),
  truncated: z.boolean(),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// read

export const readInput = z.object({
  path: text(INPUT_LIMITS.path)
    .min(1)
    .describe('Note path relative to the brain, e.g. "wiki/entities/SQS.md".')
    .exactOptional(),
  id: shortText().min(1).describe('Note id (ULID). Give path or id, not both.').exactOptional(),
  section: shortText().min(1).describe('Heading text (or "Parent › Child") to read only that section.').exactOptional(),
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
  embeddings: z
    .object({
      configured: z.boolean(),
      model: z.string().nullable(),
      variant: z.string().nullable(),
      dims: z.number().nullable(),
      recipe: z.number().nullable(),
      revision: z.string().nullable(),
      model_dir: z.string().nullable(),
      enabled_here: z.boolean(),
      runtime: z.string(),
      runtime_detail: z.string().nullable(),
      loaded: z.boolean(),
      backend: z.string().nullable(),
      chunks: z.number(),
      with_vector: z.number().nullable(),
      pending: z.number().nullable(),
      vectors: z.number().nullable(),
      generation: z.number().nullable(),
      problem: z.string().nullable(),
    })
    .nullable(),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// Escritas

export const rememberInput = z.object({
  content: text(INPUT_LIMITS.content).describe('Note body in Markdown, in the user language (up to 1,000,000 chars).'),
  type: noteType.describe('preference, gotcha, decision, fact, procedure, episode, handoff... "rule" is user-only.'),
  title: shortText().describe('Short title; defaults to the first line of content.').exactOptional(),
  scope: scope.describe('"global" (default) or "project:<slug>".').exactOptional(),
  tags: list().exactOptional(),
  aliases: list().describe('Other names of the note; they also find unlinked mentions of it.').exactOptional(),
  relations: z
    .record(shortText(), list())
    .describe('Typed relations, e.g. {"uses": ["SQS"], "part_of": ["Projeto Atlas"]}.')
    .exactOptional(),
  subject: shortText().describe('type fact only.').exactOptional(),
  predicate: shortText().describe('type fact only.').exactOptional(),
  object: shortText().describe('type fact only.').exactOptional(),
  valid_from: shortText().describe('YYYY-MM-DD').exactOptional(),
  valid_until: shortText().describe('YYYY-MM-DD').exactOptional(),
  expires_at: shortText().describe('YYYY-MM-DD').exactOptional(),
  sources: list().describe('Source notes; become wikilinks.').exactOptional(),
  session_handle: sessionHandle,
  resolution: shortText()
    .describe('Answer to decision "needs_resolution": create, skip, update:<id> or supersede:<id> (a candidate id).')
    .exactOptional(),
});

export const writePageInput = z.object({
  path: text(INPUT_LIMITS.path).min(1).describe('Note path relative to the brain, ending in .md.'),
  content: text(INPUT_LIMITS.content).describe('Body in Markdown (no frontmatter), up to 1,000,000 chars.'),
  mode: z
    .enum(WRITE_MODES)
    .describe(
      'create: must not exist, needs frontmatter.type. overwrite: replaces the body (and the frontmatter, if given). append: adds to the end of the body. Files in raw/ (immutable sources) can only be created.',
    ),
  frontmatter: z
    .record(shortText(), z.unknown())
    .describe('YAML fields; id/created/updated/origin/edited_by are managed, and "type: rule" is user-only.')
    .exactOptional(),
  session_handle: sessionHandle,
});

export const patchPageInput = z.object({
  path: text(INPUT_LIMITS.path).min(1),
  old: text(INPUT_LIMITS.content).min(1).describe('Exact text from the body; must appear exactly once.'),
  new: text(INPUT_LIMITS.content).describe('Replacement text.'),
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
      kind: z.enum(['content', 'delete', 'invalid']),
      copy: z.string().nullable(),
      kept: z.enum(['remote', 'local']).nullable(),
      reason: z.string().nullable(),
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
  reason: z.enum(['secrets', 'unscannable', 'local-file', 'git-operation', 'detached-head']).nullable(),
  remote_error: z.object({ category: z.string(), detail: z.string() }).nullable(),
  recovered: z.array(z.string()),
  config_problem: z.string().nullable(),
  index: z
    .object({
      participating: z.boolean(),
      generation: z.number().nullable(),
      received: z.number(),
      computed: z.number(),
      pushed: z.number(),
      pending: z.number().nullable(),
      graph_written: z.boolean(),
      skipped: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  next_step: z.string().exactOptional(),
});

// ---------------------------------------------------------------------------------------------------------------
// undo

export const undoInput = z.object({
  op: shortText()
    .min(1)
    .describe('Full operation id (op from a write result). Omit to undo your last operation.')
    .exactOptional(),
  session: shortText()
    .min(1)
    .describe('Full session_handle: undo every write of that session, in one commit.')
    .exactOptional(),
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
