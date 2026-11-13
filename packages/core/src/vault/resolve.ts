// Resolução de wikilinks como no Obsidian: por nome de arquivo ou por caminho, sem diferenciar maiúsculas, em NFC.
import { normalizeLinkTarget } from '../markdown/index.ts';
import { toPosixPath } from '../util/index.ts';
import { isArchivedPath } from './schema.ts';

/** Índice de nomes e caminhos, construído a partir de `listNoteFiles`. Imutável depois de pronto. */
export interface LinkIndex {
  /** Nome do arquivo normalizado (sem `.md`) → caminhos, em ordem de código. */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  /** Caminho normalizado (sem `.md`) → caminhos. Mais de um só em sistema que diferencia maiúsculas. */
  readonly byPath: ReadonlyMap<string, readonly string[]>;
  readonly size: number;
}

export interface LinkResolution {
  /** Caminho da nota escolhida, ou `null` quando o link não resolve. */
  readonly path: string | null;
  /** Mais de uma nota atendia ao link; `path` foi escolhida pela regra de desempate. */
  readonly ambiguous: boolean;
  /** Todas as notas que atendiam, na ordem de preferência (a primeira é `path`). */
  readonly candidates: readonly string[];
}

export interface AmbiguousName {
  /** Nome normalizado (minúsculas, NFC, sem `.md`). */
  readonly name: string;
  readonly paths: readonly string[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const depthOf = (path: string): number => path.split('/').length;

function push(map: Map<string, string[]>, key: string, path: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [path]);
  else if (!list.includes(path)) list.push(path);
}

/** Monta o índice. Aceita o resultado de `listNoteFiles` ou qualquer lista de caminhos relativos com `/`. */
export function buildLinkIndex(files: Iterable<{ readonly path: string } | string>): LinkIndex {
  const byName = new Map<string, string[]>();
  const byPath = new Map<string, string[]>();
  let size = 0;
  for (const file of files) {
    const path = typeof file === 'string' ? file : file.path;
    const key = normalizeLinkTarget(path);
    push(byPath, key, path);
    push(byName, key.slice(key.lastIndexOf('/') + 1), path);
    size++;
  }
  for (const list of byName.values()) list.sort(compare);
  for (const list of byPath.values()) list.sort(compare);
  return { byName, byPath, size };
}

/**
 * Resolve o alvo de um wikilink (`WikiLink.target` ou `FrontmatterLink.target`, sem a âncora).
 *
 * - `[[Nota]]`: pelo nome do arquivo, em qualquer pasta.
 * - `[[pasta/Nota]]`: pelo caminho completo ou pelo fim do caminho (`[[entities/Ana Prado]]`).
 * - Alvo vazio (`[[#Seção]]`): a própria nota, quando `fromPath` é informado.
 *
 * Desempate, quando mais de um arquivo atende (determinístico, e reportado em `ambiguous`):
 * 1. caixa igual à escrita no link (só importa onde `Nota.md` e `nota.md` convivem);
 * 2. arquivo na mesma pasta da nota que contém o link (`fromPath`);
 * 3. nota não arquivada antes de arquivada;
 * 4. caminho com menos pastas;
 * 5. ordem de código do caminho.
 */
export function resolveWikiLink(index: LinkIndex, target: string, fromPath?: string): LinkResolution {
  const key = normalizeLinkTarget(toPosixPath(target))
    .replace(/^(?:\.?\/)+/, '')
    .replace(/\/+/g, '/');
  if (key === '') {
    return fromPath === undefined
      ? { path: null, ambiguous: false, candidates: [] }
      : { path: fromPath, ambiguous: false, candidates: [fromPath] };
  }
  const slash = key.lastIndexOf('/');
  let matches: readonly string[];
  if (slash === -1) {
    matches = index.byName.get(key) ?? [];
  } else {
    const exact = index.byPath.get(key);
    const suffix = `/${key}`;
    matches =
      exact ??
      (index.byName.get(key.slice(slash + 1)) ?? []).filter((path) => normalizeLinkTarget(path).endsWith(suffix));
  }
  if (matches.length === 0) return { path: null, ambiguous: false, candidates: [] };
  if (matches.length === 1) return { path: matches[0] ?? null, ambiguous: false, candidates: matches };

  const fromDir = fromPath === undefined ? null : normalizeLinkTarget(dirOf(toPosixPath(fromPath)));
  const written = toPosixPath(target).trim().replace(/\.md$/i, '').normalize('NFC');
  const rank = (path: string): [number, number, number, number] => [
    `/${path.replace(/\.md$/i, '')}`.endsWith(`/${written}`) ? 0 : 1,
    fromDir !== null && normalizeLinkTarget(dirOf(path)) === fromDir ? 0 : 1,
    isArchivedPath(path) ? 1 : 0,
    depthOf(path),
  ];
  const candidates = [...matches].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || ra[3] - rb[3] || compare(a, b);
  });
  return { path: candidates[0] ?? null, ambiguous: true, candidates };
}

/** Nomes de arquivo que aparecem em mais de uma nota: `[[nome]]` é ambíguo para eles. Para o `lint`. */
export function findAmbiguousNames(index: LinkIndex): AmbiguousName[] {
  const out: AmbiguousName[] = [];
  for (const [name, paths] of index.byName) if (paths.length > 1) out.push({ name, paths });
  return out.sort((a, b) => compare(a.name, b.name));
}
