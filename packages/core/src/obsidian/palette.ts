// Cores dos tipos de nota, as mesmas no grafo do Obsidian (`graph.json`) e nos mapas exportados (`.canvas`).
//
// A ordem importa no grafo: o primeiro grupo cuja consulta casa define a cor do nó (spike 15, item 8b, conferido no
// aplicativo). Por isso o arquivo morto vem antes (uma nota arquivada mantém o `type`) e cada grupo casa pelo tipo
// OU pela pasta: a pasta cobre as notas sem `type` de um vault adotado.
import type { NoteType } from '../vault/index.ts';
import { ARCHIVE_DIR, NOTE_TYPE_DIRS, RAW_DIR } from '../vault/index.ts';

/** Um grupo de cor: rótulo (em português, para o mapa), os tipos que ele junta, as pastas e a cor `#RRGGBB`. */
export interface ColorGroup {
  readonly key: string;
  readonly label: string;
  readonly types: readonly NoteType[];
  readonly dirs: readonly string[];
  readonly color: string;
}

/** Grupos na ordem em que entram no `graph.json` (o primeiro que casa vale). */
export const COLOR_GROUPS: readonly ColorGroup[] = [
  { key: 'archive', label: 'Arquivadas', types: [], dirs: [ARCHIVE_DIR], color: '#5B5B66' },
  { key: 'rule', label: 'Regras', types: ['rule'], dirs: [NOTE_TYPE_DIRS.rule], color: '#E5484D' },
  { key: 'fact', label: 'Fatos', types: ['fact'], dirs: [NOTE_TYPE_DIRS.fact], color: '#30A46C' },
  { key: 'decision', label: 'Decisões', types: ['decision'], dirs: [NOTE_TYPE_DIRS.decision], color: '#F5A524' },
  { key: 'concept', label: 'Conceitos', types: ['concept'], dirs: [NOTE_TYPE_DIRS.concept], color: '#4C8DFF' },
  { key: 'entity', label: 'Entidades', types: ['entity'], dirs: [NOTE_TYPE_DIRS.entity], color: '#8E4EC6' },
  { key: 'source', label: 'Fontes', types: ['source'], dirs: [NOTE_TYPE_DIRS.source], color: '#12A594' },
  { key: 'synthesis', label: 'Sínteses', types: ['synthesis'], dirs: [NOTE_TYPE_DIRS.synthesis], color: '#3E63DD' },
  {
    key: 'memory',
    label: 'Preferências, armadilhas e procedimentos',
    types: ['preference', 'gotcha', 'procedure'],
    dirs: [NOTE_TYPE_DIRS.preference, NOTE_TYPE_DIRS.gotcha, NOTE_TYPE_DIRS.procedure],
    color: '#D6409F',
  },
  {
    key: 'session',
    label: 'Episódios e handoffs',
    types: ['episode', 'handoff'],
    dirs: [NOTE_TYPE_DIRS.episode, NOTE_TYPE_DIRS.handoff],
    color: '#A18072',
  },
  { key: 'raw', label: 'Fontes brutas', types: [], dirs: [RAW_DIR], color: '#8B8D98' },
];

/** Grupo das notas que não casam com nenhum outro (vault adotado, pasta própria). */
export const OTHER_GROUP: ColorGroup = { key: 'other', label: 'Outras', types: [], dirs: [], color: '#B0B4BA' };

/**
 * Consulta da busca do Obsidian que casa as notas do grupo: `[type:decision] OR path:wiki/decisions`. Só operadores
 * conferidos no aplicativo pelo spike 15 (`[prop:valor]`, `path:` e `OR`).
 */
export function graphQuery(group: ColorGroup): string {
  return [...group.types.map((type) => `[type:${type}]`), ...group.dirs.map((dir) => `path:${dir}`)].join(' OR ');
}

/** `#RRGGBB` → o inteiro decimal `0xRRGGBB` que o `graph.json` guarda em `color.rgb`. */
export function rgbInt(hex: string): number {
  return Number.parseInt(hex.replace(/^#/, ''), 16);
}

const startsWithDir = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * Grupo de uma nota pelo caminho e pelo tipo, com a mesma regra do grafo: o primeiro grupo que casa vale (o arquivo
 * morto antes do tipo, o tipo ou a pasta depois).
 */
export function groupOf(note: { readonly path: string; readonly type: string | null }): ColorGroup {
  for (const group of COLOR_GROUPS) {
    if ((group.types as readonly string[]).includes(note.type ?? '')) return group;
    if (group.dirs.some((dir) => startsWithDir(note.path, dir))) return group;
  }
  return OTHER_GROUP;
}
