/**
 * Visão da branch de índice e integração entre máquinas, só com plumbing.
 *
 * Invariantes que tornam a integração uma união sem conflito:
 *
 * 1. Dentro de uma geração, segmentos só são acrescentados. Nenhum commit de uma geração remove ou altera um
 *    segmento; remover (órfãos, duplicatas) só acontece ao criar uma geração nova (`compactIndex`).
 * 2. Um caminho de segmento é o hash do conteúdo: o mesmo caminho em duas máquinas tem os mesmos bytes.
 *
 * Então juntar duas pontas da mesma geração com ancestral comum é a união dos caminhos de segmento (o resto dos
 * arquivos, como o grafo, por três vias; o `manifest.json` é regenerado). O commit novo tem como único pai a ponta
 * remota (reaplicação, histórico linear): o envio seguinte é sempre um avanço simples.
 *
 * Fontes "de fora" da geração corrente (gerações antigas, ou duas raízes independentes da mesma geração) são
 * DRENADAS: os registros cujas chaves faltam na geração corrente vão para um segmento novo. Os segmentos que a
 * compactação já consumiu (`manifest.previous.segments`) não são drenados, para não ressuscitar órfãos.
 */

import { formatDate } from '../git/index.ts';
import { editTree, gitText, readObjects, writeBlob } from '../sync/git.ts';
import { type IndexContext, readSegments, type SegmentIssue, segmentKeys } from './context.ts';
import {
  commitTree,
  emptyTree,
  type IndexRef,
  IndexRefRaceError,
  independentTips,
  listIndexRefs,
  lsTree,
  mergeBase,
  type TreeItem,
  updateRef,
} from './git.ts';
import { generationRef, isEmbeddingsPath, MANIFEST_PATH, parseSegmentPath, segmentPath } from './layout.ts';
import {
  buildManifest,
  type IndexManifest,
  type ManifestPrevious,
  parseManifest,
  serializeManifest,
} from './manifest.ts';
import {
  type DecodedSegment,
  type EmbeddingRecord,
  type EncodedSegment,
  encodeSegment,
  peekSegmentHeader,
  SEGMENT_CHECKSUM_BYTES,
  SEGMENT_HEADER_BYTES,
  segmentRecordBytes,
} from './segment.ts';

/** Ponta drenada para a geração corrente. */
export interface DrainSource {
  readonly ref: string;
  readonly oid: string;
  readonly generation: number;
  /** `older-generation`: geração anterior; `unrelated`: outra raiz da mesma geração (sem ancestral comum). */
  readonly reason: 'older-generation' | 'unrelated';
}

export interface IndexView {
  /** Geração corrente; `null` quando não existe índice em lugar nenhum. */
  readonly generation: number | null;
  /** Branch local da geração corrente e para onde ela aponta (`null` se ainda não existe). */
  readonly localRef: string | null;
  readonly localOid: string | null;
  /** Commit sobre o qual o próximo commit é feito (a ponta remota, quando há divergência). */
  readonly parent: string | null;
  /** Árvore do `parent`, com o manifesto. */
  readonly parentEntries: ReadonlyMap<string, TreeItem>;
  /** Árvore resultante, sem o manifesto. */
  readonly entries: ReadonlyMap<string, TreeItem>;
  /** Manifesto do `parent`. */
  readonly manifest: IndexManifest | null;
  /** Registros drenados por pasta de modelo (ainda sem segmento). */
  readonly drained: ReadonlyMap<string, readonly EmbeddingRecord[]>;
  /** Caminhos dos segmentos drenados (consumidos). */
  readonly drainedPaths: readonly string[];
  readonly drainSources: readonly DrainSource[];
  /** Branches locais de gerações antigas, apagadas depois da migração. */
  readonly staleLocal: readonly IndexRef[];
  /** Ponta remota da geração corrente, se houver. */
  readonly remoteTip: string | null;
  readonly issues: readonly SegmentIssue[];
  /** A árvore resultante difere da do `parent` (há commit a fazer). */
  readonly changed: boolean;
}

const EMPTY_VIEW: IndexView = {
  generation: null,
  localRef: null,
  localOid: null,
  parent: null,
  parentEntries: new Map(),
  entries: new Map(),
  manifest: null,
  drained: new Map(),
  drainedPaths: [],
  drainSources: [],
  staleLocal: [],
  remoteTip: null,
  issues: [],
  changed: false,
};

async function readManifestAt(
  ctx: IndexContext,
  entries: ReadonlyMap<string, TreeItem>,
): Promise<IndexManifest | null> {
  const item = entries.get(MANIFEST_PATH);
  if (!item) return null;
  const blob = (await readObjects(ctx.git, [item.oid])).get(item.oid);
  return blob ? parseManifest(blob) : null;
}

function sameEntries(a: ReadonlyMap<string, TreeItem>, b: ReadonlyMap<string, TreeItem>): boolean {
  let count = 0;
  for (const [path, item] of a) {
    if (path === MANIFEST_PATH) continue;
    count++;
    if (b.get(path)?.oid !== item.oid) return false;
  }
  let other = 0;
  for (const path of b.keys()) if (path !== MANIFEST_PATH) other++;
  return count === other;
}

/** Segmentos de uma pasta de modelo numa árvore, em ordem de caminho. */
export function modelSegments(entries: ReadonlyMap<string, TreeItem>, modelDir: string): TreeItem[] {
  const out: TreeItem[] = [];
  for (const item of entries.values()) if (parseSegmentPath(item.path)?.modelDir === modelDir) out.push(item);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Pastas de modelo presentes numa árvore. */
export function modelDirsOf(entries: ReadonlyMap<string, TreeItem>): string[] {
  const dirs = new Set<string>();
  for (const path of entries.keys()) {
    const seg = parseSegmentPath(path);
    if (seg) dirs.add(seg.modelDir);
  }
  return [...dirs].sort();
}

/**
 * Dimensões de uma pasta de modelo: as conhecidas pelo processo, senão as do manifesto, senão as do primeiro
 * segmento válido (`segments`, em ordem de caminho).
 */
export function resolveDims(
  ctx: IndexContext,
  modelDir: string,
  manifest: IndexManifest | null,
  segments?: Iterable<DecodedSegment>,
): number | undefined {
  const known = ctx.dims.get(modelDir) ?? manifest?.models[modelDir]?.dims ?? undefined;
  if (known !== undefined && known !== null) return known;
  for (const segment of segments ?? []) return segment.dims;
  return undefined;
}

/** Lê os segmentos de uma pasta e devolve os válidos com as dimensões da pasta (os de outra dimensão viram problema). */
export async function readModelSegments(
  ctx: IndexContext,
  items: readonly TreeItem[],
  modelDir: string,
  manifest: IndexManifest | null,
): Promise<{ segments: Map<string, DecodedSegment>; issues: SegmentIssue[]; dims: number | undefined }> {
  let dims = resolveDims(ctx, modelDir, manifest);
  const read = await readSegments(ctx, items, dims);
  if (dims === undefined) {
    // sem dimensão conhecida: vale a do primeiro segmento válido, em ordem de caminho
    const ordered = items.map((item) => read.segments.get(item.path)).filter((s) => s !== undefined);
    dims = resolveDims(ctx, modelDir, manifest, ordered);
    if (dims !== undefined) {
      for (const item of items) {
        const segment = read.segments.get(item.path);
        if (segment && segment.dims !== dims) {
          read.segments.delete(item.path);
          read.issues.push({
            path: item.path,
            oid: item.oid,
            problem: 'dims',
            detail: `o segmento tem ${segment.dims} dimensões; a pasta tem ${dims}`,
          });
        }
      }
    }
  }
  return { segments: read.segments, issues: read.issues, dims };
}

export interface ComputeViewOptions {
  /** Só calcula a drenagem desta pasta de modelo (leitura). Padrão: todas (escrita). */
  readonly modelDir?: string;
  /**
   * Só leitura: o manifesto é lido apenas quando precisa (gerações antigas a drenar, ou dimensões desconhecidas).
   * Uma escrita sempre lê o manifesto, porque carrega dele o commit de conteúdo e a origem da geração.
   */
  readonly read?: boolean;
}

/**
 * Calcula, sem gravar nada, como a branch de índice fica depois de integrar as pontas conhecidas (branch local e
 * referências de acompanhamento). Leituras usam a visão direto; escritas a gravam com {@link writeView}.
 */
export async function computeView(ctx: IndexContext, options: ComputeViewOptions = {}): Promise<IndexView> {
  const refs = (await listIndexRefs(ctx.git)).filter(
    (r) => r.remote === null || ctx.remote === null || r.remote === ctx.remote,
  );
  if (refs.length === 0) return EMPTY_VIEW;
  const generation = Math.max(...refs.map((r) => r.generation));
  const local = refs.find((r) => r.remote === null && r.generation === generation) ?? null;
  const tracking = refs.filter((r) => r.remote !== null && r.generation === generation);
  const tipRefs = [...(local ? [local] : []), ...tracking];
  const independent = new Set(
    await independentTips(
      ctx.git,
      tipRefs.map((r) => r.oid),
    ),
  );
  // a ponta remota é o pai preferido: assim o próximo envio é avanço simples
  const primaryRef = tracking.find((r) => independent.has(r.oid)) ?? local ?? tracking[0];
  if (primaryRef === undefined) return EMPTY_VIEW;
  const parent = primaryRef.oid;
  const parentEntries = await lsTree(ctx.git, parent);
  const needsManifest =
    options.read !== true ||
    refs.some((r) => r.generation < generation) ||
    (options.modelDir !== undefined && !ctx.dims.has(options.modelDir));
  const manifest = needsManifest ? await readManifestAt(ctx, parentEntries) : null;
  const entries = new Map(parentEntries);
  entries.delete(MANIFEST_PATH);

  const drainSources: DrainSource[] = [];
  const pending: { tree: Map<string, TreeItem>; exclude: ReadonlySet<string> }[] = [];
  const seenTips = new Set([parent]);
  for (const tip of tipRefs) {
    if (seenTips.has(tip.oid) || !independent.has(tip.oid)) continue;
    seenTips.add(tip.oid);
    const tree = await lsTree(ctx.git, tip.oid);
    const base = await mergeBase(ctx.git, tip.oid, parent);
    if (base === null) {
      drainSources.push({ ref: tip.ref, oid: tip.oid, generation, reason: 'unrelated' });
      pending.push({ tree, exclude: new Set() });
      continue;
    }
    const baseTree = await lsTree(ctx.git, base);
    for (const [path, item] of tree) {
      if (parseSegmentPath(path) && !entries.has(path)) entries.set(path, item);
    }
    // demais arquivos (grafo...): três vias; o lado que mudou vence; mudou dos dois lados, vence o remoto (pai)
    const derived = new Set([...tree.keys(), ...baseTree.keys()]);
    for (const path of derived) {
      if (path === MANIFEST_PATH || isEmbeddingsPath(path)) continue;
      const theirs = tree.get(path);
      const before = baseTree.get(path)?.oid;
      if (theirs?.oid === before || parentEntries.get(path)?.oid !== before) continue;
      if (theirs) entries.set(path, theirs);
      else entries.delete(path);
    }
  }

  const previous = manifest?.previous ?? null;
  const consumed = new Set(previous?.segments ?? []);
  for (const ref of refs) {
    if (ref.generation >= generation || seenTips.has(ref.oid)) continue;
    seenTips.add(ref.oid);
    // a ponta exata que a compactação consumiu não tem nada a acrescentar
    if (previous !== null && ref.oid === previous.commit) continue;
    drainSources.push({ ref: ref.ref, oid: ref.oid, generation: ref.generation, reason: 'older-generation' });
    pending.push({ tree: await lsTree(ctx.git, ref.oid), exclude: consumed });
  }

  const issues: SegmentIssue[] = [];
  const drained = new Map<string, EmbeddingRecord[]>();
  const drainedPaths: string[] = [];
  const candidates = new Map<string, Map<string, TreeItem>>();
  for (const { tree, exclude } of pending) {
    for (const [path, item] of tree) {
      const seg = parseSegmentPath(path);
      if (!seg || entries.has(path) || exclude.has(path)) continue;
      if (options.modelDir !== undefined && seg.modelDir !== options.modelDir) continue;
      const byDir = candidates.get(seg.modelDir) ?? new Map<string, TreeItem>();
      byDir.set(path, item);
      candidates.set(seg.modelDir, byDir);
    }
  }
  for (const [modelDir, byPath] of [...candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const targetItems = modelSegments(entries, modelDir);
    const target = await readModelSegments(ctx, targetItems, modelDir, manifest);
    const keys = new Set<string>();
    for (const item of targetItems) {
      const segment = target.segments.get(item.path);
      if (segment) for (const key of segmentKeys(ctx, item.oid, segment)) keys.add(key);
    }
    const items = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    const read = await readSegments(ctx, items, target.dims);
    issues.push(...read.issues);
    const dims = target.dims ?? items.map((item) => read.segments.get(item.path)).find((s) => s)?.dims;
    const records: EmbeddingRecord[] = [];
    for (const item of items) {
      const segment = read.segments.get(item.path);
      drainedPaths.push(item.path);
      if (!segment) continue;
      if (dims !== undefined && segment.dims !== dims) {
        issues.push({ path: item.path, oid: item.oid, problem: 'dims', detail: `${segment.dims} ≠ ${dims} dimensões` });
        continue;
      }
      for (let i = 0; i < segment.count; i++) {
        const key = segment.key(i);
        if (keys.has(key)) continue;
        keys.add(key);
        records.push(segment.record(i));
      }
    }
    if (records.length > 0) drained.set(modelDir, records);
    if (dims !== undefined && !ctx.dims.has(modelDir)) ctx.dims.set(modelDir, dims);
  }

  const remoteTip = tracking.find((r) => r.oid === parent)?.oid ?? tracking[0]?.oid ?? null;
  return {
    generation,
    localRef: generationRef(generation),
    localOid: local?.oid ?? null,
    parent,
    parentEntries,
    entries,
    manifest,
    drained,
    drainedPaths,
    drainSources,
    staleLocal: refs.filter((r) => r.remote === null && r.generation < generation),
    remoteTip,
    issues,
    changed: drained.size > 0 || !sameEntries(parentEntries, entries),
  };
}

/** Divide registros (já sem chave repetida) em segmentos de no máximo `maxBytes`, em ordem de chave. */
export function encodeChunks(records: readonly EmbeddingRecord[], dims: number, maxBytes: number): EncodedSegment[] {
  if (records.length === 0) return [];
  const perSegment = Math.max(
    1,
    Math.floor((maxBytes - SEGMENT_HEADER_BYTES - SEGMENT_CHECKSUM_BYTES) / segmentRecordBytes(dims)),
  );
  if (records.length <= perSegment) return [encodeSegment(records, dims)];
  const sorted = [...records].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: EncodedSegment[] = [];
  for (let i = 0; i < sorted.length; i += perSegment) out.push(encodeSegment(sorted.slice(i, i + perSegment), dims));
  return out;
}

/** Segmento novo a gravar, com a pasta do modelo. */
export interface NewSegment {
  readonly modelDir: string;
  readonly segment: EncodedSegment;
}

export interface ViewChange {
  readonly segments?: readonly NewSegment[];
  /** Arquivos derivados a gravar (`null` apaga). */
  readonly files?: ReadonlyMap<string, Uint8Array | null>;
  /** Commit de conteúdo para o manifesto; `undefined` mantém o anterior. */
  readonly contentCommit?: string | null;
  /** Linhas extras do corpo da mensagem. */
  readonly body?: readonly string[];
}

export interface WriteResult {
  /** Ponta da branch local depois da escrita (`null` só se não existe índice nenhum). */
  readonly commit: string | null;
  readonly ref: string | null;
  readonly generation: number | null;
  /** Um commit novo foi criado (não foi só avanço da branch local). */
  readonly created: boolean;
  /** Segmentos acrescentados (drenados e novos), com caminho e número de registros. */
  readonly segments: readonly { path: string; count: number; bytes: number }[];
  readonly drainedRecords: number;
  readonly manifest: IndexManifest | null;
}

export function indexCommitMessage(ctx: IndexContext, generation: number, vectors: number, body: readonly string[]) {
  return `vault index: ${formatDate(ctx.now())}\n\ngeração: ${generation}\nvetores: ${vectors}\n${body.map((line) => `${line}\n`).join('')}`;
}

/** Dimensões de cada pasta da árvore final, lendo o cabeçalho de um segmento só quando ninguém sabe. */
async function dimsFor(
  ctx: IndexContext,
  entries: ReadonlyMap<string, TreeItem>,
  manifest: IndexManifest | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unknown = new Map<string, TreeItem>();
  for (const dir of modelDirsOf(entries)) {
    const known = resolveDims(ctx, dir, manifest);
    if (known !== undefined) out.set(dir, known);
    else {
      const first = modelSegments(entries, dir)[0];
      if (first) unknown.set(dir, first);
    }
  }
  if (unknown.size > 0) {
    const blobs = await readObjects(
      ctx.git,
      [...unknown.values()].map((item) => item.oid),
    );
    for (const [dir, item] of unknown) {
      const header = peekSegmentHeader(blobs.get(item.oid) ?? new Uint8Array());
      if (header) out.set(dir, header.dims);
    }
  }
  return out;
}

/** Monta a árvore final a partir da árvore de `base` (commit ou árvore), num índice descartável do git. */
export async function buildTree(
  ctx: IndexContext,
  base: string | null,
  baseEntries: ReadonlyMap<string, TreeItem>,
  finalEntries: ReadonlyMap<string, TreeItem>,
): Promise<string> {
  const edits: { path: string; oid: string | null }[] = [];
  for (const [path, item] of finalEntries)
    if (baseEntries.get(path)?.oid !== item.oid) edits.push({ path, oid: item.oid });
  for (const path of baseEntries.keys()) if (!finalEntries.has(path)) edits.push({ path, oid: null });
  if (base === null) return editTree(ctx.git, await emptyTree(ctx.git), edits);
  if (edits.length === 0) return gitText(ctx.git, ['rev-parse', '--verify', `${base}^{tree}`]);
  return editTree(ctx.git, base, edits);
}

/** Item de árvore para um blob recém-gravado. */
export function blobItem(path: string, oid: string, size: number): TreeItem {
  return { mode: '100644', type: 'blob', oid, size, path };
}

/**
 * Grava a visão (e as mudanças pedidas) como um commit na branch local da geração corrente: segmentos novos e
 * drenados, arquivos derivados, manifesto regenerado, `update-ref` condicional e, por fim, remoção das branches
 * locais de gerações antigas. Sem nada a mudar, só avança a branch local até a ponta integrada.
 */
export async function writeView(ctx: IndexContext, view: IndexView, change: ViewChange = {}): Promise<WriteResult> {
  const generation = view.generation ?? 0;
  const ref = generationRef(generation);
  const entries = new Map(view.entries);
  const added: { path: string; count: number; bytes: number }[] = [];
  let drainedRecords = 0;
  const segments: NewSegment[] = [];
  for (const [modelDir, records] of view.drained) {
    const dims = ctx.dims.get(modelDir) ?? records[0]?.vector.length;
    if (dims === undefined) continue;
    drainedRecords += records.length;
    for (const segment of encodeChunks(records, dims, ctx.maxSegmentBytes)) segments.push({ modelDir, segment });
  }
  segments.push(...(change.segments ?? []));
  for (const { modelDir, segment } of segments) {
    const path = segmentPath(modelDir, segment.name);
    if (entries.has(path)) continue;
    const oid = await writeBlob(ctx.git, segment.bytes);
    entries.set(path, blobItem(path, oid, segment.bytes.length));
    added.push({ path, count: segment.count, bytes: segment.bytes.length });
    if (!ctx.dims.has(modelDir)) ctx.dims.set(modelDir, segment.dims);
  }
  let filesChanged = false;
  for (const [path, data] of change.files ?? []) {
    if (data === null) {
      if (entries.delete(path)) filesChanged = true;
      continue;
    }
    const oid = await writeBlob(ctx.git, data);
    if (entries.get(path)?.oid === oid) continue;
    entries.set(path, blobItem(path, oid, data.length));
    filesChanged = true;
  }
  const contentChanged =
    change.contentCommit !== undefined && change.contentCommit !== (view.manifest?.contentCommit ?? null);
  const somethingNew = view.changed || added.length > 0 || filesChanged;
  const mustCommit = somethingNew || (contentChanged && view.parent !== null);
  if (!mustCommit) {
    // nada novo: só alinha a branch local com a ponta integrada
    if (view.parent !== null && view.parent !== view.localOid) {
      await updateRef(ctx.git, ref, view.parent, view.localOid, view.parent.length);
      await ctx.fault('ref-updated');
    }
    await dropStaleHeads(ctx, view);
    return {
      commit: view.parent,
      ref: view.parent === null ? null : ref,
      generation: view.generation,
      created: false,
      segments: [],
      drainedRecords: 0,
      manifest: view.manifest,
    };
  }
  await ctx.fault('blobs-written');
  const manifest = buildManifest({
    generation,
    previous: view.manifest?.previous ?? null,
    contentCommit: change.contentCommit !== undefined ? change.contentCommit : (view.manifest?.contentCommit ?? null),
    entries,
    dims: await dimsFor(ctx, entries, view.manifest),
    prior: view.manifest,
    specs: ctx.specs,
  });
  const manifestBytes = serializeManifest(manifest);
  const manifestOid = await writeBlob(ctx.git, manifestBytes);
  entries.set(MANIFEST_PATH, blobItem(MANIFEST_PATH, manifestOid, manifestBytes.length));
  const tree = await buildTree(ctx, view.parent, view.parentEntries, entries);
  await ctx.fault('tree-written');
  const body = [
    ...added.map((a) => `+ ${a.path}: ${a.count} vetores`),
    ...view.drainSources.map((s) => `integrado de ${s.ref} ${s.oid.slice(0, 12)}`),
    ...(change.body ?? []),
  ];
  const commit = await commitTree(
    ctx.git,
    tree,
    view.parent === null ? [] : [view.parent],
    indexCommitMessage(ctx, generation, manifest.vectors, body),
  );
  await ctx.fault('commit-written');
  await updateRef(ctx.git, ref, commit, view.localOid, commit.length);
  await ctx.fault('ref-updated');
  await dropStaleHeads(ctx, view);
  return { commit, ref, generation, created: true, segments: added, drainedRecords, manifest };
}

/** Apaga as branches locais de gerações antigas (já drenadas). Corrida aqui não é erro: fica para a próxima vez. */
export async function dropStaleHeads(ctx: IndexContext, view: Pick<IndexView, 'staleLocal'>): Promise<void> {
  for (const stale of view.staleLocal) {
    try {
      await updateRef(ctx.git, stale.ref, null, stale.oid, stale.oid.length);
    } catch (error) {
      if (!(error instanceof IndexRefRaceError)) throw error;
    }
  }
  if (view.staleLocal.length > 0) await ctx.fault('old-heads-deleted');
}

export type { ManifestPrevious };
