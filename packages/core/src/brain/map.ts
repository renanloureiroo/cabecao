// Dados do mapa do grafo (`cabecao export canvas`, só da CLI; não é tool do MCP): a vizinhança de uma nota, um escopo
// ou o cérebro inteiro, com todas as arestas entre as notas escolhidas e o rótulo de cada uma.
import { subgraph } from '../db/index.ts';
import type { BrainContext } from './context.ts';
import { withFreshIndex } from './context.ts';
import { BrainError } from './errors.ts';
import { parseAsOf, requireRef, resolveOrThrow } from './graph.ts';

export const DEFAULT_MAP_LIMIT = 60;
export const MAX_MAP_LIMIT = 500;

export interface MapGraphInput {
  /** Nota central (título, caminho, wikilink ou id). Sem ela, o escopo ou o cérebro inteiro. */
  readonly node?: string;
  /** 1 ou 2 saltos a partir da nota central (padrão 1). */
  readonly depth?: number;
  /** Só notas deste escopo (`global` ou `project:<nome>`). */
  readonly scope?: string;
  /** Máximo de notas (padrão 60, até 500). */
  readonly limit?: number;
  readonly as_of?: string;
}

export interface MapGraphNote {
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly scope: string | null;
  readonly distance?: number;
}

export interface MapGraphEdge {
  /** Caminhos das notas. */
  readonly from: string;
  readonly to: string;
  /** Tipo da relação (`uses`, `supersedes`, `subject`...) ou `link`/`embed` para um wikilink. */
  readonly label: string;
}

export interface MapGraphOutput {
  readonly center: string | null;
  readonly scope: string | null;
  readonly depth: 1 | 2 | null;
  readonly notes: readonly MapGraphNote[];
  readonly edges: readonly MapGraphEdge[];
  /** Notas achadas antes do corte por `limit`. */
  readonly total: number;
  readonly omitted: number;
  readonly limit: number;
}

const SCOPE_RE = /^(?:global|project:[\p{L}\p{N}][\p{L}\p{N}._-]*)$/u;

function invalid(message: string): BrainError {
  return new BrainError('invalid_argument', message);
}

export async function mapGraph(ctx: BrainContext, input: MapGraphInput = {}): Promise<MapGraphOutput> {
  const ref = input.node === undefined ? undefined : requireRef(input.node, 'node');
  const depth = input.depth ?? 1;
  if (depth !== 1 && depth !== 2) throw invalid('"depth" deveria ser 1 ou 2');
  const limit = input.limit ?? DEFAULT_MAP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MAP_LIMIT) {
    throw invalid(`"limit" deveria ser um inteiro de 1 a ${MAX_MAP_LIMIT}`);
  }
  if (input.scope !== undefined && !SCOPE_RE.test(input.scope)) {
    throw invalid('"scope" deveria ser "global" ou "project:<nome>"');
  }
  if (ref !== undefined && input.scope !== undefined) throw invalid('use a nota central OU o escopo, não os dois');
  const asOf = parseAsOf(ctx, input.as_of);

  return withFreshIndex(ctx, () => {
    const center = ref === undefined ? null : resolveOrThrow(ctx, ref, 'node').note;
    const result = subgraph(ctx.index, {
      ...(center === null ? {} : { start: center.id, depth }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      limit,
      asOf,
    });
    const pathOf = new Map(result.notes.map((note) => [note.id, note.path]));
    const edges: MapGraphEdge[] = [];
    for (const edge of result.edges) {
      const from = pathOf.get(edge.src);
      const to = pathOf.get(edge.dst);
      if (from === undefined || to === undefined) continue;
      edges.push({ from, to, label: edge.type });
    }
    return {
      center: center?.path ?? null,
      scope: input.scope ?? null,
      depth: center === null ? null : depth,
      notes: result.notes.map((note) => ({
        path: note.path,
        title: note.title,
        type: note.type,
        scope: note.scope,
        ...(note.distance === undefined ? {} : { distance: note.distance }),
      })),
      edges,
      total: result.total,
      omitted: result.total - result.notes.length,
      limit,
    };
  });
}
