/**
 * Carga do modelo e cálculo dos vetores com uma sessão ONNX direta + tokenizador (sem transformers.js): o spike 11
 * mostrou que isso reproduz os mesmos vetores com uma fração do tamanho, e o mesmo código serve ao nativo e ao
 * WebAssembly.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ModelSpec } from './config.ts';
import { type DownloadOptions, type DownloadProgress, ensureModelFiles, type ModelFiles } from './download.ts';
import { DimensionMismatchError, EmbeddingsError, ModelLoadError } from './errors.ts';
import {
  encodeTruncated,
  l2Normalize,
  padBatch,
  planBatches,
  poolOutput,
  type TokenizerLike,
  toFloat32,
} from './inference.ts';
import { type EmbedInput, type EmbedKind, formatInput } from './prompt.ts';
import { loadRuntime, type OrtSession, type OrtTensor, type RuntimeImporter, type RuntimeModule } from './runtime.ts';

export type EmbedderBackend = 'native' | 'wasm' | 'fake';

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  readonly backend: EmbedderBackend;
  /**
   * Um vetor por texto, na mesma ordem. Aplica o molde do modelo para `kind` (prefixo de pergunta ou de trecho, com o
   * título no lugar certo), agrega e normaliza. Chamadas simultâneas são atendidas uma por vez.
   */
  embed(texts: readonly EmbedInput[], kind: EmbedKind): Promise<Float32Array[]>;
  /** Solta a sessão. Depois disso, `embed` falha. */
  dispose(): Promise<void>;
}

/** Textos por lote (o mesmo do spike 11). */
export const DEFAULT_BATCH_SIZE = 16;
/** Tokens por lote contando o preenchimento: 16 trechos de 512 tokens. */
export const DEFAULT_MAX_BATCH_TOKENS = 16 * 512;
/** Quando nem a configuração nem o tokenizador dizem o limite. */
const FALLBACK_MAX_TOKENS = 512;
/** `model_max_length` absurdo (alguns tokenizadores gravam 1e30) não vale. */
const MAX_REASONABLE_TOKENS = 32_768;

export interface LoadEmbedderOptions extends Omit<DownloadOptions, 'onProgress'> {
  onProgress?: (event: DownloadProgress) => void;
  /** Importador do `loader.mjs` (padrão: `import(pathToFileURL(loader))`). */
  importRuntime?: RuntimeImporter;
  batchSize?: number;
  maxBatchTokens?: number;
}

/**
 * Carrega o runtime instalado, baixa o modelo se não estiver no cache e abre a sessão. Confere as dimensões com um
 * texto de prova antes de devolver.
 */
export async function loadEmbedder(spec: ModelSpec, options: LoadEmbedderOptions = {}): Promise<Embedder> {
  const runtime = await loadRuntime({
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
    ...(options.importRuntime ? { importRuntime: options.importRuntime } : {}),
  });
  const files = await ensureModelFiles(spec, options);
  return createOnnxEmbedder({
    spec,
    runtime,
    files,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.maxBatchTokens !== undefined ? { maxBatchTokens: options.maxBatchTokens } : {}),
  });
}

export interface CreateOnnxEmbedderParams {
  spec: ModelSpec;
  runtime: RuntimeModule;
  files: ModelFiles;
  batchSize?: number;
  maxBatchTokens?: number;
}

/** Monta o embedder a partir de um runtime já carregado e dos arquivos já no disco. */
export async function createOnnxEmbedder(params: CreateOnnxEmbedderParams): Promise<Embedder> {
  const { spec, runtime, files } = params;
  const batchSize = Math.max(1, params.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxBatchTokens = Math.max(1, params.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS);

  let tokenizerConfig: Record<string, unknown>;
  let tokenizer: TokenizerLike;
  try {
    tokenizerConfig = JSON.parse(await readFile(files.tokenizerConfig, 'utf8')) as Record<string, unknown>;
    tokenizer = new runtime.Tokenizer(JSON.parse(await readFile(files.tokenizer, 'utf8')), tokenizerConfig);
  } catch (error) {
    throw new ModelLoadError(`não consegui abrir o tokenizador de ${spec.repo}: ${messageOf(error)}`, { cause: error });
  }
  const maxTokens = spec.maxTokens ?? configuredMaxTokens(tokenizerConfig);
  const padId = padTokenId(tokenizer, tokenizerConfig);

  let session: OrtSession;
  try {
    session = await openSession(runtime, files);
  } catch (error) {
    throw new ModelLoadError(`não consegui abrir o modelo ${spec.repo}/${spec.file}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const outputName = pickOutput(session, spec);
  for (const name of session.inputNames) {
    if (!KNOWN_INPUTS.has(name)) {
      await session.release?.().catch(() => {});
      throw new ModelLoadError(`o modelo ${spec.repo} pede uma entrada que o Cabeção não sabe preencher: ${name}`);
    }
  }

  const runBatch = async (sequences: number[][]): Promise<Float32Array[]> => {
    const batch = padBatch(sequences, padId);
    const shape = [batch.rows, batch.width];
    const feeds: Record<string, OrtTensor> = {};
    for (const name of session.inputNames) {
      if (name === 'input_ids') feeds[name] = new runtime.ort.Tensor('int64', batch.ids, shape);
      else if (name === 'attention_mask') feeds[name] = new runtime.ort.Tensor('int64', batch.mask, shape);
      else if (name === 'token_type_ids') {
        feeds[name] = new runtime.ort.Tensor('int64', new BigInt64Array(batch.rows * batch.width), shape);
      } else if (name === 'position_ids') {
        const positions = new BigInt64Array(batch.rows * batch.width);
        for (let row = 0; row < batch.rows; row++) {
          for (let i = 0; i < batch.width; i++) positions[row * batch.width + i] = BigInt(i);
        }
        feeds[name] = new runtime.ort.Tensor('int64', positions, shape);
      }
    }
    const outputs = await session.run(feeds);
    try {
      const output = outputs[outputName];
      if (!output) throw new ModelLoadError(`o modelo não devolveu a saída ${outputName}`);
      return poolOutput(toFloat32(output.data), output.dims, batch.lengths, spec.pooling);
    } finally {
      for (const tensor of Object.values(outputs)) tensor.dispose?.();
    }
  };

  const embedNow = async (texts: readonly EmbedInput[], kind: EmbedKind): Promise<Float32Array[]> => {
    const result: Float32Array[] = new Array(texts.length);
    // Tokeniza em janelas: uma lista enorme não vira, de uma vez, centenas de MB de ids na memória.
    for (let offset = 0; offset < texts.length; offset += TOKENIZE_WINDOW) {
      const window = texts.slice(offset, offset + TOKENIZE_WINDOW);
      const sequences = window.map((input) =>
        encodeTruncated(tokenizer, formatInput(spec.prompts, input, kind), maxTokens),
      );
      const limits = { batchSize, maxBatchTokens };
      for (const indices of planBatches(
        sequences.map((seq) => seq.length),
        limits,
      )) {
        const vectors = await runBatch(indices.map((index) => sequences[index] ?? []));
        indices.forEach((index, i) => {
          const vector = vectors[i];
          if (!vector) throw new ModelLoadError('o modelo devolveu menos vetores que textos');
          if (vector.length !== spec.dims) throw new DimensionMismatchError(spec.model, spec.dims, vector.length);
          result[offset + index] = spec.normalize ? l2Normalize(vector) : vector;
        });
      }
    }
    return result;
  };

  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const embedder: Embedder = {
    model: spec.model,
    dims: spec.dims,
    backend: runtime.backend,
    embed(texts, kind) {
      if (disposed) return Promise.reject(new EmbeddingsError('EMBEDDINGS_DISPOSED', 'o embedder já foi liberado'));
      if (texts.length === 0) return Promise.resolve([]);
      const run = queue.then(() => embedNow(texts, kind));
      queue = run.catch(() => {});
      return run;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      await session.release?.();
    },
  };

  try {
    await embedder.embed(['ok'], 'query');
  } catch (error) {
    await embedder.dispose().catch(() => {});
    if (error instanceof EmbeddingsError) throw error;
    throw new ModelLoadError(`o modelo ${spec.repo} falhou no texto de prova: ${messageOf(error)}`, { cause: error });
  }
  return embedder;
}

const TOKENIZE_WINDOW = 256;
const KNOWN_INPUTS = new Set(['input_ids', 'attention_mask', 'token_type_ids', 'position_ids']);

async function openSession(runtime: RuntimeModule, files: ModelFiles): Promise<OrtSession> {
  if (runtime.backend === 'native') {
    // Pelo caminho, o onnxruntime acha sozinho os pesos externos na mesma pasta.
    return runtime.ort.InferenceSession.create(files.model);
  }
  const externalData = await Promise.all(
    files.externalData.map(async (path) => ({ path: basename(path), data: new Uint8Array(await readFile(path)) })),
  );
  return runtime.ort.InferenceSession.create(new Uint8Array(await readFile(files.model)), {
    executionProviders: ['wasm'],
    ...(externalData.length > 0 ? { externalData } : {}),
  });
}

function pickOutput(session: OrtSession, spec: ModelSpec): string {
  const names = session.outputNames;
  if (spec.pooling === 'graph') {
    if (names.includes('sentence_embedding')) return 'sentence_embedding';
    throw new ModelLoadError(
      `agregação "graph" exige a saída sentence_embedding, e o modelo ${spec.repo} só tem: ${names.join(', ')}`,
    );
  }
  for (const preferred of ['last_hidden_state', 'token_embeddings']) if (names.includes(preferred)) return preferred;
  const first = names[0];
  if (!first) throw new ModelLoadError(`o modelo ${spec.repo} não tem saídas`);
  return first;
}

function configuredMaxTokens(config: Record<string, unknown>): number {
  const value = config.model_max_length;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_REASONABLE_TOKENS
    ? value
    : FALLBACK_MAX_TOKENS;
}

function padTokenId(tokenizer: TokenizerLike, config: Record<string, unknown>): number {
  const pad = config.pad_token;
  const token =
    typeof pad === 'string'
      ? pad
      : typeof pad === 'object' && pad !== null && typeof (pad as { content?: unknown }).content === 'string'
        ? (pad as { content: string }).content
        : undefined;
  return (token !== undefined ? tokenizer.token_to_id(token) : undefined) ?? 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}
