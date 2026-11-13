/**
 * Download dos arquivos do modelo para `<cache>/models/<dono>/<nome>/<revisão>/`. Modelo já no cache não toca a rede.
 * Cada arquivo é baixado para um temporário na mesma pasta e renomeado no fim: um download interrompido nunca parece
 * completo. Uma trava por modelo impede dois processos de baixar o mesmo arquivo ao mesmo tempo.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cacheDir as defaultCacheDir, withLock } from '@cabecao/core';
import type { ModelSpec } from './config.ts';
import { EmbeddingsNetworkError, ModelNotFoundError } from './errors.ts';

export const MODELS_DIR_NAME = 'models';
export const TOKENIZER_FILE = 'tokenizer.json';
export const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json';
export const DEFAULT_HF_ENDPOINT = 'https://huggingface.co';

export interface DownloadProgress {
  phase: 'download';
  /** Caminho do arquivo dentro do repositório. */
  file: string;
  loaded: number;
  /** `null` quando o servidor não informa o tamanho. */
  total: number | null;
}

export interface ModelFiles {
  dir: string;
  model: string;
  externalData: string[];
  tokenizer: string;
  tokenizerConfig: string;
}

export interface DownloadOptions {
  cacheDir?: string;
  onProgress?: (event: DownloadProgress) => void;
  /** `fetch` usado nos downloads (padrão: o global). */
  fetch?: typeof fetch;
  /** Servidor do Hugging Face (padrão: `HF_ENDPOINT` ou https://huggingface.co). */
  endpoint?: string;
  signal?: AbortSignal;
  /** Quanto esperar por outro processo baixando o mesmo modelo (padrão: 30 min). */
  lockTimeoutMs?: number;
}

/** Pasta do modelo no cache. A revisão pode ter `/` (nome de branch): vira `--`. */
export function modelDir(cacheDir: string, spec: Pick<ModelSpec, 'repo' | 'revision'>): string {
  return join(cacheDir, MODELS_DIR_NAME, ...spec.repo.split('/'), spec.revision.replaceAll('/', '--'));
}

/** Arquivos que o modelo precisa, como caminhos dentro do repositório. */
export function modelRepoFiles(spec: Pick<ModelSpec, 'file' | 'externalData'>): string[] {
  return [TOKENIZER_FILE, TOKENIZER_CONFIG_FILE, spec.file, ...spec.externalData];
}

function localPaths(dir: string, spec: ModelSpec): ModelFiles {
  const local = (file: string) => join(dir, ...file.split('/'));
  return {
    dir,
    model: local(spec.file),
    externalData: spec.externalData.map(local),
    tokenizer: local(TOKENIZER_FILE),
    tokenizerConfig: local(TOKENIZER_CONFIG_FILE),
  };
}

export interface ModelCacheStatus {
  dir: string;
  cached: boolean;
  missing: string[];
}

/** Quais arquivos do modelo faltam no cache. Não usa a rede. */
export async function modelCacheStatus(
  spec: ModelSpec,
  options: { cacheDir?: string } = {},
): Promise<ModelCacheStatus> {
  const dir = modelDir(options.cacheDir ?? defaultCacheDir(), spec);
  const missing = await missingFiles(dir, spec);
  return { dir, cached: missing.length === 0, missing };
}

async function missingFiles(dir: string, spec: ModelSpec): Promise<string[]> {
  const missing: string[] = [];
  for (const file of modelRepoFiles(spec)) {
    try {
      const st = await stat(join(dir, ...file.split('/')));
      if (!st.isFile()) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  return missing;
}

/** Garante os arquivos do modelo no cache, baixando o que faltar, e devolve os caminhos locais. */
export async function ensureModelFiles(spec: ModelSpec, options: DownloadOptions = {}): Promise<ModelFiles> {
  const cache = options.cacheDir ?? defaultCacheDir();
  const dir = modelDir(cache, spec);
  if ((await missingFiles(dir, spec)).length === 0) return localPaths(dir, spec);

  const lockName = `${spec.repo.replaceAll('/', '__')}@${spec.revision.replaceAll('/', '--')}.lock`;
  await withLock(
    join(cache, MODELS_DIR_NAME, '.locks', lockName),
    async () => {
      // Outro processo pode ter baixado enquanto esperávamos a trava.
      for (const file of await missingFiles(dir, spec)) {
        await downloadFile(spec, file, join(dir, ...file.split('/')), options);
      }
    },
    { timeoutMs: options.lockTimeoutMs ?? 30 * 60_000 },
  );
  return localPaths(dir, spec);
}

export function fileUrl(endpoint: string, spec: Pick<ModelSpec, 'repo' | 'revision'>, file: string): string {
  const base = endpoint.replace(/\/+$/, '');
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `${base}/${spec.repo}/resolve/${encodeURIComponent(spec.revision)}/${path}`;
}

const ATTEMPTS = 3;
const PROGRESS_STEP = 1 << 20;

async function downloadFile(spec: ModelSpec, file: string, target: string, options: DownloadOptions): Promise<void> {
  const endpoint = options.endpoint ?? (process.env.HF_ENDPOINT || DEFAULT_HF_ENDPOINT);
  const url = fileUrl(endpoint, spec, file);
  const doFetch = options.fetch ?? fetch;
  await mkdir(dirname(target), { recursive: true });

  for (let attempt = 1; ; attempt++) {
    const tmp = `${target}.${process.pid}-${randomBytes(4).toString('hex')}.part`;
    try {
      let response: Response;
      try {
        response = await doFetch(url, {
          redirect: 'follow',
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        throw new EmbeddingsNetworkError(url, networkReason(error), { cause: error });
      }
      if (response.status === 404 || response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new ModelNotFoundError(url, response.status);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new EmbeddingsNetworkError(url, `HTTP ${response.status}`);
      }
      const header = response.headers.get('content-length');
      // Com compressão, o `fetch` descomprime e o content-length (do corpo comprimido) não serve para conferir.
      const encoding = response.headers.get('content-encoding');
      const compressed = encoding !== null && encoding !== 'identity';
      const total = !compressed && header !== null && /^\d+$/.test(header) ? Number(header) : null;
      await writeBody(
        response.body,
        tmp,
        (loaded) => options.onProgress?.({ phase: 'download', file, loaded, total }),
        total,
      );
      await rename(tmp, target);
      return;
    } catch (error) {
      await unlink(tmp).catch(() => {});
      const retryable = error instanceof EmbeddingsNetworkError && !options.signal?.aborted;
      if (!retryable || attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function writeBody(
  body: ReadableStream<Uint8Array>,
  path: string,
  progress: (loaded: number) => void,
  total: number | null,
): Promise<void> {
  const handle = await open(path, 'wx');
  let loaded = 0;
  let reported = 0;
  try {
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk);
        loaded += chunk.byteLength;
        if (loaded - reported >= PROGRESS_STEP) {
          reported = loaded;
          progress(loaded);
        }
      }
    } catch (error) {
      throw new EmbeddingsNetworkError(path, `download interrompido: ${networkReason(error)}`, { cause: error });
    }
    if (total !== null && loaded !== total) {
      throw new EmbeddingsNetworkError(path, `download incompleto: ${loaded} de ${total} bytes`);
    }
    await handle.sync();
    progress(loaded);
  } finally {
    await handle.close();
  }
}

function networkReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return `${error.message}: ${cause.code}`;
  return cause?.message ? `${error.message}: ${cause.message}` : error.message;
}
