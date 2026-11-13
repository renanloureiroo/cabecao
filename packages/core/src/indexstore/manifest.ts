/**
 * `manifest.json` da branch de índice: derivado, regenerado a cada commit a partir da própria árvore. Nunca é
 * fundido: numa integração entre máquinas ele é refeito. Chaves em ordem fixa, para que a mesma árvore dê os mesmos
 * bytes em qualquer máquina.
 */
import type { TreeItem } from './git.ts';
import { modelDirRecipe, parseSegmentPath } from './layout.ts';
import { segmentCountFromSize } from './segment.ts';

export const MANIFEST_FORMAT_VERSION = 1;

export interface ManifestModel {
  /** Nome do modelo, quando conhecido (vem de quem abriu o índice com `EmbeddingModelSpec`). */
  readonly model?: string;
  readonly variant?: string;
  readonly recipe: number | null;
  readonly dims: number | null;
  readonly segments: number;
  /** Registros nos segmentos (contados pelo tamanho; duplicatas entre segmentos contam). */
  readonly vectors: number;
}

/** De onde veio uma geração: a ponta da geração anterior que a compactação consumiu. */
export interface ManifestPrevious {
  readonly ref: string;
  readonly commit: string;
  /**
   * Caminhos dos segmentos que entraram na compactação. Quem migra de uma geração antiga não traz de volta nenhum
   * destes (os vetores deles já estão na geração nova, ou foram descartados de propósito como órfãos).
   */
  readonly segments: readonly string[];
}

export interface IndexManifest {
  readonly formatVersion: number;
  readonly generation: number;
  readonly previous: ManifestPrevious | null;
  /** Commit de conteúdo (branch principal) que estes embeddings cobrem, quando informado pelo sync. */
  readonly contentCommit: string | null;
  readonly vectors: number;
  readonly models: Readonly<Record<string, ManifestModel>>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Lê o manifesto; `null` se não for JSON ou não tiver a forma esperada (é derivado: basta regenerar). */
export function parseManifest(bytes: Uint8Array | string): IndexManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const formatVersion = int(raw.formatVersion);
  const generation = int(raw.generation);
  if (formatVersion === null || generation === null) return null;
  let previous: ManifestPrevious | null = null;
  if (typeof raw.previous === 'object' && raw.previous !== null) {
    const p = raw.previous as Record<string, unknown>;
    const ref = str(p.ref);
    const commit = str(p.commit);
    const segments = Array.isArray(p.segments) ? p.segments.filter((s): s is string => typeof s === 'string') : [];
    if (ref !== undefined && commit !== undefined) previous = { ref, commit, segments };
  }
  const models: Record<string, ManifestModel> = {};
  if (typeof raw.models === 'object' && raw.models !== null) {
    for (const [dir, entry] of Object.entries(raw.models as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const m = entry as Record<string, unknown>;
      const model = str(m.model);
      const variant = str(m.variant);
      models[dir] = {
        ...(model === undefined ? {} : { model }),
        ...(variant === undefined ? {} : { variant }),
        recipe: int(m.recipe),
        dims: int(m.dims),
        segments: int(m.segments) ?? 0,
        vectors: int(m.vectors) ?? 0,
      };
    }
  }
  return {
    formatVersion,
    generation,
    previous,
    contentCommit: str(raw.contentCommit) ?? null,
    vectors: int(raw.vectors) ?? 0,
    models,
  };
}

/** JSON com as chaves em ordem fixa e quebra de linha no fim. */
export function serializeManifest(manifest: IndexManifest): Buffer {
  const models: Record<string, unknown> = {};
  for (const dir of Object.keys(manifest.models).sort()) {
    const m = manifest.models[dir];
    if (m === undefined) continue;
    models[dir] = {
      ...(m.model === undefined ? {} : { model: m.model }),
      ...(m.variant === undefined ? {} : { variant: m.variant }),
      recipe: m.recipe,
      dims: m.dims,
      segments: m.segments,
      vectors: m.vectors,
    };
  }
  const ordered = {
    formatVersion: manifest.formatVersion,
    generation: manifest.generation,
    contentCommit: manifest.contentCommit,
    vectors: manifest.vectors,
    models,
    previous:
      manifest.previous === null
        ? null
        : {
            ref: manifest.previous.ref,
            commit: manifest.previous.commit,
            segments: [...manifest.previous.segments].sort(),
          },
  };
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

export interface ManifestInput {
  readonly generation: number;
  readonly previous: ManifestPrevious | null;
  readonly contentCommit: string | null;
  /** Árvore final, sem o manifesto. */
  readonly entries: ReadonlyMap<string, TreeItem>;
  /** Dimensões conhecidas por pasta de modelo. */
  readonly dims: ReadonlyMap<string, number>;
  /** Manifesto anterior, de onde vêm modelo e variante das pastas que este processo não abriu. */
  readonly prior: IndexManifest | null;
  /** Modelo e variante conhecidos por pasta. */
  readonly specs: ReadonlyMap<string, { model: string; variant: string }>;
}

/** Monta o manifesto a partir da árvore: vetores contados pelo tamanho de cada segmento. */
export function buildManifest(input: ManifestInput): IndexManifest {
  const perDir = new Map<string, { segments: number; vectors: number }>();
  for (const item of input.entries.values()) {
    const seg = parseSegmentPath(item.path);
    if (!seg) continue;
    const acc = perDir.get(seg.modelDir) ?? { segments: 0, vectors: 0 };
    acc.segments++;
    const dims = input.dims.get(seg.modelDir);
    const count = dims === undefined ? null : segmentCountFromSize(item.size, dims);
    acc.vectors += count ?? 0;
    perDir.set(seg.modelDir, acc);
  }
  const models: Record<string, ManifestModel> = {};
  let vectors = 0;
  for (const [dir, acc] of [...perDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const spec = input.specs.get(dir) ?? input.prior?.models[dir];
    const model = spec?.model;
    const variant = spec?.variant;
    models[dir] = {
      ...(model === undefined ? {} : { model }),
      ...(variant === undefined ? {} : { variant }),
      recipe: modelDirRecipe(dir),
      dims: input.dims.get(dir) ?? null,
      segments: acc.segments,
      vectors: acc.vectors,
    };
    vectors += acc.vectors;
  }
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    generation: input.generation,
    previous: input.previous,
    contentCommit: input.contentCommit,
    vectors,
    models,
  };
}
