// O runtime de embeddings visto pela CLI: o provedor que a CLI injeta no núcleo (`openBrain({ embeddings })`) e no
// servidor MCP, e as etapas do `cabecao embeddings on` (instalar o runtime, resolver a revisão, baixar o modelo).
// Este módulo é carregado só pelos comandos que abrem o cérebro, nunca pelo `--version`.
//
// Variável de ambiente de TESTE `CABECAO_TEST_FAKE_EMBEDDER=1`: troca o modelo por um embedder determinístico, sem
// rede e sem runtime (o `createFakeEmbedder` de `packages/embeddings`). Nada é baixado nem instalado, a revisão não é
// resolvida, e os vetores vão para uma pasta própria da branch de índice (`<modelo>-<variante>-fake-r<receita>`):
// vetores de mentira nunca se misturam aos de verdade, nem numa máquina que rode sem a variável. Existe para o teste
// de ponta a ponta (`scripts/e2e.mjs`); um aviso sai no stderr sempre que ela está ligada.
import type { EmbeddingConfig, EmbeddingProvider, ResolvedEmbedding } from '@cabecao/core';
import { cacheDir, modelDirName } from '@cabecao/core';
import {
  createFakeEmbedder,
  DEFAULT_REVISION,
  ensureModelFiles,
  type InstallProgress,
  type InstallRuntimeResult,
  installRuntime,
  loadEmbedder,
  type ModelSpec,
  modelCacheStatus,
  resolveEmbeddingConfig,
  resolveModelRevision,
  runtimeStatus,
} from '@cabecao/embeddings';
import { dirContext } from './dirs.ts';
import type { CliIo } from './types.ts';

export const FAKE_EMBEDDER_ENV = 'CABECAO_TEST_FAKE_EMBEDDER';

type Io = Pick<CliIo, 'env' | 'platform' | 'homedir'>;

/** O embedder falso de teste está ligado no ambiente injetado. */
export function fakeEmbedderOn(io: Pick<CliIo, 'env'>): boolean {
  return io.env[FAKE_EMBEDDER_ENV] === '1';
}

/** Pasta de dados do usuário onde ficam o runtime e os modelos (respeita `CABECAO_CACHE_DIR`). */
export function embeddingsCacheDir(io: Io): string {
  return cacheDir(dirContext(io));
}

/** O `ModelSpec` do `embedding` do `.cabecao.json` (catálogo ou modelo próprio, com a revisão gravada). */
export function specOf(config: EmbeddingConfig): ModelSpec {
  return resolveEmbeddingConfig(config);
}

function resolved(spec: ModelSpec, config: EmbeddingConfig, fake: boolean): ResolvedEmbedding {
  const variant = fake ? `${spec.variant}-fake` : spec.variant;
  return {
    model: spec.model,
    variant,
    recipe: spec.recipe,
    dims: spec.dims,
    modelDir: modelDirName({ model: spec.model, variant, recipe: spec.recipe }),
    revision: typeof config.revision === 'string' ? config.revision : null,
  };
}

/** O provedor que a CLI injeta no núcleo. Criar não carrega nada; só `load` abre o modelo. */
export function embeddingProvider(io: Io): EmbeddingProvider {
  const fake = fakeEmbedderOn(io);
  const cache = embeddingsCacheDir(io);
  return {
    resolve(config) {
      const spec = specOf(config);
      if (spec.dims !== config.dims) {
        throw new Error(`"dims" do .cabecao.json é ${config.dims}, mas o modelo ${spec.model} tem ${spec.dims}`);
      }
      return resolved(spec, config, fake);
    },
    async available(config) {
      const spec = specOf(config);
      if (fake) return { ok: true, backend: 'fake', modelCached: true };
      const runtime = await runtimeStatus({ cacheDir: cache });
      if (!runtime.installed) {
        return {
          ok: false,
          code: 'runtime_missing',
          reason: `o runtime de embeddings não está instalado nesta máquina${runtime.problem ? ` (${runtime.problem})` : ''}: rode "cabecao embeddings on"`,
        };
      }
      if (!runtime.upToDate) {
        return {
          ok: false,
          code: 'runtime_outdated',
          reason:
            'o runtime de embeddings desta máquina é de outra versão ou de outro sistema: rode "cabecao embeddings on"',
        };
      }
      const model = await modelCacheStatus(spec, { cacheDir: cache });
      if (!model.cached) {
        return {
          ok: false,
          code: 'model_missing',
          reason: `o modelo ${spec.model} não está baixado nesta máquina: rode "cabecao embeddings on"`,
        };
      }
      return { ok: true, backend: runtime.backend ?? null, modelCached: true };
    },
    async load(config, options = {}) {
      const spec = specOf(config);
      if (fake) return createFakeEmbedder(spec.dims, { model: spec.model });
      return loadEmbedder(spec, {
        cacheDir: cache,
        ...(options.onProgress === undefined
          ? {}
          : {
              onProgress: (event) =>
                options.onProgress?.({ file: event.file, loaded: event.loaded, total: event.total }),
            }),
      });
    },
  };
}

/**
 * Revisão (commit) para gravar no `.cabecao.json` na primeira escolha do modelo: o catálogo baixa de `main`, então
 * o commit de agora é fixado para todas as máquinas baixarem os mesmos arquivos. `undefined` no modo de teste.
 */
export async function pinRevision(io: Io, config: EmbeddingConfig): Promise<string | undefined> {
  if (fakeEmbedderOn(io)) return undefined;
  const spec = specOf(config);
  if (spec.revision !== DEFAULT_REVISION && /^[0-9a-f]{40}$/.test(spec.revision)) return spec.revision;
  return resolveModelRevision(spec);
}

/** Instala (ou confere) o runtime, com o progresso no stderr. `null` no modo de teste. */
export async function ensureRuntime(
  io: Io,
  onProgress?: (event: InstallProgress) => void,
): Promise<InstallRuntimeResult | null> {
  if (fakeEmbedderOn(io)) return null;
  return installRuntime({ cacheDir: embeddingsCacheDir(io), ...(onProgress ? { onProgress } : {}) });
}

/** Baixa os arquivos do modelo que faltam no cache (nada no modo de teste). */
export async function ensureModel(
  io: Io,
  config: EmbeddingConfig,
  onProgress?: (event: { file: string; loaded: number; total: number | null }) => void,
): Promise<{ dir: string } | null> {
  if (fakeEmbedderOn(io)) return null;
  const files = await ensureModelFiles(specOf(config), {
    cacheDir: embeddingsCacheDir(io),
    ...(onProgress ? { onProgress } : {}),
  });
  return { dir: files.dir };
}
