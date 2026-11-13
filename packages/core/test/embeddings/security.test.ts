// Revisão adversária do marco 2 (ADR 36): nada do que um agente controla alcança a branch de índice, o runtime, o
// `npm install` ou a configuração de embeddings. As operações de embeddings recusam um agente mesmo chamadas direto
// (nenhuma tool as expõe), o `.cabecao.json` continua recusado para escrita de agente, e os parâmetros novos da busca
// são validados.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readBrainConfig } from '../../src/vault/index.ts';
import { cleanupAll, createBrainRepo, disposeSandbox, git, TEST_TIMEOUT_MS } from '../brain/helpers.ts';
import { fakeProvider, openAgent, openHuman, TEST_EMBEDDING } from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

describe('agente e embeddings', { timeout: TEST_TIMEOUT_MS }, () => {
  it('as operações que gravam no .cabecao.json ou na branch de índice recusam agente (human_only)', async () => {
    const dir = await createBrainRepo();
    const provider = fakeProvider();
    const agent = await openAgent(dir, provider);
    await expect(agent.setEmbedding(TEST_EMBEDDING)).rejects.toMatchObject({ code: 'human_only' });
    await expect(agent.setEmbedding(null)).rejects.toMatchObject({ code: 'human_only' });
    await expect(agent.computeEmbeddings()).rejects.toMatchObject({ code: 'human_only' });
    await expect(agent.switchEmbeddings(TEST_EMBEDDING)).rejects.toMatchObject({ code: 'human_only' });
    await expect(agent.compactIndex()).rejects.toMatchObject({ code: 'human_only' });
    expect((await readBrainConfig(dir)).embedding).toBeUndefined();
    expect(await git(dir, ['for-each-ref', 'refs/heads/cabecao/'])).toBe('');
    expect(provider.stats.loads).toBe(0);
  });

  it('o agente não muda o embedding pelo write_page/patch_page (o .cabecao.json é arquivo de controle)', async () => {
    const dir = await createBrainRepo();
    const human = await openHuman(dir, fakeProvider());
    await human.setEmbedding(TEST_EMBEDDING);
    const agent = await openAgent(dir, fakeProvider());
    const evil = JSON.stringify({
      schemaVersion: 1,
      noteDirs: ['wiki'],
      indexMd: 'index.md',
      embedding: { model: 'x', variant: 'y', dims: 8, recipe: 1 },
    });
    await expect(
      agent.writePage({ path: '.cabecao.json', mode: 'overwrite', frontmatter: {}, content: evil }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid_path|unsafe_path|invalid_argument/) });
    await expect(
      agent.patchPage({ path: '.cabecao.json', old: 'multilingual-e5-small', new: 'outro-modelo' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid_path|unsafe_path|invalid_argument/) });
    expect((await readBrainConfig(dir)).embedding).toMatchObject(TEST_EMBEDDING);
  });

  it('nenhum caminho de nota alcança a branch de índice', async () => {
    const dir = await createBrainRepo();
    const agent = await openAgent(dir, fakeProvider());
    for (const path of [
      'cabecao/index/manifest.json',
      'refs/heads/cabecao/index.md',
      '.git/refs/heads/cabecao/index',
      '.cabecao/index/embeddings/x.md',
      '.cabecao/embeddings.json',
    ]) {
      await expect(
        agent.writePage({ path, mode: 'create', frontmatter: { type: 'concept', title: 'x' }, content: 'x' }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/invalid_path|unsafe_path/) });
    }
    expect(await git(dir, ['for-each-ref', 'refs/heads/cabecao/'])).toBe('');
  });

  it('a busca valida mode e não deixa o agente carregar outro modelo nem tocar no runtime', async () => {
    const dir = await createBrainRepo();
    const human = await openHuman(dir, fakeProvider());
    await human.setEmbedding(TEST_EMBEDDING);
    await human.computeEmbeddings();
    const provider = fakeProvider();
    const agent = await openAgent(dir, provider);
    for (const mode of ['vector', 'HYBRID', '', 'semantic; rm -rf /', 1, {}]) {
      await expect(agent.search({ query: 'filas', mode: mode as never })).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    }
    // a pergunta é só texto embutido pelo modelo do cérebro; nenhum campo da busca escolhe modelo ou runtime
    const found = await agent.search({ query: 'filas', mode: 'hybrid' });
    expect(found.mode_used).toBe('hybrid');
    expect(provider.stats.loads).toBe(1);
    expect(provider.stats.passages).toBe(0);
    // o agente lê o estado (status), mas não grava nada por ele
    const status = await agent.status();
    expect(status.embeddings?.model).toBe(TEST_EMBEDDING.model);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
  });
});
