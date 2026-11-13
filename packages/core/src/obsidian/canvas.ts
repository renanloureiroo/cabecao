// Mapa do grafo em JSON Canvas 1.0 (jsoncanvas.org/spec/1.0), o formato dos arquivos `.canvas` do Obsidian (doc 09,
// "Mapas"). Função pura e determinística: a mesma entrada dá os mesmos bytes, então reexportar não embaralha o arquivo
// (ids derivados do caminho, nada de data ou de caminho absoluto).
//
// Layout: uma coluna por grupo de cor (os mesmos grupos e cores do grafo do Obsidian), cada grupo numa caixa `group`
// rotulada; dentro dela as notas em grade, sem sobreposição. As arestas levam como rótulo o tipo da relação.
import { createHash } from 'node:crypto';
import type { ColorGroup } from './palette.ts';
import { COLOR_GROUPS, groupOf, OTHER_GROUP } from './palette.ts';

export interface CanvasNoteInput {
  /** Caminho relativo à raiz do cérebro, com `/`. */
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  /** Distância até a nota central (0 = ela); ausente quando o mapa é de um escopo. */
  readonly distance?: number;
}

export interface CanvasEdgeInput {
  readonly from: string;
  readonly to: string;
  /** Tipo da relação (`uses`, `supersedes`, `subject`...) ou `link` para um wikilink. */
  readonly label: string;
}

export interface CanvasInput {
  readonly notes: readonly CanvasNoteInput[];
  readonly edges: readonly CanvasEdgeInput[];
  /** Texto da legenda (Markdown). */
  readonly legend?: string;
  /** Caminho da nota central, que vem primeiro no grupo dela. */
  readonly center?: string;
}

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';

export interface CanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: string;
  label?: string;
}

export interface JsonCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Medidas do layout, em pixels (inteiros, como a especificação exige). */
export const CANVAS_LAYOUT = {
  nodeWidth: 280,
  nodeHeight: 80,
  gapX: 40,
  gapY: 30,
  padding: 40,
  groupGap: 160,
  rowsPerColumn: 10,
  legendWidth: 560,
  legendHeight: 140,
} as const;

const L = CANVAS_LAYOUT;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const hashId = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/** Id estável de uma nota no mapa: o hash do caminho. */
export function canvasNodeId(path: string): string {
  return hashId(`file\0${path}`);
}

function sideBetween(a: CanvasNode, b: CanvasNode): { from: CanvasSide; to: CanvasSide } {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0)
    return dx > 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

/**
 * Monta o canvas. Notas repetidas (mesmo caminho) entram uma vez; arestas para notas que não estão no mapa, laços e
 * arestas repetidas (mesma origem, destino e rótulo) ficam de fora.
 */
export function buildCanvas(input: CanvasInput): JsonCanvas {
  const notes = new Map<string, CanvasNoteInput>();
  for (const note of input.notes) if (!notes.has(note.path)) notes.set(note.path, note);

  const byGroup = new Map<ColorGroup, CanvasNoteInput[]>();
  for (const note of notes.values()) {
    const group = groupOf(note);
    const list = byGroup.get(group) ?? [];
    list.push(note);
    byGroup.set(group, list);
  }
  const titleOf = (note: CanvasNoteInput): string => note.title ?? note.path;
  const order = (a: CanvasNoteInput, b: CanvasNoteInput): number =>
    (a.path === input.center ? -1 : 0) - (b.path === input.center ? -1 : 0) ||
    (a.distance ?? 0) - (b.distance ?? 0) ||
    compare(titleOf(a).toLowerCase(), titleOf(b).toLowerCase()) ||
    compare(a.path, b.path);

  const groupNodes: CanvasNode[] = [];
  const fileNodes: CanvasNode[] = [];
  let x = 0;
  for (const group of [...COLOR_GROUPS, OTHER_GROUP]) {
    const members = (byGroup.get(group) ?? []).sort(order);
    if (members.length === 0) continue;
    const rows = Math.min(members.length, L.rowsPerColumn);
    const columns = Math.ceil(members.length / L.rowsPerColumn);
    const width = columns * L.nodeWidth + (columns - 1) * L.gapX + 2 * L.padding;
    const height = rows * L.nodeHeight + (rows - 1) * L.gapY + 2 * L.padding;
    groupNodes.push({
      id: hashId(`group\0${group.key}`),
      type: 'group',
      x,
      y: 0,
      width,
      height,
      color: group.color,
      label: `${group.label} (${members.length})`,
    });
    members.forEach((note, i) => {
      fileNodes.push({
        id: canvasNodeId(note.path),
        type: 'file',
        file: note.path,
        x: x + L.padding + Math.floor(i / L.rowsPerColumn) * (L.nodeWidth + L.gapX),
        y: L.padding + (i % L.rowsPerColumn) * (L.nodeHeight + L.gapY),
        width: L.nodeWidth,
        height: L.nodeHeight,
        color: group.color,
      });
    });
    x += width + L.groupGap;
  }

  const nodes: CanvasNode[] = [...groupNodes, ...fileNodes];
  if (input.legend !== undefined) {
    nodes.push({
      id: hashId('legend'),
      type: 'text',
      text: input.legend,
      x: 0,
      y: -(L.legendHeight + L.groupGap / 2),
      width: L.legendWidth,
      height: L.legendHeight,
    });
  }

  const byPath = new Map(fileNodes.map((node) => [node.file as string, node]));
  const seen = new Set<string>();
  const edges: CanvasEdge[] = [];
  const sortedEdges = [...input.edges].sort(
    (a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.label, b.label),
  );
  for (const edge of sortedEdges) {
    const from = byPath.get(edge.from);
    const to = byPath.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const id = hashId(`edge\0${edge.from}\0${edge.to}\0${edge.label}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const sides = sideBetween(from, to);
    edges.push({
      id,
      fromNode: from.id,
      fromSide: sides.from,
      toNode: to.id,
      toSide: sides.to,
      toEnd: 'arrow',
      label: edge.label,
    });
  }
  return { nodes, edges };
}

/** O arquivo `.canvas`: JSON com tabulação, como o Obsidian grava, terminado em LF. */
export function canvasFile(canvas: JsonCanvas): string {
  return `${JSON.stringify(canvas, null, '\t')}\n`;
}

const SIDES = ['top', 'right', 'bottom', 'left'];
const ENDS = ['none', 'arrow'];
const NODE_TYPES = ['text', 'file', 'link', 'group'];
const isColor = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && (/^[1-6]$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value)));

export interface CanvasValidationOptions {
  /** Confere se o arquivo de um nó `file` existe (caminho relativo à raiz do vault). */
  readonly fileExists?: (path: string) => boolean;
}

/**
 * Confere um canvas contra a especificação JSON Canvas 1.0: campos obrigatórios e seus tipos, valores aceitos,
 * ids únicos entre nós e arestas, arestas que ligam nós existentes e, opcionalmente, arquivos que existem. Também
 * recusa caminho absoluto num nó `file` (o mapa é do vault, não da máquina). Devolve os problemas; vazio é válido.
 */
export function validateCanvas(value: unknown, options: CanvasValidationOptions = {}): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['o canvas deveria ser um objeto'];
  const canvas = value as Record<string, unknown>;
  const nodes = canvas.nodes ?? [];
  const edges = canvas.edges ?? [];
  if (!Array.isArray(nodes)) return ['"nodes" deveria ser uma lista'];
  if (!Array.isArray(edges)) return ['"edges" deveria ser uma lista'];
  const ids = new Set<string>();
  const nodeIds = new Set<string>();
  for (const raw of nodes as unknown[]) {
    const n = (raw ?? {}) as Record<string, unknown>;
    const id = typeof n.id === 'string' ? n.id : null;
    if (id === null || id === '') errors.push('nó sem id');
    else if (ids.has(id)) errors.push(`id repetido: ${id}`);
    else {
      ids.add(id);
      nodeIds.add(id);
    }
    const where = id ?? '?';
    if (!NODE_TYPES.includes(n.type as string)) errors.push(`${where}: type inválido`);
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(n[key])) errors.push(`${where}: ${key} deveria ser inteiro`);
    }
    if (!isColor(n.color)) errors.push(`${where}: color inválida`);
    if (n.type === 'text' && typeof n.text !== 'string') errors.push(`${where}: text é obrigatório`);
    if (n.type === 'file') {
      if (typeof n.file !== 'string' || n.file === '') {
        errors.push(`${where}: file é obrigatório`);
      } else {
        if (/^(?:[a-zA-Z]:)?[\\/]/.test(n.file) || n.file.split(/[\\/]/).includes('..')) {
          errors.push(`${where}: file deveria ser um caminho relativo ao vault`);
        } else if (options.fileExists !== undefined && !options.fileExists(n.file)) {
          errors.push(`${where}: arquivo inexistente ${n.file}`);
        }
      }
      if (n.subpath !== undefined && (typeof n.subpath !== 'string' || !n.subpath.startsWith('#'))) {
        errors.push(`${where}: subpath deveria começar com #`);
      }
    }
    if (n.type === 'link' && typeof n.url !== 'string') errors.push(`${where}: url é obrigatório`);
    if (n.type === 'group') {
      if (n.label !== undefined && typeof n.label !== 'string') errors.push(`${where}: label deveria ser texto`);
      if (n.backgroundStyle !== undefined && !['cover', 'ratio', 'repeat'].includes(n.backgroundStyle as string)) {
        errors.push(`${where}: backgroundStyle inválido`);
      }
    }
  }
  for (const raw of edges as unknown[]) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : null;
    if (id === null || id === '') errors.push('aresta sem id');
    else if (ids.has(id)) errors.push(`id repetido: ${id}`);
    else ids.add(id);
    const where = id ?? '?';
    for (const key of ['fromNode', 'toNode']) {
      if (typeof e[key] !== 'string' || !nodeIds.has(e[key] as string)) {
        errors.push(`${where}: ${key} aponta para um nó que não existe`);
      }
    }
    for (const key of ['fromSide', 'toSide']) {
      if (e[key] !== undefined && !SIDES.includes(e[key] as string)) errors.push(`${where}: ${key} inválido`);
    }
    for (const key of ['fromEnd', 'toEnd']) {
      if (e[key] !== undefined && !ENDS.includes(e[key] as string)) errors.push(`${where}: ${key} inválido`);
    }
    if (!isColor(e.color)) errors.push(`${where}: color inválida`);
    if (e.label !== undefined && typeof e.label !== 'string') errors.push(`${where}: label deveria ser texto`);
  }
  return errors;
}

/** Pares de nós (fora os grupos) cujos retângulos se sobrepõem. O layout do Cabeção nunca produz nenhum. */
export function canvasOverlaps(canvas: JsonCanvas): Array<[string, string]> {
  const boxes = canvas.nodes.filter((node) => node.type !== 'group');
  const out: Array<[string, string]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as CanvasNode;
      const b = boxes[j] as CanvasNode;
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        out.push([a.id, b.id]);
      }
    }
  }
  return out;
}
