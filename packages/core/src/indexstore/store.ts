// API de alto nível do armazém de embeddings de um modelo: quais chaves já existem, acrescentar e ler tudo.
import { GitError } from '../git/index.ts';
import { git, readObjects } from '../sync/git.ts';
import {
  type IndexContext,
  type IndexOptions,
  makeContext,
  pruneCache,
  type SegmentIssue,
  segmentKeys,
  withIndexLock,
} from './context.ts';
import {
  computeView,
  encodeChunks,
  type IndexView,
  modelSegments,
  readModelSegments,
  resolveDims,
  type WriteResult,
  writeView,
} from './integrate.ts';
import { type EmbeddingModelSpec, isModelDir, MANIFEST_PATH, modelDirName, normalizeDerivedPath } from './layout.ts';
import { type IndexManifest, parseManifest } from './manifest.ts';
import {
  assertEmbeddingRecord,
  type EmbeddingRecord,
  isEmbeddingKey,
  SEGMENT_HEADER_BYTES,
  SEGMENT_KEY_BYTES,
  segmentRecordBytes,
} from './segment.ts';

export interface IndexStoreOptions extends IndexOptions {
  /** Dimensões do modelo. Sem elas, valem as do manifesto ou as do primeiro segmento (ou do primeiro registro). */
  readonly dims?: number;
}

export interface AppendOptions {
  /** Commit de conteúdo que estes embeddings cobrem (vai para o `manifest.json`). */
  readonly contentCommit?: string | null;
  /** Ignora registros cuja chave já existe no índice (padrão). Com `false`, grava mesmo repetidos. */
  readonly skipExisting?: boolean;
}

export interface AppendResult {
  /** Registros gravados em segmento novo. */
  readonly appended: number;
  /** Registros ignorados: chave já presente (ou repetida no próprio lote). */
  readonly skipped: number;
  readonly segments: readonly { path: string; count: number; bytes: number }[];
  /** Ponta da branch local depois da operação; `null` se nada existe. */
  readonly commit: string | null;
  readonly ref: string | null;
  readonly generation: number | null;
  /** Foi criado um commit novo. */
  readonly created: boolean;
}

export interface IndexHead {
  readonly generation: number;
  readonly ref: string;
  /** Ponta local (ou a remota, se ainda não há branch local) da geração corrente. */
  readonly commit: string;
  readonly manifest: IndexManifest | null;
  /** Há integração pendente (pontas remotas ou gerações antigas a juntar). */
  readonly pendingIntegration: boolean;
}

/** Todos os registros de um modelo em arrays contíguos: a linha `i` é `keys[i]`, `scales[i]` e `vectors[i·dims…]`. */
export interface IndexSnapshot {
  readonly dims: number;
  readonly count: number;
  readonly keys: readonly string[];
  readonly scales: Float32Array;
  readonly vectors: Int8Array;
  readonly issues: readonly SegmentIssue[];
}

export interface ReadAllOptions {
  /** Chamado para cada segmento ignorado (truncado, checksum, nome, dimensões, blob ausente). */
  readonly onIssue?: (issue: SegmentIssue) => void;
}

/** Armazém de embeddings de UMA pasta de modelo na branch de índice. Leitura sem trava; escrita com trava. */
export class IndexStore {
  readonly root: string;
  readonly modelDir: string;
  readonly #ctx: IndexContext;
  #issues: SegmentIssue[] = [];
  #keySignature = '';
  #keySet: Set<string> = new Set();

  constructor(root: string, modelDir: string, ctx: IndexContext) {
    this.root = root;
    this.modelDir = modelDir;
    this.#ctx = ctx;
  }

  /** Segmentos ignorados na última leitura. */
  get issues(): readonly SegmentIssue[] {
    return this.#issues;
  }

  /** Dimensões do modelo, se já conhecidas. */
  get dims(): number | undefined {
    return this.#ctx.dims.get(this.modelDir);
  }

  /** Geração e ponta corrente; `null` quando não existe índice. */
  async head(): Promise<IndexHead | null> {
    const view = await computeView(this.#ctx, { modelDir: this.modelDir });
    if (view.generation === null || view.parent === null || view.localRef === null) return null;
    return {
      generation: view.generation,
      ref: view.localRef,
      commit: view.localOid !== null && !view.changed && view.parent === view.localOid ? view.localOid : view.parent,
      manifest: view.manifest,
      pendingIntegration: view.changed || view.parent !== view.localOid || view.staleLocal.length > 0,
    };
  }

  async #view(): Promise<IndexView> {
    return computeView(this.#ctx, { modelDir: this.modelDir, read: true });
  }

  /**
   * Chaves que já têm embedding neste modelo, somando a branch local, as pontas remotas já buscadas e as gerações
   * antigas ainda não integradas. É o que evita recalcular o que outra máquina já calculou.
   */
  async listKeys(): Promise<ReadonlySet<string>> {
    const view = await this.#view();
    return this.#keysOf(view);
  }

  async #keysOf(view: IndexView): Promise<Set<string>> {
    const items = modelSegments(view.entries, this.modelDir);
    const drained = view.drained.get(this.modelDir) ?? [];
    const signature = `${items.map((i) => i.oid).join(',')}|${drained.length}`;
    if (signature === this.#keySignature) return this.#keySet;
    const missing = items.filter((item) => !this.#ctx.keys.has(item.oid));
    const issues: SegmentIssue[] = [...view.issues];
    if (missing.length > 0) {
      const read = await readModelSegments(this.#ctx, missing, this.modelDir, view.manifest);
      issues.push(...read.issues);
      for (const item of missing) {
        const segment = read.segments.get(item.path);
        if (segment) segmentKeys(this.#ctx, item.oid, segment);
      }
    }
    const keys = new Set<string>();
    for (const item of items) for (const key of this.#ctx.keys.get(item.oid) ?? []) keys.add(key);
    for (const record of drained) keys.add(record.key);
    this.#issues = issues;
    this.#keySignature = signature;
    this.#keySet = keys;
    return keys;
  }

  async hasKey(key: string): Promise<boolean> {
    return (await this.listKeys()).has(key);
  }

  /** Visão, segmentos lidos e problemas: a base de `readAll` e `loadAll`. */
  async #read(onIssue?: (issue: SegmentIssue) => void) {
    const view = await computeView(this.#ctx, { modelDir: this.modelDir, read: true });
    const items = modelSegments(view.entries, this.modelDir);
    const read = await readModelSegments(this.#ctx, items, this.modelDir, view.manifest);
    if (read.dims !== undefined && !this.#ctx.dims.has(this.modelDir)) this.#ctx.dims.set(this.modelDir, read.dims);
    const issues = [...view.issues, ...read.issues];
    this.#issues = issues;
    for (const issue of issues) onIssue?.(issue);
    await pruneCache(this.#ctx, this.modelDir, new Set(items.map((i) => i.path.slice(i.path.lastIndexOf('/') + 1))));
    const segments = items.map((item) => read.segments.get(item.path)).filter((s) => s !== undefined);
    return { segments, drained: view.drained.get(this.modelDir) ?? [], dims: read.dims };
  }

  /**
   * Todos os registros do modelo, um por chave (numa chave repetida vale o primeiro, em ordem de segmento). Os
   * segmentos são lidos de uma vez (`cat-file --batch`, ou do cache local); segmento inválido é ignorado e
   * reportado, nunca interrompe a leitura. Os vetores são vistas sobre os bytes lidos, sem cópia. Para carregar
   * tudo na memória de uma vez, {@link loadAll} é mais rápido (sem um objeto por registro).
   */
  async *readAll(options: ReadAllOptions = {}): AsyncGenerator<EmbeddingRecord, void, undefined> {
    const { segments, drained } = await this.#read(options.onIssue);
    const seen = new Set<string>();
    for (const segment of segments) {
      const batch: EmbeddingRecord[] = [];
      for (let i = 0; i < segment.count; i++) {
        const key = segment.key(i);
        if (seen.has(key)) continue;
        seen.add(key);
        batch.push(segment.record(i));
      }
      yield* batch;
    }
    for (const record of drained) {
      if (seen.has(record.key)) continue;
      seen.add(record.key);
      yield record;
    }
  }

  /**
   * Carrega todos os registros em arrays contíguos (um `Int8Array` com `count × dims` bytes e um `Float32Array` de
   * escalas), copiando direto dos segmentos, sem criar um objeto por registro. Mesma regra de `readAll`: uma linha
   * por chave, vale a primeira; segmentos inválidos ignorados e reportados.
   */
  async loadAll(options: ReadAllOptions = {}): Promise<IndexSnapshot> {
    const { segments, drained, dims: readDims } = await this.#read(options.onIssue);
    const dims = readDims ?? this.#ctx.dims.get(this.modelDir) ?? drained[0]?.vector.length ?? 0;
    const capacity = segments.reduce((sum, s) => sum + s.count, 0) + drained.length;
    const vectors = new Int8Array(capacity * dims);
    const bytesOut = new Uint8Array(vectors.buffer);
    const scales = new Float32Array(capacity);
    const keys: string[] = [];
    const seen = new Set<string>();
    const record = segmentRecordBytes(dims);
    for (const segment of segments) {
      const bytes = segment.bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0, offset = SEGMENT_HEADER_BYTES; i < segment.count; i++, offset += record) {
        const key = bytes.toString('hex', offset, offset + SEGMENT_KEY_BYTES);
        if (seen.has(key)) continue;
        seen.add(key);
        const row = keys.length;
        keys.push(key);
        scales[row] = view.getFloat32(offset + SEGMENT_KEY_BYTES, true);
        bytesOut.set(bytes.subarray(offset + SEGMENT_KEY_BYTES + 4, offset + record), row * dims);
      }
    }
    for (const r of drained) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      const row = keys.length;
      keys.push(r.key);
      scales[row] = r.scale;
      vectors.set(r.vector, row * dims);
    }
    const count = keys.length;
    return {
      dims,
      count,
      keys,
      scales: scales.subarray(0, count),
      vectors: vectors.subarray(0, count * dims),
      issues: this.#issues,
    };
  }

  /**
   * Grava os registros num segmento NOVO (vários só se passar de `maxSegmentBytes`) e num commit local da branch de
   * índice. Nunca altera segmento existente. Antes, integra o que estiver pendente (pontas remotas já buscadas,
   * gerações antigas), então o commit é sempre um avanço simples sobre a ponta remota.
   */
  async appendRecords(records: Iterable<EmbeddingRecord>, options: AppendOptions = {}): Promise<AppendResult> {
    const batch = [...records];
    for (const record of batch) {
      if (!isEmbeddingKey(record.key)) throw new TypeError(`chave inválida: ${String(record.key)}`);
    }
    return withIndexLock(this.#ctx, async () => {
      // escrita: a visão integra (e drena) todas as pastas de modelo, não só esta
      const view = await computeView(this.#ctx);
      let dims = resolveDims(this.#ctx, this.modelDir, view.manifest);
      if (dims === undefined) {
        const read = await readModelSegments(
          this.#ctx,
          modelSegments(view.entries, this.modelDir),
          this.modelDir,
          view.manifest,
        );
        dims = read.dims ?? batch[0]?.vector.length;
      }
      if (dims !== undefined) this.#ctx.dims.set(this.modelDir, dims);
      for (const record of batch) assertEmbeddingRecord(record, dims ?? record.vector.length);
      const existing = options.skipExisting === false ? new Set<string>() : await this.#keysOf(view);
      const fresh = new Map<string, EmbeddingRecord>();
      for (const record of batch)
        if (!existing.has(record.key) && !fresh.has(record.key)) fresh.set(record.key, record);
      const segments =
        dims === undefined || fresh.size === 0
          ? []
          : encodeChunks([...fresh.values()], dims, this.#ctx.maxSegmentBytes).map((segment) => ({
              modelDir: this.modelDir,
              segment,
            }));
      const written: WriteResult = await writeView(this.#ctx, view, {
        segments,
        ...(options.contentCommit === undefined ? {} : { contentCommit: options.contentCommit }),
      });
      const ownAppended = segments.length === 0 ? 0 : fresh.size;
      return {
        appended: ownAppended,
        skipped: batch.length - ownAppended,
        segments: written.segments,
        commit: written.commit,
        ref: written.ref,
        generation: written.generation,
        created: written.created,
      };
    });
  }
}

/** Confere que `root` é um repositório git (a raiz do cérebro). */
async function assertRepo(ctx: IndexContext): Promise<void> {
  const result = await git(ctx.git, ['rev-parse', '--git-dir'], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new GitError({
      args: result.args,
      exitCode: result.exitCode,
      stderr: result.stderr,
      summary: `não é um repositório git: ${ctx.root}`,
    });
  }
}

/**
 * Abre o armazém de embeddings de um modelo. `model` é a pasta (`<modelo>-<variante>-r<receita>`) ou o trio
 * modelo, variante e receita. Não grava nada: a branch é criada no primeiro `appendRecords`.
 */
export async function openIndexStore(
  root: string,
  model: string | EmbeddingModelSpec,
  options: IndexStoreOptions = {},
): Promise<IndexStore> {
  const modelDir = typeof model === 'string' ? model : modelDirName(model);
  if (!isModelDir(modelDir)) {
    throw new TypeError(`pasta de modelo inválida: "${modelDir}" (esperado <modelo>-<variante>-r<receita>)`);
  }
  const ctx = makeContext(root, options);
  await assertRepo(ctx);
  if (options.dims !== undefined) ctx.dims.set(modelDir, options.dims);
  if (typeof model !== 'string') ctx.specs.set(modelDir, { model: model.model, variant: model.variant });
  return new IndexStore(root, modelDir, ctx);
}

export interface WriteIndexFileOptions extends IndexOptions {
  readonly contentCommit?: string | null;
}

/**
 * Grava (ou, com `data = null`, apaga) um arquivo derivado na branch de índice, fora de `embeddings/` e do
 * `manifest.json`: é a porta para o grafo exportado (`graph/nodes.jsonl`, `graph/edges.jsonl`) do marco 3. Integra o
 * que estiver pendente e faz um commit local; sem mudança, não faz commit.
 */
export async function writeIndexFile(
  root: string,
  path: string,
  data: Uint8Array | string | null,
  options: WriteIndexFileOptions = {},
): Promise<WriteResult> {
  const normalized = normalizeDerivedPath(path);
  const ctx = makeContext(root, options);
  await assertRepo(ctx);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return withIndexLock(ctx, async () =>
    writeView(ctx, await computeView(ctx), {
      files: new Map([[normalized, bytes]]),
      ...(options.contentCommit === undefined ? {} : { contentCommit: options.contentCommit }),
    }),
  );
}

/** Lê um arquivo da branch de índice (grafo, manifesto) na visão integrada; `null` se não existe. */
export async function readIndexFile(root: string, path: string, options: IndexOptions = {}): Promise<Buffer | null> {
  const ctx = makeContext(root, options);
  const view = await computeView(ctx);
  const item = path === MANIFEST_PATH ? view.parentEntries.get(path) : view.entries.get(path);
  if (!item) return null;
  return (await readObjects(ctx.git, [item.oid])).get(item.oid) ?? null;
}

/** Manifesto da ponta corrente (sem a integração pendente). */
export async function readIndexManifest(root: string, options: IndexOptions = {}): Promise<IndexManifest | null> {
  const bytes = await readIndexFile(root, MANIFEST_PATH, options);
  return bytes ? parseManifest(bytes) : null;
}
