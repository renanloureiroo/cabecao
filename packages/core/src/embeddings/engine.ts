// Serviço de embeddings de um cérebro aberto: descobre quais trechos ainda não têm vetor na branch de índice,
// calcula SÓ esses (em rodadas, um segmento novo por rodada) e mantém em memória o armazém de vetores para a busca.
//
// - Idempotente e retomável: cada rodada é um commit local da branch de índice. Um processo morto no meio perde no
//   máximo a rodada em andamento; a próxima chamada recalcula só o que falta.
// - Não recalcula o que outra máquina calculou: `listKeys` soma a branch local e as pontas do remoto já buscadas.
// - O armazém de vetores (`VectorStore`) é carregado na primeira busca que precisa dele e atualizado aos poucos: o
//   que este processo calcula entra direto; o que outro processo gravou (o sync roda em processo separado quando
//   quem chama é o servidor MCP) entra na próxima busca, lendo só as chaves que faltam.

import type { EmbeddingInput } from '../db/index.ts';
import { runGit } from '../git/index.ts';
import { type IndexStore, isModelDir, modelDirName, openIndexStore } from '../indexstore/index.ts';
import type { EmbeddingConfig } from '../vault/index.ts';
import { quantizeInt8, VectorStore } from '../vector/index.ts';
import type {
  EmbedderLike,
  EmbeddingAvailability,
  EmbeddingProvider,
  EmbedProgress,
  EmbedStep,
  ResolvedEmbedding,
} from './types.ts';

/** Trechos por rodada: um segmento (e um commit local da branch de índice) a cada rodada. */
export const DEFAULT_EMBED_ROUND = 256;
/** Uma carga do modelo que falhou não é tentada de novo antes disto (a busca não fica lenta tentando a cada vez). */
const LOAD_RETRY_MS = 60_000;

/** O embedding do `.cabecao.json` não vale (modelo desconhecido, receita, dimensões...). */
export class EmbeddingConfigProblem extends Error {
  readonly code = 'invalid_embedding_config';
}

/** O embedder carregado não tem as dimensões do `.cabecao.json`. */
export class EmbedderMismatchError extends Error {
  readonly code = 'embedder_mismatch';
}

/**
 * Pasta e dimensões direto do `.cabecao.json`, sem o runtime: serve para ler, integrar e compactar o índice numa
 * máquina sem o runtime instalado. O provedor, quando há, confere de verdade (catálogo, receita, revisão).
 */
export function resolveFromConfig(config: EmbeddingConfig): ResolvedEmbedding {
  const modelDir = modelDirName({ model: config.model, variant: config.variant, recipe: config.recipe });
  if (!isModelDir(modelDir)) throw new EmbeddingConfigProblem(`pasta de modelo inválida: ${modelDir}`);
  return {
    model: config.model,
    variant: config.variant,
    recipe: config.recipe,
    dims: config.dims,
    modelDir,
    revision: typeof config.revision === 'string' ? config.revision : null,
  };
}

export interface EngineOptions {
  readonly root: string;
  readonly provider?: EmbeddingProvider | undefined;
  /** Trechos por rodada. Padrão: {@link DEFAULT_EMBED_ROUND}. */
  readonly roundSize?: number;
  /** Gancho de teste, chamado em cada {@link EmbedStep}. */
  readonly faultAt?: ((step: EmbedStep) => void | Promise<void>) | undefined;
}

export interface ComputeOptions {
  /** Commit de conteúdo que estes vetores cobrem (vai para o `manifest.json` da branch de índice). */
  readonly contentCommit?: string | null;
  readonly onProgress?: (event: EmbedProgress) => void;
  /** Para depois da rodada em andamento. */
  readonly signal?: AbortSignal;
}

export interface ComputeResult {
  readonly modelDir: string;
  /** Trechos distintos (por chave) do banco. */
  readonly chunks: number;
  /** Já tinham vetor antes desta chamada. */
  readonly had: number;
  /** Calculados agora. */
  readonly computed: number;
  /** Continuam sem vetor (interrompido). */
  readonly pending: number;
  readonly rounds: number;
  readonly backend: string | null;
}

interface LoadedVectors {
  readonly modelDir: string;
  signature: string;
  readonly store: VectorStore;
}

/** Assinatura das referências do índice: muda quando qualquer processo grava ou busca a branch de índice. */
async function indexSignature(root: string): Promise<string> {
  const { stdout } = await runGit(
    ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/cabecao/', 'refs/remotes/'],
    { cwd: root },
  );
  return stdout
    .split('\n')
    .filter((line) => /\/cabecao\/index(?:-\d+)? /.test(line))
    .join('\n');
}

export class EmbeddingEngine {
  readonly root: string;
  readonly provider: EmbeddingProvider | undefined;
  readonly #roundSize: number;
  readonly #faultAt: EngineOptions['faultAt'];
  readonly #stores = new Map<string, Promise<IndexStore>>();
  #embedder: { modelDir: string; promise: Promise<EmbedderLike> } | null = null;
  #loadFailure: { modelDir: string; at: number; error: unknown } | null = null;
  #loaded: EmbedderLike | null = null;
  #vectors: LoadedVectors | null = null;
  #disposed = false;

  constructor(options: EngineOptions) {
    this.root = options.root;
    this.provider = options.provider;
    this.#roundSize = Math.max(1, Math.trunc(options.roundSize ?? DEFAULT_EMBED_ROUND));
    this.#faultAt = options.faultAt;
  }

  /** O embedder já está carregado neste processo. */
  get embedderLoaded(): boolean {
    return this.#loaded !== null;
  }

  get embedderBackend(): string | null {
    return this.#loaded?.backend ?? null;
  }

  /** O `embedding` do `.cabecao.json` conferido pelo provedor (ou só pelos campos, sem provedor). */
  resolve(config: EmbeddingConfig): ResolvedEmbedding {
    if (this.provider === undefined) return resolveFromConfig(config);
    try {
      return this.provider.resolve(config);
    } catch (error) {
      throw new EmbeddingConfigProblem(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  /** Runtime e modelo prontos nesta máquina, sem carregar nada. */
  async available(config: EmbeddingConfig): Promise<EmbeddingAvailability> {
    if (this.provider === undefined) {
      return { ok: false, code: 'not_injected', reason: 'o runtime de embeddings não foi carregado neste processo' };
    }
    try {
      this.resolve(config);
    } catch (error) {
      return { ok: false, code: 'invalid_config', reason: error instanceof Error ? error.message : String(error) };
    }
    try {
      return await this.provider.available(config);
    } catch (error) {
      return { ok: false, code: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** O armazém da branch de índice para o modelo (um por pasta, reaproveitado: guarda as chaves já lidas). */
  store(resolved: ResolvedEmbedding): Promise<IndexStore> {
    let store = this.#stores.get(resolved.modelDir);
    if (store === undefined) {
      store = openIndexStore(
        this.root,
        { model: resolved.model, variant: resolved.variant, recipe: resolved.recipe },
        { dims: resolved.dims, cache: true },
      );
      const pending = store;
      this.#stores.set(resolved.modelDir, pending);
      pending.catch(() => {
        if (this.#stores.get(resolved.modelDir) === pending) this.#stores.delete(resolved.modelDir);
      });
    }
    return store;
  }

  /** Chaves de trecho que já têm vetor para o modelo (branch local e pontas do remoto já buscadas). */
  async knownKeys(resolved: ResolvedEmbedding): Promise<ReadonlySet<string>> {
    return (await this.store(resolved)).listKeys();
  }

  /**
   * Carrega o embedder do modelo (uma vez por processo; pode baixar o modelo, se faltar no cache). Uma carga que
   * falhou não é tentada de novo por um minuto.
   */
  async embedder(
    config: EmbeddingConfig,
    onProgress?: (event: EmbedProgress) => void,
    { retryNow = false }: { retryNow?: boolean } = {},
  ): Promise<EmbedderLike> {
    if (this.#disposed) throw new Error('o serviço de embeddings já foi encerrado');
    const provider = this.provider;
    if (provider === undefined) throw new Error('o runtime de embeddings não foi carregado neste processo');
    const resolved = this.resolve(config);
    if (this.#embedder?.modelDir === resolved.modelDir) return this.#embedder.promise;
    const failure = this.#loadFailure;
    if (
      !retryNow &&
      failure !== null &&
      failure.modelDir === resolved.modelDir &&
      Date.now() - failure.at < LOAD_RETRY_MS
    ) {
      throw failure.error;
    }
    const previous = this.#embedder;
    this.#embedder = null;
    this.#loaded = null;
    if (previous) await previous.promise.then((e) => e.dispose()).catch(() => {});
    onProgress?.({ phase: 'load', model: resolved.model });
    const promise = provider
      .load(config, {
        onProgress: (event) => onProgress?.({ phase: 'download', ...event }),
      })
      .then((embedder) => {
        if (embedder.dims !== resolved.dims) {
          void embedder.dispose().catch(() => {});
          throw new EmbedderMismatchError(
            `o modelo carregado tem ${embedder.dims} dimensões, e o .cabecao.json declara ${resolved.dims}`,
          );
        }
        return embedder;
      });
    this.#embedder = { modelDir: resolved.modelDir, promise };
    try {
      const embedder = await promise;
      this.#loaded = embedder;
      this.#loadFailure = null;
      return embedder;
    } catch (error) {
      if (this.#embedder?.promise === promise) this.#embedder = null;
      this.#loadFailure = { modelDir: resolved.modelDir, at: Date.now(), error };
      throw error;
    }
  }

  /** Vetor da pergunta, normalizado pelo próprio modelo. */
  async embedQuery(config: EmbeddingConfig, query: string): Promise<Float32Array> {
    const embedder = await this.embedder(config);
    const [vector] = await embedder.embed([query], 'query');
    if (vector === undefined) throw new Error('o modelo não devolveu o vetor da pergunta');
    return vector;
  }

  /** Quantos dos trechos não têm vetor. Não carrega o modelo. */
  async missing(config: EmbeddingConfig, inputs: readonly EmbeddingInput[]): Promise<number> {
    const have = await this.knownKeys(this.resolve(config));
    let missing = 0;
    for (const input of inputs) if (!have.has(input.key)) missing++;
    return missing;
  }

  /**
   * Calcula os vetores que faltam para `inputs` (um texto por chave de trecho), em rodadas de até `roundSize`
   * trechos, gravando um segmento por rodada. Os que já existem (desta ou de outra máquina) não são calculados.
   */
  async compute(
    config: EmbeddingConfig,
    inputs: readonly EmbeddingInput[],
    options: ComputeOptions = {},
  ): Promise<ComputeResult> {
    const resolved = this.resolve(config);
    const store = await this.store(resolved);
    const have = await store.listKeys();
    const missing = inputs.filter((input) => !have.has(input.key));
    options.onProgress?.({ phase: 'plan', chunks: inputs.length, missing: missing.length });
    const base = { modelDir: resolved.modelDir, chunks: inputs.length, had: inputs.length - missing.length };
    if (missing.length === 0) {
      options.onProgress?.({ phase: 'done', computed: 0, total: 0 });
      return { ...base, computed: 0, pending: 0, rounds: 0, backend: this.embedderBackend };
    }
    const embedder = await this.embedder(config, options.onProgress, { retryNow: true });
    let computed = 0;
    let rounds = 0;
    for (let offset = 0; offset < missing.length; offset += this.#roundSize) {
      if (options.signal?.aborted) break;
      const round = missing.slice(offset, offset + this.#roundSize);
      const vectors = await embedder.embed(
        round.map((input) => (input.title === '' ? input.text : { text: input.text, title: input.title })),
        'passage',
      );
      if (vectors.length !== round.length)
        throw new Error('o modelo devolveu um número de vetores diferente do pedido');
      const records = round.map((input, i) => {
        const vector = vectors[i] as Float32Array;
        if (vector.length !== resolved.dims) {
          throw new EmbedderMismatchError(
            `o modelo devolveu um vetor de ${vector.length} dimensões; o .cabecao.json declara ${resolved.dims}`,
          );
        }
        const quantized = quantizeInt8(vector, resolved.dims);
        return { key: input.key, scale: quantized.scale, vector: quantized.vector };
      });
      await this.#faultAt?.('round-embedded');
      await store.appendRecords(records, {
        ...(options.contentCommit === undefined ? {} : { contentCommit: options.contentCommit }),
      });
      rounds++;
      computed += records.length;
      const loaded = this.#vectors;
      if (loaded !== null && loaded.modelDir === resolved.modelDir) {
        for (const record of records) loaded.store.add(record);
        loaded.signature = await indexSignature(this.root);
      }
      await this.#faultAt?.('round-appended');
      options.onProgress?.({ phase: 'embed', done: computed, total: missing.length });
    }
    options.onProgress?.({ phase: 'done', computed, total: missing.length });
    return {
      ...base,
      computed,
      pending: missing.length - computed,
      rounds,
      backend: embedder.backend,
    };
  }

  /**
   * O armazém de vetores do modelo em memória: carregado da branch de índice na primeira chamada e, nas seguintes,
   * completado só com as chaves novas quando alguma referência do índice mudou.
   */
  async vectors(config: EmbeddingConfig): Promise<VectorStore> {
    const resolved = this.resolve(config);
    const signature = await indexSignature(this.root);
    const loaded = this.#vectors;
    if (loaded !== null && loaded.modelDir === resolved.modelDir && loaded.signature === signature) return loaded.store;
    const store = await this.store(resolved);
    if (loaded !== null && loaded.modelDir === resolved.modelDir) {
      for await (const record of store.readAll()) if (!loaded.store.has(record.key)) loaded.store.add(record);
      loaded.signature = signature;
      return loaded.store;
    }
    const snapshot = await store.loadAll();
    const dims = snapshot.count === 0 ? resolved.dims : snapshot.dims;
    if (dims !== resolved.dims) {
      throw new EmbedderMismatchError(
        `os vetores da branch de índice têm ${dims} dimensões; o .cabecao.json declara ${resolved.dims}`,
      );
    }
    const vectorStore = new VectorStore({ dims, capacity: snapshot.count });
    for (let i = 0; i < snapshot.count; i++) {
      vectorStore.add({
        key: snapshot.keys[i] as string,
        scale: snapshot.scales[i] as number,
        vector: snapshot.vectors.subarray(i * dims, (i + 1) * dims),
      });
    }
    this.#vectors = { modelDir: resolved.modelDir, signature, store: vectorStore };
    return vectorStore;
  }

  /** Quantos vetores estão em memória (0 se o armazém ainda não foi carregado). */
  get vectorsInMemory(): number {
    return this.#vectors?.store.size ?? 0;
  }

  /** Solta o modelo e os vetores. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const embedder = this.#embedder;
    this.#embedder = null;
    this.#loaded = null;
    this.#vectors = null;
    if (embedder) await embedder.promise.then((e) => e.dispose()).catch(() => {});
  }
}
