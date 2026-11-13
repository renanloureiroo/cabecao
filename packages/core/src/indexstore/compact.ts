/**
 * `compactIndex`: junta os segmentos, remove vetores de trechos que não existem mais e duplicatas, e inicia uma
 * geração nova da branch de índice, sem reescrever histórico e sem exigir exclusão de branch no servidor.
 *
 * Protocolo de gerações (decisão 16; spike 13, "Compactação e gerações"):
 *
 * 1. A geração corrente é a de maior `n` entre `refs/heads/cabecao/index[-n]` locais e as referências de
 *    acompanhamento `refs/remotes/<remoto>/cabecao/index[-n]`.
 * 2. Compactar = commit RAIZ (sem pai) com a árvore compactada na branch NOVA `cabecao/index-<n+1>`. O manifesto e o
 *    corpo do commit registram a origem: `previous = { ref, commit, segments }`, onde `commit` é a ponta remota (ou
 *    local, sem remoto) da geração `n` que entrou na compactação e `segments` são os caminhos consumidos.
 * 3. As branches locais da geração `n` e anteriores são apagadas (só localmente). No servidor a geração antiga fica
 *    onde está; apagá-la é opcional (`pruneRemoteGenerations`), e um servidor que proíbe exclusão não atrapalha.
 * 4. Quem ainda está numa geração antiga migra sozinho ao integrar (`mergeRemoteIndex`, ou qualquer escrita local):
 *    ao ver uma geração maior, adota-a e DRENA da antiga só os registros cujas chaves faltam na nova, ignorando os
 *    segmentos listados em `previous.segments` (já compactados, ou descartados de propósito como órfãos). Assim o
 *    que outra máquina enviou para a geração antiga depois da compactação não se perde, e órfãos não voltam.
 * 5. Duas máquinas que compactam ao mesmo tempo criam duas raízes da mesma geração: o envio da segunda é recusado
 *    (não é avanço simples), ela busca, adota a raiz que chegou primeiro e drena o que faltar nela.
 */
import { formatDate } from '../git/index.ts';
import { writeBlob } from '../sync/git.ts';
import { type IndexContext, type IndexOptions, makeContext, type SegmentIssue, withIndexLock } from './context.ts';
import { commitTree, IndexRefRaceError, listIndexRefs, type TreeItem, updateRef } from './git.ts';
import {
  blobItem,
  buildTree,
  computeView,
  encodeChunks,
  modelDirsOf,
  modelSegments,
  readModelSegments,
} from './integrate.ts';
import { generationRef, isEmbeddingsPath, MANIFEST_PATH, segmentPath } from './layout.ts';
import { buildManifest, type ManifestPrevious, serializeManifest } from './manifest.ts';
import { type EmbeddingRecord, isEmbeddingKey } from './segment.ts';

export interface CompactOptions extends IndexOptions {
  /**
   * Chaves de trechos que existem no conteúdo atual. Vetores de outras chaves são descartados como órfãos. Sem
   * `liveKeys` (ou `null`), nada é descartado por órfão: só duplicatas e segmentos inválidos. Só passe quando o
   * conteúdo local está em dia com o remoto, senão vetores que outra máquina acabou de usar seriam descartados.
   */
  readonly liveKeys?: Iterable<string> | null;
  /** Pastas de modelo removidas por inteiro (modelo trocado e a troca terminada). */
  readonly dropModels?: readonly string[];
}

export interface CompactStats {
  readonly segments: number;
  readonly vectors: number;
  readonly bytes: number;
}

export interface CompactResult {
  readonly generation: { readonly from: number; readonly to: number };
  readonly ref: string;
  readonly commit: string;
  readonly previous: ManifestPrevious;
  readonly before: CompactStats;
  readonly after: CompactStats;
  readonly removed: {
    /** Vetores de chaves fora de `liveKeys`. */
    readonly orphans: number;
    /** Vetores repetidos (mesma chave em mais de um segmento). */
    readonly duplicates: number;
    /** Segmentos inválidos descartados (truncados, checksum, dimensões). */
    readonly invalidSegments: number;
    /** Pastas de modelo removidas. */
    readonly models: readonly string[];
  };
  readonly issues: readonly SegmentIssue[];
}

/** Compacta o índice e abre a geração seguinte. `null` quando não existe índice. */
export async function compactIndex(root: string, options: CompactOptions = {}): Promise<CompactResult | null> {
  const ctx = makeContext(root, options);
  const live = options.liveKeys == null ? null : new Set(options.liveKeys);
  if (live) for (const key of live) if (!isEmbeddingKey(key)) throw new TypeError(`chave inválida em liveKeys: ${key}`);
  const drop = new Set(options.dropModels ?? []);
  return withIndexLock(ctx, () => compactLocked(ctx, live, drop));
}

async function compactLocked(
  ctx: IndexContext,
  live: ReadonlySet<string> | null,
  drop: ReadonlySet<string>,
): Promise<CompactResult | null> {
  const view = await computeView(ctx);
  if (view.generation === null || view.parent === null) return null;
  const from = view.generation;
  const to = from + 1;
  const before = { segments: 0, vectors: 0, bytes: 0 };
  const after = { segments: 0, vectors: 0, bytes: 0 };
  let orphans = 0;
  let duplicates = 0;
  let invalidSegments = 0;
  const issues: SegmentIssue[] = [...view.issues];
  const entries = new Map<string, TreeItem>();
  for (const [path, item] of view.entries) if (!isEmbeddingsPath(path)) entries.set(path, item);

  const dirs = new Set([...modelDirsOf(view.entries), ...view.drained.keys()]);
  for (const dir of [...dirs].sort()) {
    const items = modelSegments(view.entries, dir);
    const drained = view.drained.get(dir) ?? [];
    before.segments += items.length;
    before.bytes += items.reduce((sum, item) => sum + item.size, 0);
    const read = await readModelSegments(ctx, items, dir, view.manifest);
    if (drop.has(dir)) {
      before.vectors += drained.length;
      for (const segment of read.segments.values()) before.vectors += segment.count;
      continue;
    }
    issues.push(...read.issues);
    invalidSegments += read.issues.length;
    const dims = read.dims ?? drained[0]?.vector.length;
    const kept = new Map<string, EmbeddingRecord>();
    const take = (record: EmbeddingRecord): void => {
      before.vectors++;
      if (live && !live.has(record.key)) orphans++;
      else if (kept.has(record.key)) duplicates++;
      else kept.set(record.key, record);
    };
    for (const item of items) {
      const segment = read.segments.get(item.path);
      if (segment) for (let i = 0; i < segment.count; i++) take(segment.record(i));
    }
    for (const record of drained) take(record);
    if (dims === undefined || kept.size === 0) continue;
    ctx.dims.set(dir, dims);
    for (const segment of encodeChunks([...kept.values()], dims, ctx.maxSegmentBytes)) {
      const path = segmentPath(dir, segment.name);
      const oid = await writeBlob(ctx.git, segment.bytes);
      entries.set(path, blobItem(path, oid, segment.bytes.length));
      after.segments++;
      after.vectors += segment.count;
      after.bytes += segment.bytes.length;
    }
  }
  await ctx.fault('blobs-written');

  const consumed = new Set<string>(view.drainedPaths);
  for (const path of view.entries.keys()) if (isEmbeddingsPath(path)) consumed.add(path);
  const previous: ManifestPrevious = {
    ref: generationRef(from),
    commit: view.remoteTip ?? view.parent,
    segments: [...consumed].sort(),
  };
  const dimsMap = new Map<string, number>();
  for (const dir of modelDirsOf(entries)) {
    const dims = ctx.dims.get(dir);
    if (dims !== undefined) dimsMap.set(dir, dims);
  }
  const manifest = buildManifest({
    generation: to,
    previous,
    contentCommit: view.manifest?.contentCommit ?? null,
    entries,
    dims: dimsMap,
    prior: view.manifest,
    specs: ctx.specs,
  });
  const manifestBytes = serializeManifest(manifest);
  entries.set(MANIFEST_PATH, blobItem(MANIFEST_PATH, await writeBlob(ctx.git, manifestBytes), manifestBytes.length));
  const tree = await buildTree(ctx, null, new Map(), entries);
  await ctx.fault('tree-written');
  const message =
    `vault index: ${formatDate(ctx.now())}\n\n` +
    `geração: ${to}\nvetores: ${manifest.vectors}\n` +
    `compactação de ${previous.ref} ${previous.commit}\n` +
    `segmentos: ${before.segments} → ${after.segments}; vetores: ${before.vectors} → ${after.vectors}\n` +
    `removidos: ${orphans} órfãos, ${duplicates} duplicatas, ${invalidSegments} segmentos inválidos\n`;
  const commit = await commitTree(ctx.git, tree, [], message);
  await ctx.fault('commit-written');
  const ref = generationRef(to);
  await updateRef(ctx.git, ref, commit, null, commit.length);
  await ctx.fault('ref-updated');
  // a geração antiga local já está toda na nova: apaga só as branches locais (o remoto não é tocado)
  for (const old of await listIndexRefs(ctx.git)) {
    if (old.remote !== null || old.generation >= to) continue;
    try {
      await updateRef(ctx.git, old.ref, null, old.oid, old.oid.length);
    } catch (error) {
      if (!(error instanceof IndexRefRaceError)) throw error;
    }
  }
  await ctx.fault('old-heads-deleted');
  return {
    generation: { from, to },
    ref,
    commit,
    previous,
    before,
    after,
    removed: { orphans, duplicates, invalidSegments, models: [...drop].filter((d) => dirs.has(d)).sort() },
    issues,
  };
}
