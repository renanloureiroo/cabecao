// Serviço de embeddings: só o que falta, em rodadas (um segmento por rodada), vetores em memória atualizados aos poucos
// e falhas do modelo tratadas sem estado pela metade.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { embeddingInputs, openIndex, scan } from '../../src/db/index.ts';
import { EmbedderMismatchError, EmbeddingEngine, resolveFromConfig } from '../../src/embeddings/index.ts';
import { openIndexStore } from '../../src/indexstore/index.ts';
import { readBrainConfig } from '../../src/vault/index.ts';
import { cleanupAll, createBrainRepo, disposeSandbox, git, TEST_TIMEOUT_MS } from '../brain/helpers.ts';
import { fakeProvider, TEST_EMBEDDING } from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

async function inputsOf(dir: string) {
  const index = await openIndex(dir);
  try {
    await scan(index, dir, await readBrainConfig(dir));
    return embeddingInputs(index);
  } finally {
    index.close();
  }
}

describe('EmbeddingEngine', { timeout: TEST_TIMEOUT_MS }, () => {
  it('calcula só o que falta, em rodadas, um segmento por rodada; repetir não calcula nada', async () => {
    const dir = await createBrainRepo();
    const inputs = await inputsOf(dir);
    const provider = fakeProvider();
    const engine = new EmbeddingEngine({ root: dir, provider, roundSize: 10 });
    const events: string[] = [];
    const result = await engine.compute(TEST_EMBEDDING, inputs, { onProgress: (e) => events.push(e.phase) });
    expect(result).toMatchObject({ computed: inputs.length, pending: 0, had: 0, backend: 'fake' });
    expect(result.rounds).toBe(Math.ceil(inputs.length / 10));
    expect(events[0]).toBe('plan');
    expect(events).toContain('load');
    expect(events.at(-1)).toBe('done');
    const segments = await git(dir, ['ls-tree', '-r', '--name-only', 'cabecao/index', '--', 'embeddings/']);
    expect(segments.split('\n').filter(Boolean)).toHaveLength(result.rounds);
    expect(await engine.missing(TEST_EMBEDDING, inputs)).toBe(0);
    const again = await engine.compute(TEST_EMBEDDING, inputs);
    expect(again.computed).toBe(0);
    expect(provider.stats.passages).toBe(inputs.length);
    await engine.dispose();
  });

  it('o armazém em memória entra o que este processo calcula e, na busca seguinte, o que outro processo gravou', async () => {
    const dir = await createBrainRepo();
    const inputs = await inputsOf(dir);
    const engine = new EmbeddingEngine({ root: dir, provider: fakeProvider() });
    const half = inputs.slice(0, 10);
    await engine.compute(TEST_EMBEDDING, half);
    const store = await engine.vectors(TEST_EMBEDDING);
    expect(store.size).toBe(10);
    // outro "processo" (outra instância) grava o resto
    const other = new EmbeddingEngine({ root: dir, provider: fakeProvider() });
    await other.compute(TEST_EMBEDDING, inputs);
    expect((await engine.vectors(TEST_EMBEDDING)).size).toBe(inputs.length);
    expect(await engine.vectors(TEST_EMBEDDING)).toBe(store);
    // e o que esta instância calcula entra direto, sem reler a branch
    const extra = [{ key: 'f'.repeat(32), text: 'texto avulso', title: '' }];
    await engine.compute(TEST_EMBEDDING, extra);
    expect(store.has('f'.repeat(32))).toBe(true);
    expect(engine.vectorsInMemory).toBe(inputs.length + 1);
  });

  it('modelo com dimensões diferentes do .cabecao.json é recusado antes de gravar qualquer coisa', async () => {
    const dir = await createBrainRepo();
    const inputs = await inputsOf(dir);
    const base = fakeProvider();
    const engine = new EmbeddingEngine({
      root: dir,
      provider: { ...base, load: (config) => base.load({ ...config, dims: 16 }) },
    });
    await expect(engine.compute(TEST_EMBEDDING, inputs)).rejects.toBeInstanceOf(EmbedderMismatchError);
    expect(await git(dir, ['for-each-ref', 'refs/heads/cabecao/'])).toBe('');
  });

  it('carga que falhou não é tentada de novo a cada busca; o cálculo tenta de novo na hora', async () => {
    const dir = await createBrainRepo();
    const provider = fakeProvider({ failLoad: true });
    const engine = new EmbeddingEngine({ root: dir, provider });
    await expect(engine.embedQuery(TEST_EMBEDDING, 'x')).rejects.toThrow(/não abriu/);
    await expect(engine.embedQuery(TEST_EMBEDDING, 'x')).rejects.toThrow(/não abriu/);
    expect(provider.stats.loads).toBe(1);
    await expect(engine.compute(TEST_EMBEDDING, await inputsOf(dir))).rejects.toThrow(/não abriu/);
    expect(provider.stats.loads).toBe(2);
  });

  it('sem provedor: lê e conta a branch de índice, mas não carrega nada', async () => {
    const dir = await createBrainRepo();
    const inputs = await inputsOf(dir);
    await new EmbeddingEngine({ root: dir, provider: fakeProvider() }).compute(TEST_EMBEDDING, inputs.slice(0, 4));
    const bare = new EmbeddingEngine({ root: dir });
    expect((await bare.available(TEST_EMBEDDING)).ok).toBe(false);
    expect(await bare.missing(TEST_EMBEDDING, inputs)).toBe(inputs.length - 4);
    await expect(bare.embedQuery(TEST_EMBEDDING, 'x')).rejects.toThrow(/não foi carregado/);
    const resolved = resolveFromConfig(TEST_EMBEDDING);
    expect(resolved.modelDir).toBe('multilingual-e5-small-q8-r1');
    const store = await openIndexStore(dir, resolved.modelDir);
    expect((await store.listKeys()).size).toBe(4);
  });
});
