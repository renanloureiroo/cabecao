/**
 * Nomes da branch de índice e da sua árvore (doc 03, "Branch de índice").
 *
 * ```
 * refs/heads/cabecao/index        geração 0
 * refs/heads/cabecao/index-<n>    geração n (n ≥ 1); vale a de maior n
 *
 * embeddings/<modelo>-<variante>-r<receita>/seg-<hash>.bin
 * graph/nodes.jsonl  graph/edges.jsonl      (marco 3; preservados como estão)
 * manifest.json                            (derivado, regenerado a cada commit)
 * ```
 */
import { join } from 'node:path';
import { isSafeRelativePath, toPosixPath } from '../util/index.ts';
import { SEGMENT_NAME_RE } from './segment.ts';

/** Nome da branch da geração 0, sem `refs/heads/`. */
export const INDEX_BRANCH = 'cabecao/index';
/** Padrão do `git ls-remote` que lista todas as gerações. */
export const INDEX_REF_PATTERN = `refs/heads/${INDEX_BRANCH}*`;
export const EMBEDDINGS_DIR = 'embeddings';
export const MANIFEST_PATH = 'manifest.json';
export const GRAPH_NODES_PATH = 'graph/nodes.jsonl';
export const GRAPH_EDGES_PATH = 'graph/edges.jsonl';

const LOCAL_HEAD_RE = /^refs\/heads\/cabecao\/index(?:-([1-9]\d{0,8}))?$/;
const TRACKING_RE = /^refs\/remotes\/(.+)\/cabecao\/index(?:-([1-9]\d{0,8}))?$/;

/** Branch (sem `refs/heads/`) da geração `n`. */
export function generationBranch(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError(`geração inválida: ${generation}`);
  return generation === 0 ? INDEX_BRANCH : `${INDEX_BRANCH}-${generation}`;
}

/** Referência local (`refs/heads/...`) da geração `n`. */
export function generationRef(generation: number): string {
  return `refs/heads/${generationBranch(generation)}`;
}

/** Referência de acompanhamento do remoto para a geração `n`. */
export function trackingRef(remote: string, generation: number): string {
  return `refs/remotes/${remote}/${generationBranch(generation)}`;
}

/** Geração de uma referência `refs/heads/cabecao/index[-n]` (local ou do remoto), ou `null`. */
export function parseGenerationRef(ref: string): number | null {
  const match = LOCAL_HEAD_RE.exec(ref);
  if (!match) return null;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/** Remoto e geração de uma referência de acompanhamento, ou `null`. */
export function parseTrackingRef(ref: string): { remote: string; generation: number } | null {
  const match = TRACKING_RE.exec(ref);
  if (!match || match[1] === undefined) return null;
  return { remote: match[1], generation: match[2] === undefined ? 0 : Number(match[2]) };
}

/** Modelo, variante e receita: o que identifica a pasta de embeddings. */
export interface EmbeddingModelSpec {
  readonly model: string;
  readonly variant: string;
  readonly recipe: number;
}

const DIR_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*-r(\d{1,6})$/;

/** `<modelo>-<variante>-r<receita>`, a pasta do modelo dentro de `embeddings/`. */
export function modelDirName(spec: EmbeddingModelSpec): string {
  if (!DIR_PART_RE.test(spec.model)) throw new TypeError(`nome de modelo inválido para pasta: ${spec.model}`);
  if (!DIR_PART_RE.test(spec.variant)) throw new TypeError(`variante inválida para pasta: ${spec.variant}`);
  if (!Number.isSafeInteger(spec.recipe) || spec.recipe < 0 || spec.recipe > 999_999) {
    throw new RangeError(`receita inválida: ${spec.recipe}`);
  }
  return `${spec.model}-${spec.variant}-r${spec.recipe}`;
}

/** Diz se o texto serve como pasta de modelo (`...-r<receita>`, só letras, dígitos, `.`, `_` e `-`). */
export function isModelDir(dir: string): boolean {
  return MODEL_DIR_RE.test(dir) && !dir.includes('..');
}

/** Receita de uma pasta de modelo, ou `null` se o nome não segue o padrão. */
export function modelDirRecipe(dir: string): number | null {
  const match = MODEL_DIR_RE.exec(dir);
  return match ? Number(match[1]) : null;
}

/** Caminho de um segmento na árvore da branch. */
export function segmentPath(modelDir: string, name: string): string {
  return `${EMBEDDINGS_DIR}/${modelDir}/${name}`;
}

/** Pasta do modelo e nome do segmento de um caminho da árvore, ou `null` se não for um segmento bem nomeado. */
export function parseSegmentPath(path: string): { modelDir: string; name: string } | null {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== EMBEDDINGS_DIR) return null;
  const [, modelDir = '', name = ''] = parts;
  if (!isModelDir(modelDir) || !SEGMENT_NAME_RE.test(name)) return null;
  return { modelDir, name };
}

/** Caminho sob `embeddings/` (segmento ou não): é da área dos embeddings, que só este módulo escreve. */
export function isEmbeddingsPath(path: string): boolean {
  return path === EMBEDDINGS_DIR || path.startsWith(`${EMBEDDINGS_DIR}/`);
}

/**
 * Confere o caminho de um arquivo derivado (grafo e afins) e o devolve normalizado com `/`. Recusa caminhos que
 * saem da raiz, a área `embeddings/` e o `manifest.json` (ambos deste módulo).
 */
export function normalizeDerivedPath(path: string): string {
  if (!isSafeRelativePath(path)) throw new TypeError(`caminho inválido na branch de índice: ${path}`);
  const normalized = toPosixPath(path)
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
  if (normalized === MANIFEST_PATH)
    throw new TypeError('o manifest.json é regenerado pelo índice e não é gravado à mão');
  if (isEmbeddingsPath(normalized)) throw new TypeError('a pasta embeddings/ só recebe segmentos, por appendRecords');
  return normalized;
}

/** Pastas locais do índice, todas dentro de `.cabecao/` (fora do git). */
export interface IndexLayout {
  /** Cópia local opcional dos segmentos (cache reconstruível). */
  readonly cacheDir: string;
  /** Trava de um escritor do índice por vez nesta máquina. */
  readonly lock: string;
  /** Índices temporários do git. */
  readonly scratchDir: string;
}

export function indexLayout(root: string): IndexLayout {
  const cabecao = join(root, '.cabecao');
  return {
    cacheDir: join(cabecao, 'index'),
    // nome próprio: `index.lock` é a trava das varreduras do banco local (`db/open.ts`)
    lock: join(cabecao, 'locks', 'index-branch.lock'),
    scratchDir: join(cabecao, 'tmp', 'indexstore'),
  };
}
