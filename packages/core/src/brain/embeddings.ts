// Operações de embeddings do cérebro (marco 2): estado, cálculo do que falta, escolha e troca do modelo,
// compactação da branch de índice, reconstrução do banco e o `eval`. Nenhuma tool do MCP chega aqui: são da CLI,
// e as que gravam (no `.cabecao.json` ou na branch de índice) recusam um agente mesmo se alguém as chamasse
// (defesa em profundidade; ADR 36).
import type { ScanSummary } from '../db/index.ts';
import { allChunkKeys, embeddingInputs, getNote, reindexFull, scan } from '../db/index.ts';
import {
  type ComputeResult,
  describeEmbedding,
  type EmbedProgress,
  readLocalEmbeddingState,
  writeEmbeddingConfig,
} from '../embeddings/index.ts';
import {
  type CompactResult,
  compactIndex,
  indexTreeBytes,
  listIndexBranches,
  readIndexManifest,
} from '../indexstore/index.ts';
import type { EmbeddingConfig } from '../vault/index.ts';
import { readBrainConfig } from '../vault/index.ts';
import type { EvalQuestion, EvalReport } from '../vector/index.ts';
import { compareConfigs, DEFAULT_EVAL_ALPHAS, fusionEvalConfigs } from '../vector/index.ts';
import type { BrainContext } from './context.ts';
import { assertOpen, machineName, today, withFreshIndex } from './context.ts';
import { BrainError, toBrainError } from './errors.ts';
import { searchCandidates, validityFactor } from './semantic.ts';

/** Estado da busca por significado neste cérebro e nesta máquina (bloco `embeddings` do `status`). */
export interface EmbeddingsStatusOutput {
  /** O `.cabecao.json` tem `embedding` (alguma máquina ativou a busca por significado). */
  readonly configured: boolean;
  readonly model: string | null;
  readonly variant: string | null;
  readonly dims: number | null;
  readonly recipe: number | null;
  /** Revisão (commit) do modelo gravada no `.cabecao.json`; `null` quando não há (arquivos de `main`). */
  readonly revision: string | null;
  /** Pasta dos vetores na branch de índice. */
  readonly model_dir: string | null;
  /** `false` quando `cabecao embeddings off` desligou a busca por significado nesta máquina. */
  readonly enabled_here: boolean;
  /**
   * `ready` (runtime instalado), `not_configured`, `disabled_here`, `not_injected` (este processo não carregou o
   * runtime), `runtime_missing`, `runtime_outdated`, `invalid_config` ou outro código do runtime.
   */
  readonly runtime: string;
  readonly runtime_detail: string | null;
  /** O modelo está carregado neste processo (o servidor MCP carrega na primeira busca que precisa dele). */
  readonly loaded: boolean;
  readonly backend: string | null;
  /** Trechos distintos (por chave) no banco local. */
  readonly chunks: number;
  /** Trechos que já têm vetor do modelo em uso. */
  readonly with_vector: number | null;
  /** Embeddings na fila: trechos sem vetor do modelo em uso (o próximo sync ou `embeddings on` calcula). */
  readonly pending: number | null;
  /** Vetores do modelo na branch de índice (inclui os de trechos que já não existem, até o próximo `compact`). */
  readonly vectors: number | null;
  /** Geração corrente da branch de índice; `null` se ela não existe. */
  readonly generation: number | null;
  readonly problem: string | null;
}

function humanOnly(ctx: BrainContext, what: string): void {
  assertOpen(ctx);
  if (ctx.actor !== 'human') {
    throw new BrainError('human_only', `${what} só o usuário faz, pela CLI`, {
      nextStep: 'Peça ao usuário para rodar o comando "cabecao embeddings" no terminal.',
    });
  }
}

/** Relê o `.cabecao.json` (outro processo pode ter mudado o modelo); se não der, fica com o que já estava. */
export async function refreshConfig(ctx: BrainContext): Promise<BrainContext['config']> {
  try {
    ctx.config = await readBrainConfig(ctx.root);
  } catch {
    // inválido no disco: as operações de escrita acusam; aqui vale a última configuração lida
  }
  return ctx.config;
}

const NOT_CONFIGURED: Omit<EmbeddingsStatusOutput, 'enabled_here' | 'chunks' | 'generation'> = {
  configured: false,
  model: null,
  variant: null,
  dims: null,
  recipe: null,
  revision: null,
  model_dir: null,
  runtime: 'not_configured',
  runtime_detail: 'a busca por significado não está ativada neste cérebro: rode "cabecao embeddings on"',
  loaded: false,
  backend: null,
  with_vector: null,
  pending: null,
  vectors: null,
  problem: null,
};

/** Estado dos embeddings, sem carregar o modelo. */
export async function embeddingsStatus(ctx: BrainContext): Promise<EmbeddingsStatusOutput> {
  assertOpen(ctx);
  const config = await refreshConfig(ctx);
  const local = await readLocalEmbeddingState(ctx.root);
  const keys = await withFreshIndex(ctx, () => embeddingInputs(ctx.index).map((input) => input.key));
  const branches = await listIndexBranches(ctx.root).catch(() => []);
  const generation = branches.length === 0 ? null : Math.max(...branches.map((ref) => ref.generation));
  const embedding = config.embedding;
  if (embedding === undefined) {
    return { ...NOT_CONFIGURED, enabled_here: !local.disabled, chunks: keys.length, generation };
  }
  const base = {
    configured: true,
    model: embedding.model,
    variant: embedding.variant,
    dims: embedding.dims,
    recipe: embedding.recipe,
    revision: typeof embedding.revision === 'string' ? embedding.revision : null,
    enabled_here: !local.disabled,
    loaded: ctx.engine.embedderLoaded,
    backend: ctx.engine.embedderBackend,
    chunks: keys.length,
    generation,
  };
  let resolved: ReturnType<typeof ctx.engine.resolve>;
  try {
    resolved = ctx.engine.resolve(embedding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      model_dir: null,
      runtime: 'invalid_config',
      runtime_detail: message,
      with_vector: null,
      pending: null,
      vectors: null,
      problem: message,
    };
  }
  let runtime: string;
  let detail: string | null = null;
  if (local.disabled) {
    runtime = 'disabled_here';
    detail = 'desligada nesta máquina ("cabecao embeddings on" religa)';
  } else {
    const availability = await ctx.engine.available(embedding);
    runtime = availability.ok ? 'ready' : availability.code;
    detail = availability.ok ? null : availability.reason;
  }
  let withVector: number | null = null;
  let vectors: number | null = null;
  let problem: string | null = null;
  try {
    const known = await ctx.engine.knownKeys(resolved);
    vectors = known.size;
    withVector = keys.filter((key) => known.has(key)).length;
  } catch (error) {
    problem = `não consegui ler a branch de índice: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    ...base,
    model_dir: resolved.modelDir,
    runtime,
    runtime_detail: detail,
    with_vector: withVector,
    pending: withVector === null ? null : keys.length - withVector,
    vectors,
    problem,
  };
}

/** Tamanho da branch de índice na geração corrente (segmentos, grafo e manifesto), em bytes; `null` sem índice. */
export async function indexSize(ctx: BrainContext): Promise<{ bytes: number; commit: string } | null> {
  assertOpen(ctx);
  const branches = await listIndexBranches(ctx.root);
  if (branches.length === 0) return null;
  const generation = Math.max(...branches.map((ref) => ref.generation));
  const tip =
    branches.find((ref) => ref.generation === generation && ref.remote === null) ??
    branches.find((ref) => ref.generation === generation);
  if (tip === undefined) return null;
  return { bytes: await indexTreeBytes(ctx.root, tip.oid), commit: tip.oid };
}

export interface ComputeEmbeddingsInput {
  readonly onProgress?: (event: EmbedProgress) => void;
  readonly signal?: AbortSignal;
}

export interface ComputeEmbeddingsOutput extends ComputeResult {
  readonly model: string;
  readonly ms: number;
}

function requireEmbedding(config: BrainContext['config']): EmbeddingConfig {
  if (config.embedding === undefined) {
    throw new BrainError('embeddings_unavailable', 'a busca por significado não está ativada neste cérebro', {
      nextStep: 'Rode "cabecao embeddings on" para escolher um modelo.',
    });
  }
  return config.embedding;
}

/** Garante que o runtime carrega nesta máquina antes de calcular (sem ele, a mensagem do runtime diz o que fazer). */
async function requireRuntime(ctx: BrainContext, embedding: EmbeddingConfig): Promise<void> {
  const availability = await ctx.engine.available(embedding);
  if (!availability.ok) {
    throw new BrainError('embeddings_unavailable', availability.reason, {
      nextStep: 'Rode "cabecao embeddings on" para instalar o runtime e baixar o modelo.',
    });
  }
}

async function computeFor(
  ctx: BrainContext,
  embedding: EmbeddingConfig,
  input: ComputeEmbeddingsInput,
): Promise<ComputeEmbeddingsOutput> {
  const started = performance.now();
  await requireRuntime(ctx, embedding);
  const inputs = await withFreshIndex(ctx, () => embeddingInputs(ctx.index));
  let result: ComputeResult;
  try {
    result = await ctx.engine.compute(embedding, inputs, {
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    let mapped: BrainError | null;
    try {
      mapped = toBrainError(error);
    } catch {
      mapped = null;
    }
    throw (
      mapped ??
      new BrainError(
        'embeddings_unavailable',
        `o cálculo dos embeddings falhou: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, nextStep: 'Rode "cabecao doctor"; o que já foi calculado ficou gravado.' },
      )
    );
  }
  return { ...result, model: embedding.model, ms: Math.round(performance.now() - started) };
}

/** Calcula os embeddings que faltam para o modelo do `.cabecao.json` (só o usuário, pela CLI). */
export async function computeEmbeddings(
  ctx: BrainContext,
  input: ComputeEmbeddingsInput = {},
): Promise<ComputeEmbeddingsOutput> {
  humanOnly(ctx, 'calcular embeddings');
  const embedding = requireEmbedding(await refreshConfig(ctx));
  const local = await readLocalEmbeddingState(ctx.root);
  if (local.disabled) {
    throw new BrainError('embeddings_unavailable', 'a busca por significado está desligada nesta máquina', {
      nextStep: 'Rode "cabecao embeddings on" para religar.',
    });
  }
  return computeFor(ctx, embedding, input);
}

export interface SetEmbeddingOutput {
  readonly commit: string | null;
  readonly embedding: EmbeddingConfig | null;
}

/** Grava (ou remove, com `null`) o modelo no `.cabecao.json`, num commit (só o usuário, pela CLI). */
export async function setEmbedding(ctx: BrainContext, embedding: EmbeddingConfig | null): Promise<SetEmbeddingOutput> {
  humanOnly(ctx, 'mudar o modelo de embeddings');
  if (embedding !== null) ctx.engine.resolve(embedding);
  try {
    const written = await writeEmbeddingConfig(ctx.root, embedding, {
      machine: await machineName(ctx),
      client: ctx.client,
      now: ctx.now,
    });
    ctx.config = written.config;
    return { commit: written.commit, embedding: written.config.embedding ?? null };
  } catch (error) {
    throw toBrainError(error);
  }
}

export interface SwitchEmbeddingsOutput extends ComputeEmbeddingsOutput {
  readonly from: string;
  readonly to: string;
  /** Todos os trechos têm vetor do modelo novo e o `.cabecao.json` passou a apontar para ele. */
  readonly switched: boolean;
  readonly commit: string | null;
}

/**
 * Troca de modelo (doc 06, "Trocar de modelo"): calcula tudo para o modelo novo numa pasta nova da branch de índice;
 * o `.cabecao.json` continua no modelo antigo (em uso pela busca) até o cálculo terminar, e só então passa para o
 * novo, num commit. Interrompida, a troca continua de onde parou na próxima chamada. A pasta antiga sai no próximo
 * `compact`.
 */
export async function switchEmbeddings(
  ctx: BrainContext,
  next: EmbeddingConfig,
  input: ComputeEmbeddingsInput = {},
): Promise<SwitchEmbeddingsOutput> {
  humanOnly(ctx, 'trocar o modelo de embeddings');
  const current = requireEmbedding(await refreshConfig(ctx));
  const from = ctx.engine.resolve(current);
  const to = ctx.engine.resolve(next);
  if (from.modelDir === to.modelDir && from.revision === to.revision) {
    throw new BrainError('invalid_argument', `o cérebro já usa ${describeEmbedding(next)}`);
  }
  const computed = await computeFor(ctx, next, input);
  let commit: string | null = null;
  const switched = computed.pending === 0;
  if (switched) commit = (await setEmbedding(ctx, next)).commit;
  return { ...computed, from: from.modelDir, to: to.modelDir, switched, commit };
}

export interface CompactInput {
  /**
   * Descarta vetores de trechos que não existem mais no banco local. Só é seguro com o conteúdo em dia com o remoto
   * (a CLI sincroniza antes). Padrão: `true`.
   */
  readonly dropOrphans?: boolean;
}

export interface CompactOutput extends CompactResult {
  readonly kept_models: readonly string[];
}

/**
 * Compacta a branch de índice e abre uma geração nova (`compactIndex`): junta os segmentos, tira vetores repetidos,
 * os de trechos que não existem mais e as pastas de modelos que não estão em uso. `null` sem branch de índice.
 */
export async function compactBrainIndex(ctx: BrainContext, input: CompactInput = {}): Promise<CompactOutput | null> {
  humanOnly(ctx, 'compactar a branch de índice');
  const config = await refreshConfig(ctx);
  const current = config.embedding === undefined ? null : ctx.engine.resolve(config.embedding).modelDir;
  const manifest = await readIndexManifest(ctx.root);
  const dirs = Object.keys(manifest?.models ?? {});
  const dropModels = dirs.filter((dir) => dir !== current);
  const liveKeys = input.dropOrphans === false ? null : await withFreshIndex(ctx, () => allChunkKeys(ctx.index));
  try {
    const result = await compactIndex(ctx.root, { liveKeys, dropModels, now: ctx.now });
    return result === null ? null : { ...result, kept_models: dirs.filter((dir) => dir === current) };
  } catch (error) {
    throw toBrainError(error);
  }
}

/** Reconstrói o banco local: incremental (o padrão) ou do zero (`full`). */
export async function reindex(ctx: BrainContext, input: { readonly full?: boolean } = {}): Promise<ScanSummary> {
  assertOpen(ctx);
  const config = await refreshConfig(ctx);
  return ctx.dbMutex.run(async () => {
    assertOpen(ctx);
    const started = performance.now();
    try {
      const summary =
        input.full === true ? await reindexFull(ctx.index, ctx.root, config) : await scan(ctx.index, ctx.root, config);
      ctx.lastScanStartedAt = started;
      return summary;
    } catch (error) {
      throw toBrainError(error);
    }
  });
}

export interface EvaluateInput {
  readonly questions: readonly EvalQuestion[];
  readonly alphas?: readonly number[];
  readonly k?: number;
  /** Peso do título no BM25 dos candidatos (padrão: o da busca). Para medir a influência do título na fusão. */
  readonly titleWeight?: number;
}

export interface EvaluateOutput {
  readonly report: EvalReport;
  /** Houve vetores na comparação (embeddings ativados e runtime carregado). */
  readonly vector: boolean;
  /** Por que não houve vetores, quando não houve. */
  readonly vector_problem: string | null;
  readonly model: string | null;
}

/**
 * `cabecao eval`: mede a busca com as perguntas do usuário, comparando só palavra-chave, só vetor e a fusão com
 * vários α, sobre os mesmos candidatos de cada pergunta (doc 06, "Limites desta medição").
 */
export async function evaluateSearch(ctx: BrainContext, input: EvaluateInput): Promise<EvaluateOutput> {
  assertOpen(ctx);
  const config = await refreshConfig(ctx);
  const asOf = today(ctx);
  let vectorProblem: string | null = null;
  let store: Awaited<ReturnType<typeof ctx.engine.vectors>> | null = null;
  const embedding = config.embedding;
  if (embedding === undefined) vectorProblem = 'a busca por significado não está ativada neste cérebro';
  else if ((await readLocalEmbeddingState(ctx.root)).disabled) vectorProblem = 'desligada nesta máquina';
  else {
    const availability = await ctx.engine.available(embedding);
    if (!availability.ok) vectorProblem = availability.reason;
    else {
      try {
        store = await ctx.engine.vectors(embedding);
        await ctx.engine.embedder(embedding);
      } catch (error) {
        store = null;
        vectorProblem = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const queryVectors = new Map<string, Float32Array>();
  if (store !== null && embedding !== undefined) {
    for (const question of input.questions) {
      if (!queryVectors.has(question.query)) {
        queryVectors.set(question.query, await ctx.engine.embedQuery(embedding, question.query));
      }
    }
  }
  const report = await withFreshIndex(ctx, () => {
    const factor = validityFactor(ctx.index, asOf);
    const configs = fusionEvalConfigs({
      candidates: (question) =>
        searchCandidates(ctx.index, {
          query: question.query,
          filters: {},
          store,
          vector: queryVectors.get(question.query) ?? null,
          ...(input.titleWeight === undefined ? {} : { titleWeight: input.titleWeight }),
        }).input,
      resolve: (noteId) => {
        const note = getNote(ctx.index, { id: noteId });
        return note === null ? { id: noteId } : { id: note.id, path: note.path };
      },
      alphas: input.alphas ?? DEFAULT_EVAL_ALPHAS,
      noteFactor: factor,
    });
    return compareConfigs(input.questions, store === null ? configs.slice(0, 1) : configs, {
      ...(input.k === undefined ? {} : { k: input.k }),
    });
  });
  return { report, vector: store !== null, vector_problem: vectorProblem, model: embedding?.model ?? null };
}
