import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DimensionMismatchError,
  type DownloadProgress,
  dot,
  EmbeddingsNetworkError,
  installRuntime,
  loadEmbedder,
  ModelLoadError,
  ModelNotFoundError,
  type ModelSpec,
  modelCacheStatus,
  modelDir,
  RuntimeNotInstalledError,
  resolveEmbeddingConfig,
} from '../src/index.ts';
import { FAKE_NPM_COMMAND, fakeNpm, tempDir } from './helpers.ts';

let cacheDir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: cacheDir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const DIMS = 8;

function customSpec(extra: Record<string, unknown> = {}): ModelSpec {
  return resolveEmbeddingConfig({
    model: 'falso',
    repo: 'teste/falso-ONNX',
    file: 'onnx/model.onnx',
    dims: DIMS,
    pooling: 'mean',
    ...extra,
  });
}

interface FakeHub {
  fetch: typeof fetch;
  urls: string[];
}

/** Hugging Face de mentira: serve o tokenizador e um "modelo" JSON que o onnxruntime falso entende. */
function fakeHub(model: Record<string, unknown> = { fakeModel: true, dims: DIMS }, status = 200): FakeHub {
  const urls: string[] = [];
  const files: Record<string, string> = {
    'tokenizer.json': JSON.stringify({ model: { type: 'falso' } }),
    'tokenizer_config.json': JSON.stringify({ model_max_length: 512, pad_token: '<pad>' }),
    'onnx/model.onnx': JSON.stringify(model),
    'onnx/model.onnx_data': 'pesos externos',
  };
  return {
    urls,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const file = url.split('/resolve/main/')[1] ?? '';
      const body = files[file];
      if (status !== 200) return new Response('erro', { status });
      if (body === undefined) return new Response('não achei', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
    }) as typeof fetch,
  };
}

const offline = (async () => {
  throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
}) as typeof fetch;

async function install(backend: 'native' | 'wasm' = 'native') {
  await installRuntime({
    cacheDir,
    npm: FAKE_NPM_COMMAND,
    runNpm: fakeNpm().run,
    probe: async () => ({ ok: true, ms: 1 }),
    backend,
  });
}

describe('loadEmbedder', () => {
  it('sem runtime: RuntimeNotInstalledError, antes de tocar a rede', async () => {
    const hub = fakeHub();
    const error = await loadEmbedder(customSpec(), { cacheDir, fetch: hub.fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeNotInstalledError);
    expect(hub.urls).toEqual([]);
  });

  it('baixa o modelo com progresso; com o modelo no cache, não toca a rede', async () => {
    await install();
    const hub = fakeHub();
    const events: DownloadProgress[] = [];
    const spec = customSpec();
    const embedder = await loadEmbedder(spec, { cacheDir, fetch: hub.fetch, onProgress: (e) => events.push(e) });
    expect(embedder).toMatchObject({ model: 'falso', dims: DIMS, backend: 'native' });
    expect(hub.urls).toEqual([
      'https://huggingface.co/teste/falso-ONNX/resolve/main/tokenizer.json',
      'https://huggingface.co/teste/falso-ONNX/resolve/main/tokenizer_config.json',
      'https://huggingface.co/teste/falso-ONNX/resolve/main/onnx/model.onnx',
    ]);
    expect(events.map((e) => e.file)).toEqual(['tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx']);
    expect(events.every((e) => e.loaded === e.total)).toBe(true);
    expect(existsSync(join(modelDir(cacheDir, spec), 'onnx', 'model.onnx'))).toBe(true);
    expect((await modelCacheStatus(spec, { cacheDir })).cached).toBe(true);
    await embedder.dispose();

    const again = await loadEmbedder(spec, { cacheDir, fetch: offline });
    expect((await again.embed(['oi'], 'query'))[0]).toHaveLength(DIMS);
    await again.dispose();
  });

  it('devolve vetores normalizados, na ordem, determinísticos', async () => {
    await install();
    const embedder = await loadEmbedder(customSpec(), { cacheDir, fetch: fakeHub().fetch });
    const texts = ['filas com SQS', 'bolo de cenoura', 'filas com SQS'];
    const vectors = await embedder.embed(texts, 'passage');
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(dot(v, v)).toBeCloseTo(1, 5);
    }
    expect(Array.from(vectors[0] ?? [])).toEqual(Array.from(vectors[2] ?? []));
    expect(dot(vectors[0] ?? new Float32Array(), vectors[1] ?? new Float32Array())).toBeLessThan(0.999);
    expect(await embedder.embed([], 'query')).toEqual([]);
    await embedder.dispose();
  });

  it('aplica o prefixo do tipo: pergunta "x" com prefixo "Q: " = trecho "Q: x" sem prefixo', async () => {
    await install();
    const embedder = await loadEmbedder(customSpec({ queryPrefix: 'Q: ' }), { cacheDir, fetch: fakeHub().fetch });
    const [query] = await embedder.embed(['x'], 'query');
    const [samePassage, plainPassage] = await embedder.embed(['Q: x', 'x'], 'passage');
    expect(Array.from(query ?? [])).toEqual(Array.from(samePassage ?? []));
    expect(Array.from(query ?? [])).not.toEqual(Array.from(plainPassage ?? []));
    // O título entra na primeira linha do trecho.
    const [titled] = await embedder.embed([{ text: 'corpo', title: 'T' }], 'passage');
    const [manual] = await embedder.embed(['T\ncorpo'], 'passage');
    expect(Array.from(titled ?? [])).toEqual(Array.from(manual ?? []));
    await embedder.dispose();
  });

  it('a agregação ignora o preenchimento: em lote ou sozinho, o mesmo vetor', async () => {
    await install();
    const embedder = await loadEmbedder(customSpec(), { cacheDir, fetch: fakeHub().fetch });
    const texts = ['a', 'um texto bem mais comprido que o primeiro', 'médio aqui'];
    const together = await embedder.embed(texts, 'passage');
    for (const [i, text] of texts.entries()) {
      const [alone] = await embedder.embed([text], 'passage');
      for (const [j, value] of Array.from(alone ?? []).entries()) expect(together[i]?.[j]).toBeCloseTo(value, 5);
    }
    await embedder.dispose();
  });

  it('lotes pequenos dão os mesmos vetores que um lote grande', async () => {
    await install();
    const texts = Array.from({ length: 40 }, (_, i) => `trecho número ${i} ${'x'.repeat(i)}`);
    const big = await loadEmbedder(customSpec(), { cacheDir, fetch: fakeHub().fetch });
    const small = await loadEmbedder(customSpec(), { cacheDir, fetch: offline, batchSize: 3, maxBatchTokens: 60 });
    const [a, b] = await Promise.all([big.embed(texts, 'passage'), small.embed(texts, 'passage')]);
    for (const [i, vector] of a.entries()) {
      for (const [j, value] of Array.from(vector).entries()) expect(b[i]?.[j]).toBeCloseTo(value, 5);
    }
    await Promise.all([big.dispose(), small.dispose()]);
  });

  it('corta textos longos em maxTokens', async () => {
    await install();
    const embedder = await loadEmbedder(customSpec({ maxTokens: 8 }), { cacheDir, fetch: fakeHub().fetch });
    const [a, b] = await embedder.embed(['abcdefXXXXXX', 'abcdefYYYYYY'], 'passage');
    expect(Array.from(a ?? [])).toEqual(Array.from(b ?? []));
    await embedder.dispose();
  });

  it('agregação graph usa sentence_embedding do grafo; no WebAssembly, lê os pesos externos', async () => {
    await install('wasm');
    const spec = customSpec({ pooling: 'graph', externalData: ['onnx/model.onnx_data'] });
    const hub = fakeHub({ fakeModel: true, dims: DIMS, graph: true });
    const embedder = await loadEmbedder(spec, { cacheDir, fetch: hub.fetch });
    expect(embedder.backend).toBe('wasm');
    expect(hub.urls.some((u) => u.endsWith('model.onnx_data'))).toBe(true);
    const [v] = await embedder.embed(['oi'], 'query');
    expect(dot(v ?? new Float32Array(), v ?? new Float32Array())).toBeCloseTo(1, 5);
    await embedder.dispose();
    await expect(embedder.embed(['oi'], 'query')).rejects.toMatchObject({ code: 'EMBEDDINGS_DISPOSED' });
  });

  it('dimensões que não batem com o declarado: DimensionMismatchError na carga', async () => {
    await install();
    const error = await loadEmbedder(customSpec({ dims: 16 }), { cacheDir, fetch: fakeHub().fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DimensionMismatchError);
    expect(error).toMatchObject({ expected: 16, actual: DIMS, code: 'EMBEDDINGS_DIMS_MISMATCH' });
  });

  it('graph declarado num modelo sem sentence_embedding: ModelLoadError', async () => {
    await install();
    const error = await loadEmbedder(customSpec({ pooling: 'graph' }), { cacheDir, fetch: fakeHub().fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelLoadError);
    expect((error as Error).message).toContain('sentence_embedding');
  });

  it('arquivo que não existe: ModelNotFoundError, sem novas tentativas', async () => {
    await install();
    const hub = fakeHub();
    const error = await loadEmbedder(customSpec({ file: 'onnx/outro.onnx' }), { cacheDir, fetch: hub.fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelNotFoundError);
    expect(error).toMatchObject({ status: 404, code: 'EMBEDDINGS_MODEL_NOT_FOUND' });
    expect(hub.urls.filter((u) => u.endsWith('outro.onnx'))).toHaveLength(1);
    const gated = await loadEmbedder(customSpec(), { cacheDir, fetch: fakeHub({}, 401).fetch }).catch(
      (e: unknown) => e,
    );
    expect((gated as Error).message).toContain('privado');
  });

  it('sem rede: EmbeddingsNetworkError, e nenhum arquivo pela metade no cache', async () => {
    await install();
    const spec = customSpec();
    const error = await loadEmbedder(spec, { cacheDir, fetch: offline }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingsNetworkError);
    expect(error).toMatchObject({ code: 'EMBEDDINGS_OFFLINE' });
    expect((error as Error).message).toContain('ENOTFOUND');
    expect((await modelCacheStatus(spec, { cacheDir })).missing).toHaveLength(3);
  });

  it('download cortado no meio não vira arquivo no cache', async () => {
    await install();
    const spec = customSpec();
    const short = (async () =>
      new Response('abc', { status: 200, headers: { 'content-length': '10' } })) as typeof fetch;
    const error = await loadEmbedder(spec, { cacheDir, fetch: short }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingsNetworkError);
    expect((error as Error).message).toContain('incompleto');
    expect((await modelCacheStatus(spec, { cacheDir })).cached).toBe(false);
  });
});
