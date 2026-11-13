// Teste REAL, com rede: instala o runtime de verdade e roda o multilingual-e5-small. Pulado a menos de
// CABECAO_TEST_NETWORK=1. Usa CABECAO_CACHE_DIR se definido (e não apaga: quem definiu cuida), senão uma pasta
// temporária apagada no fim. Baixa cerca de 115 MB de runtime, 35 MB do WebAssembly e 135 MB de modelo.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  catalogConfig,
  type DownloadProgress,
  dot,
  type Embedder,
  installRuntime,
  loadEmbedder,
  resolveEmbeddingConfig,
  runtimeStatus,
  uninstallRuntime,
} from '../src/index.ts';

const enabled = process.env.CABECAO_TEST_NETWORK === '1';
const TIMEOUT = 20 * 60_000;

const docs = [
  'Decidimos migrar o broker de mensageria de RabbitMQ para SQS em maio para reduzir o custo operacional.',
  'O usuário prefere pnpm como gerenciador de pacotes e não quer que npm seja sugerido.',
  'A arquitetura hexagonal separa o domínio das portas e adaptadores de infraestrutura.',
  'Os testes de integração ficam instáveis quando o banco não é limpo entre as execuções.',
  'O bolo de cenoura leva três ovos, óleo, açúcar e cobertura de chocolate.',
  'Senhas e tokens nunca devem ser gravados na memória do agente.',
];
const queries: Array<[string, number]> = [
  ['por que trocamos o sistema de filas?', 0],
  ['qual ferramenta instalar dependências?', 1],
  ['como isolar regras de negócio de detalhes técnicos?', 2],
  ['por que a suíte falha de vez em quando?', 3],
  ['ingredientes da sobremesa', 4],
  ['posso guardar credenciais?', 5],
];
// ~350 tokens cada, como os trechos do índice.
const longChunks = Array.from({ length: 32 }, (_, i) => `Trecho ${i}: ${docs.join(' ').repeat(2)}`);

const ms = (start: number) => Math.round(performance.now() - start);
const mb = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;

describe.skipIf(!enabled)('runtime real (rede)', () => {
  const given = process.env.CABECAO_CACHE_DIR;
  let cacheDir = given ?? '';
  const metrics: Record<string, unknown> = { node: process.version, platform: `${process.platform}-${process.arch}` };
  const spec = resolveEmbeddingConfig(catalogConfig('multilingual-e5-small'));
  let nativeVectors: Float32Array[] = [];

  afterAll(async () => {
    console.log(`REAL ${JSON.stringify(metrics, null, 2)}`);
    if (!given && cacheDir) await rm(cacheDir, { recursive: true, force: true });
  });

  async function measure(embedder: Embedder, prefix: string) {
    const D = await embedder.embed(docs, 'passage');
    const Q = await embedder.embed(
      queries.map(([q]) => q),
      'query',
    );
    const top1 = queries.filter(([, expected], i) => {
      const scores = D.map((d) => dot(Q[i] ?? d, d));
      return scores.indexOf(Math.max(...scores)) === expected;
    }).length;
    await embedder.embed(longChunks.slice(0, 2), 'passage'); // aquecimento
    let t = performance.now();
    await embedder.embed(longChunks, 'passage');
    const chunksPerSecond = Math.round((32_000 / ms(t)) * 10) / 10;
    t = performance.now();
    for (const [q] of queries) await embedder.embed([q], 'query');
    metrics[prefix] = {
      ...(metrics[prefix] as object),
      top1: `${top1}/${queries.length}`,
      chunksPerSecond,
      queryMs: Math.round(ms(t) / queries.length),
      rssMB: mb(process.memoryUsage().rss),
    };
    return D;
  }

  it(
    'instala o runtime nativo, baixa e roda o e5-small, e frases parecidas ficam mais próximas',
    async () => {
      if (!cacheDir) cacheDir = await mkdtemp(join(tmpdir(), 'cabecao-real-'));
      metrics.cacheDir = cacheDir;

      let t = performance.now();
      const installed = await installRuntime({ cacheDir });
      const status = await runtimeStatus({ cacheDir, measure: true });
      metrics.native = {
        backend: installed.backend,
        npmVia: installed.npmVia,
        installMs: ms(t),
        runtimeMB: mb(status.sizeBytes ?? 0),
      };
      expect(installed.installed).toBe(true);

      t = performance.now();
      const again = await installRuntime({ cacheDir });
      expect(again.alreadyInstalled).toBe(true);
      (metrics.native as Record<string, unknown>).idempotentMs = ms(t);

      const downloads: DownloadProgress[] = [];
      t = performance.now();
      const first = await loadEmbedder(spec, { cacheDir, onProgress: (e) => downloads.push(e) });
      (metrics.native as Record<string, unknown>).firstLoadWithDownloadMs = ms(t);
      expect(downloads.length).toBeGreaterThan(0);
      await first.dispose();

      t = performance.now();
      const embedder = await loadEmbedder(spec, {
        cacheDir,
        fetch: (async () => {
          throw new Error('não devia tocar a rede');
        }) as typeof fetch,
      });
      (metrics.native as Record<string, unknown>).cachedLoadMs = ms(t);
      expect(embedder.backend).toBe(installed.backend);
      expect(embedder.dims).toBe(384);

      const [a, b, c] = await embedder.embed(
        [
          'Decidimos trocar o RabbitMQ pelo Amazon SQS para gastar menos com a fila de mensagens.',
          'A fila de mensagens saiu do RabbitMQ e foi para o SQS da AWS porque ficava mais barato.',
          'O bolo de cenoura leva três ovos, óleo, açúcar e cobertura de chocolate.',
        ],
        'passage',
      );
      const z = new Float32Array(384);
      const similar = dot(a ?? z, b ?? z);
      const different = Math.max(dot(a ?? z, c ?? z), dot(b ?? z, c ?? z));
      metrics.similarity = { similar: +similar.toFixed(4), different: +different.toFixed(4) };
      expect(similar).toBeGreaterThan(different);
      const [q] = await embedder.embed(['por que mudamos o sistema de filas?'], 'query');
      expect(dot(q ?? z, a ?? z)).toBeGreaterThan(dot(q ?? z, c ?? z));

      nativeVectors = await measure(embedder, 'native');
      await embedder.dispose();
    },
    TIMEOUT,
  );

  it(
    'o caminho WebAssembly forçado instala, usa o modelo do cache e dá vetores próximos do nativo',
    async () => {
      expect(cacheDir).not.toBe('');
      await uninstallRuntime({ cacheDir });
      let t = performance.now();
      const installed = await installRuntime({ cacheDir, backend: 'wasm' });
      const status = await runtimeStatus({ cacheDir, measure: true });
      metrics.wasm = { installMs: ms(t), runtimeMB: mb(status.sizeBytes ?? 0) };
      expect(installed.backend).toBe('wasm');

      const downloads: DownloadProgress[] = [];
      t = performance.now();
      const embedder = await loadEmbedder(spec, { cacheDir, onProgress: (e) => downloads.push(e) });
      (metrics.wasm as Record<string, unknown>).cachedLoadMs = ms(t);
      expect(downloads).toEqual([]);
      expect(embedder.backend).toBe('wasm');

      const D = await measure(embedder, 'wasm');
      const cosines = D.map((v, i) => dot(v, nativeVectors[i] ?? new Float32Array(v.length)));
      (metrics.wasm as Record<string, unknown>).minCosineVsNative = +Math.min(...cosines).toFixed(4);
      expect(Math.min(...cosines)).toBeGreaterThan(0.98);
      await embedder.dispose();
    },
    TIMEOUT,
  );
});
