// O servidor MCP com a busca por significado (marco 2): `search` com `mode` e o modo usado na saída, `status` com o
// estado dos embeddings, esquemas válidos, e a subida sem efeito colateral: o modelo carrega na PRIMEIRA busca que
// precisa dele, nunca na inicialização nem em `tools/list`.
import type { EmbeddingProvider } from '@cabecao/core';
import { openBrain, resolveFromConfig } from '@cabecao/core';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterAll, describe, expect, it } from 'vitest';
import { createFakeEmbedder } from '../../embeddings/src/fake.ts';
import { TOOL_NAMES } from '../src/index.ts';
import {
  createBrainRepo,
  disposeSandbox,
  startInMemory,
  stopAll,
  TEST_TIMEOUT_MS,
  toolError,
  toolOutput,
} from './helpers.ts';

afterAll(async () => {
  await stopAll();
  disposeSandbox();
});

const EMBEDDING = { model: 'multilingual-e5-small', variant: 'q8', dims: 384, recipe: 1 };

function provider(): EmbeddingProvider & { loads: number } {
  const p = {
    loads: 0,
    resolve: resolveFromConfig,
    available: async () => ({ ok: true as const, backend: 'fake', modelCached: true }),
    load: async (config: { dims: number }) => {
      p.loads++;
      return createFakeEmbedder(config.dims);
    },
  };
  return p;
}

describe('servidor MCP e embeddings', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sobe sem carregar o modelo; a primeira busca carrega; saída válida pelo esquema anunciado', async () => {
    const dir = await createBrainRepo();
    const setup = await openBrain(dir, { client: 'cli', actor: 'human', embeddings: provider(), machine: 'm' });
    await setup.setEmbedding(EMBEDDING);
    await setup.computeEmbeddings();
    await setup.close();

    const runtime = provider();
    const server = startInMemory(dir, { generation: 'legacy', clientName: 'Claude Code', embeddings: runtime });
    await server.client.open();
    const listed = await server.client.request('tools/list');
    const tools = (listed.result?.tools ?? []) as {
      name: string;
      inputSchema: { properties: Record<string, { enum?: string[] }> };
      outputSchema: JsonSchemaType;
    }[];
    // nenhuma tool nova: embeddings, compactação e troca de modelo são só da CLI
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    const search = tools.find((tool) => tool.name === 'search');
    expect(search?.inputSchema.properties.mode?.enum).toEqual(['auto', 'keyword', 'semantic', 'hybrid']);
    const ajv = new AjvJsonSchemaValidator();
    const validate = (name: string, output: unknown) => {
      const schema = tools.find((tool) => tool.name === name)?.outputSchema;
      const verdict = ajv.getValidator(schema as JsonSchemaType)(output);
      expect(verdict.errorMessage, name).toBeUndefined();
      expect(verdict.valid).toBe(true);
    };

    const before = toolOutput(await server.client.call('status'));
    validate('status', before);
    expect(runtime.loads).toBe(0);
    expect(before.embeddings).toMatchObject({ configured: true, loaded: false, pending: 0, runtime: 'ready' });

    const keyword = toolOutput(await server.client.call('search', { query: 'filas', mode: 'keyword' }));
    validate('search', keyword);
    expect(keyword.mode_used).toBe('keyword');
    expect(runtime.loads).toBe(0);

    const hybrid = toolOutput(await server.client.call('search', { query: 'filas' }));
    validate('search', hybrid);
    expect(hybrid).toMatchObject({ mode_requested: 'auto', mode_used: 'hybrid', warnings: [] });
    expect(runtime.loads).toBe(1);
    toolOutput(await server.client.call('search', { query: 'decisão do Atlas', mode: 'semantic' }));
    expect(runtime.loads).toBe(1);

    const after = toolOutput(await server.client.call('status'));
    validate('status', after);
    expect(after.embeddings).toMatchObject({ loaded: true, backend: 'fake' });

    const invalid = await server.client.call('search', { query: 'filas', mode: 'vector' });
    expect(invalid.isError).toBe(true);
    await server.stop();
  });

  it('sem runtime injetado, a busca é por palavra-chave e diz por quê', async () => {
    const dir = await createBrainRepo();
    const setup = await openBrain(dir, { client: 'cli', actor: 'human', embeddings: provider(), machine: 'm' });
    await setup.setEmbedding(EMBEDDING);
    await setup.close();
    const server = startInMemory(dir, { generation: 'modern', clientName: 'codex-mcp-client' });
    await server.client.open();
    const searched = toolOutput(await server.client.call('search', { query: 'filas', mode: 'hybrid' }));
    expect(searched.mode_used).toBe('keyword');
    expect(String((searched.warnings as string[])[0])).toMatch(/não foi carregado/);
    const status = toolOutput(await server.client.call('status'));
    expect(status.embeddings).toMatchObject({ configured: true, runtime: 'not_injected' });
    // e nenhuma tool muda o modelo: o .cabecao.json só se altera com confirmação, e a seção embedding nunca
    const refused = await server.client.call('write_page', {
      path: '.cabecao.json',
      mode: 'overwrite',
      content: JSON.stringify({ schemaVersion: 1, noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' }),
    });
    expect(toolError(refused).code).toBe('invalid_argument');
    expect(toolError(refused).message).toMatch(/embedding/);
    await server.stop();
  });
});
