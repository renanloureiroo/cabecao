// Reprodutibilidade: a revisão (commit) do modelo é resolvida uma vez, gravada no `.cabecao.json`, e todas as máquinas
// baixam ESSA revisão. Sem rede: o `fetch` é falso.
import { describe, expect, it } from 'vitest';
import {
  catalogConfig,
  EmbeddingConfigError,
  EmbeddingsNetworkError,
  isCommitRevision,
  ModelNotFoundError,
  modelDir,
  resolveEmbeddingConfig,
  resolveModelRevision,
} from '../src/index.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(`${init?.method ?? 'GET'} ${url}`);
    return handler(url, init);
  }) as typeof fetch & { urls: string[] };
  fn.urls = urls;
  return fn;
}

describe('revisão do modelo', () => {
  const spec = resolveEmbeddingConfig(catalogConfig('multilingual-e5-small'));

  it('o catálogo sem revisão baixa de main; com revisão gravada, baixa dela (e a pasta do cache é a da revisão)', () => {
    expect(spec.revision).toBe('main');
    const pinned = resolveEmbeddingConfig({ ...catalogConfig('multilingual-e5-small'), revision: SHA });
    expect(pinned.revision).toBe(SHA);
    expect(modelDir('/cache', pinned)).toMatch(new RegExp(`${SHA}$`));
    expect(isCommitRevision(SHA)).toBe(true);
    expect(isCommitRevision('main')).toBe(false);
  });

  it('revisão inválida no .cabecao.json é recusada', () => {
    for (const revision of ['', '../x', '-rf', 'a b', 5]) {
      expect(() => resolveEmbeddingConfig({ ...catalogConfig('multilingual-e5-small'), revision })).toThrow(
        EmbeddingConfigError,
      );
    }
  });

  it('resolve o commit pela API do Hugging Face', async () => {
    const fetch = fakeFetch(() => Response.json({ sha: SHA, id: 'Xenova/multilingual-e5-small' }));
    expect(await resolveModelRevision(spec, { fetch, endpoint: 'https://hf.example' })).toBe(SHA);
    expect(fetch.urls).toEqual(['GET https://hf.example/api/models/Xenova/multilingual-e5-small/revision/main']);
  });

  it('sem o campo na API, usa o cabeçalho x-repo-commit de um arquivo do modelo', async () => {
    const fetch = fakeFetch((_url, init) =>
      init?.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'x-repo-commit': SHA } })
        : Response.json({}),
    );
    expect(await resolveModelRevision(spec, { fetch, endpoint: 'https://hf.example/' })).toBe(SHA);
    expect(fetch.urls[1]).toBe(
      'HEAD https://hf.example/Xenova/multilingual-e5-small/resolve/main/tokenizer_config.json',
    );
  });

  it('uma revisão que já é commit volta sem rede', async () => {
    const fetch = fakeFetch(() => {
      throw new Error('não devia usar a rede');
    });
    expect(await resolveModelRevision({ ...spec, revision: SHA }, { fetch })).toBe(SHA);
    expect(fetch.urls).toEqual([]);
  });

  it('repositório inexistente e falta de rede viram os erros do runtime', async () => {
    const missing = fakeFetch(() => new Response('não', { status: 404 }));
    await expect(resolveModelRevision(spec, { fetch: missing })).rejects.toBeInstanceOf(ModelNotFoundError);
    const offline = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    await expect(resolveModelRevision(spec, { fetch: offline })).rejects.toBeInstanceOf(EmbeddingsNetworkError);
    const noCommit = fakeFetch(() => Response.json({ sha: 'não é commit' }));
    await expect(resolveModelRevision(spec, { fetch: noCommit })).rejects.toBeInstanceOf(EmbeddingsNetworkError);
  });
});
