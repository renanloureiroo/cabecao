// Contexto de uma operação no índice: repositório, pastas locais, trava, relógio e os ganchos de teste.
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readObjects } from '../sync/git.ts';
import { withLock, writeFileAtomic } from '../util/index.ts';
import { cleanScratch, type GitContext, makeGitContext, type TreeItem } from './git.ts';
import { type IndexLayout, indexLayout } from './layout.ts';
import { type DecodedSegment, decodeSegment, SEGMENT_NAME_RE, type SegmentProblem } from './segment.ts';

/** Pontos de uma escrita no índice, na ordem. Os testes de morte súbita matam o processo em cada um. */
export const INDEX_STEPS = [
  'blobs-written',
  'tree-written',
  'commit-written',
  'ref-updated',
  'old-heads-deleted',
] as const;
export type IndexStep = (typeof INDEX_STEPS)[number];

export interface IndexOptions {
  /**
   * Remoto cujas referências de acompanhamento (`refs/remotes/<remoto>/cabecao/index*`) entram na leitura e na
   * integração local. Padrão: todos os remotos.
   */
  readonly remote?: string;
  /** Guarda cópia dos segmentos lidos em `.cabecao/index/` (cache; reconstruível do git). Padrão: não. */
  readonly cache?: boolean;
  /** Quanto esperar pela trava de escrita do índice. Padrão: 30 s. */
  readonly lockTimeoutMs?: number;
  readonly now?: () => Date;
  /** Tamanho máximo de um segmento novo; acima disso os registros são divididos em vários. Padrão: 32 MiB. */
  readonly maxSegmentBytes?: number;
  readonly timeoutMs?: number;
  readonly networkTimeoutMs?: number;
  readonly staleGitLockMs?: number;
  /** Gancho de teste: chamado em cada {@link IndexStep}. */
  readonly faultAt?: (step: IndexStep) => void | Promise<void>;
}

/** Segmento ignorado na leitura, com o motivo. A leitura nunca falha por causa dele. */
export interface SegmentIssue {
  readonly path: string;
  readonly oid: string;
  /** `missing`: o blob não está no banco de objetos local (clone parcial ou repositório danificado). */
  readonly problem: SegmentProblem | 'missing';
  readonly detail: string;
}

/** Abaixo do aviso de 50 MiB do GitHub, com folga. */
export const DEFAULT_MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export interface IndexContext {
  readonly root: string;
  readonly git: GitContext;
  readonly layout: IndexLayout;
  readonly remote: string | null;
  readonly cache: boolean;
  readonly lockTimeoutMs: number;
  readonly now: () => Date;
  readonly maxSegmentBytes: number;
  readonly fault: (step: IndexStep) => Promise<void>;
  /** Chaves de cada segmento já lido, por SHA do blob (blobs são imutáveis). */
  readonly keys: Map<string, readonly string[]>;
  /** Dimensões conhecidas por pasta de modelo. */
  readonly dims: Map<string, number>;
  /** Modelo e variante conhecidos por pasta de modelo. */
  readonly specs: Map<string, { model: string; variant: string }>;
}

export function makeContext(root: string, options: IndexOptions = {}): IndexContext {
  const layout = indexLayout(root);
  const faultAt = options.faultAt;
  return {
    root,
    git: makeGitContext(root, layout.scratchDir, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.networkTimeoutMs === undefined ? {} : { networkTimeoutMs: options.networkTimeoutMs }),
      ...(options.staleGitLockMs === undefined ? {} : { staleGitLockMs: options.staleGitLockMs }),
    }),
    layout,
    remote: options.remote ?? null,
    cache: options.cache ?? false,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    now: options.now ?? (() => new Date()),
    maxSegmentBytes: options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES,
    fault: async (step) => {
      if (faultAt) await faultAt(step);
    },
    keys: new Map(),
    dims: new Map(),
    specs: new Map(),
  };
}

/**
 * Um escritor do índice por vez nesta máquina. A trava é cooperativa; o `update-ref` condicional cobre quem não a
 * respeita. Antes de começar, apaga índices temporários de processos mortos.
 */
export async function withIndexLock<T>(ctx: IndexContext, fn: () => Promise<T>): Promise<T> {
  return withLock(
    ctx.layout.lock,
    async () => {
      await cleanScratch(ctx.layout.scratchDir);
      return fn();
    },
    { timeoutMs: ctx.lockTimeoutMs },
  );
}

function cachePath(ctx: IndexContext, path: string): string {
  return join(ctx.layout.cacheDir, ...path.split('/'));
}

export interface ReadSegmentsResult {
  /** Segmentos válidos, por caminho na árvore. */
  readonly segments: Map<string, DecodedSegment>;
  readonly issues: SegmentIssue[];
}

/**
 * Lê e confere vários segmentos de uma vez: os que estão no cache local (e conferem) vêm do disco; os demais, de um
 * único `git cat-file --batch`. Segmento inválido vira {@link SegmentIssue}, nunca exceção. Com `dims`, segmentos de
 * outra dimensão também são recusados.
 */
export async function readSegments(
  ctx: IndexContext,
  items: readonly TreeItem[],
  dims?: number,
): Promise<ReadSegmentsResult> {
  const segments = new Map<string, DecodedSegment>();
  const issues: SegmentIssue[] = [];
  const fromGit: TreeItem[] = [];
  const expectOf = (item: TreeItem) => ({
    name: item.path.slice(item.path.lastIndexOf('/') + 1),
    ...(dims === undefined ? {} : { dims }),
  });
  if (ctx.cache) {
    await Promise.all(
      items.map(async (item) => {
        try {
          const bytes = await readFile(cachePath(ctx, item.path));
          const decoded = decodeSegment(bytes, expectOf(item));
          if (decoded.ok) {
            segments.set(item.path, decoded.segment);
            return;
          }
        } catch {
          // fora do cache: vem do git
        }
        fromGit.push(item);
      }),
    );
  } else {
    fromGit.push(...items);
  }
  if (fromGit.length > 0) {
    const blobs = await readObjects(
      ctx.git,
      fromGit.map((item) => item.oid),
    );
    const toCache: { path: string; bytes: Buffer }[] = [];
    for (const item of fromGit) {
      const bytes = blobs.get(item.oid);
      if (bytes === undefined) {
        issues.push({ path: item.path, oid: item.oid, problem: 'missing', detail: 'blob ausente no banco de objetos' });
        continue;
      }
      const decoded = decodeSegment(bytes, expectOf(item));
      if (!decoded.ok) {
        issues.push({ path: item.path, oid: item.oid, problem: decoded.problem, detail: decoded.detail });
        continue;
      }
      segments.set(item.path, decoded.segment);
      if (ctx.cache) toCache.push({ path: item.path, bytes });
    }
    for (const { path, bytes } of toCache) {
      // cache é opcional: falha ao gravar (disco cheio, permissão) não afeta a leitura
      await writeFileAtomic(cachePath(ctx, path), bytes).catch(() => {});
    }
  }
  return { segments, issues };
}

/** Apaga do cache local os segmentos de uma pasta de modelo que não estão mais na branch. */
export async function pruneCache(ctx: IndexContext, modelDir: string, keep: ReadonlySet<string>): Promise<void> {
  if (!ctx.cache) return;
  const dir = join(ctx.layout.cacheDir, 'embeddings', modelDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SEGMENT_NAME_RE.test(name) && !keep.has(name)) await rm(join(dir, name), { force: true }).catch(() => {});
  }
}

/** Chaves de um segmento, guardadas por SHA do blob. */
export function segmentKeys(ctx: IndexContext, oid: string, segment: DecodedSegment): readonly string[] {
  const cached = ctx.keys.get(oid);
  if (cached) return cached;
  const keys: string[] = new Array(segment.count);
  for (let i = 0; i < segment.count; i++) keys[i] = segment.key(i);
  ctx.keys.set(oid, keys);
  return keys;
}
