// A tool `ask`: só aparece em `tools/list` quando a CLI injeta um `AskRunner` (provedor ativo na máquina); esquemas de
// entrada e saída válidos; a saída é a mesma para qualquer provedor e não diz qual gerou; falha de provedor não vira
// erro MCP (volta `unavailable` com os trechos); entrada inválida, sim.
import type { AskInput, Brain, GenerateRequest, GenerationProvider } from '@cabecao/core';
import { ask, createFakeProvider, parseSentPassages } from '@cabecao/core';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterAll, describe, expect, it } from 'vitest';
import type { AskRunner } from '../src/index.ts';
import { ASK_TOOL_NAME, SERVER_INSTRUCTIONS, TOOL_NAMES } from '../src/index.ts';
import type { Generation } from './helpers.ts';
import { createBrainRepo, disposeSandbox, startInMemory, stopAll, TEST_TIMEOUT_MS, toolOutput } from './helpers.ts';

afterAll(async () => {
  await stopAll();
  disposeSandbox();
});

const QUOTE = 'O Projeto Atlas migrou de RabbitMQ para SQS em maio de 2026 por custo operacional.';

function runner(providers: GenerationProvider[]): AskRunner {
  return async (brain: Brain, input: AskInput, signal?: AbortSignal) =>
    (await ask(brain, input, { providers, ...(signal === undefined ? {} : { signal }) })).output;
}

const secretProvider = (extra: object = {}) =>
  createFakeProvider({
    id: 'provedor-que-o-agente-nao-ve',
    model: 'modelo-que-o-agente-nao-ve',
    responder: (request: GenerateRequest) => {
      const label = parseSentPassages(request.user).find((p) => p.text.includes(QUOTE))?.label;
      return {
        status: 'answered',
        claims: [{ text: 'O Atlas usa SQS.', sources: [label], quote: QUOTE }],
        missing: '',
      };
    },
    ...extra,
  });

describe('tool ask', { timeout: TEST_TIMEOUT_MS }, () => {
  for (const generation of ['legacy', 'modern'] as Generation[]) {
    it(`sem provedor ativo, não é anunciada (${generation})`, async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation, clientName: 'Claude Code' });
      await server.client.open();
      const tools = ((await server.client.request('tools/list')).result?.tools ?? []) as { name: string }[];
      expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      expect(tools.some((tool) => tool.name === ASK_TOOL_NAME)).toBe(false);
      await server.stop();
    });

    it(`com provedor, é anunciada depois de search, responde no esquema e não diz o provedor (${generation})`, async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation, clientName: 'Claude Code', ask: runner([secretProvider()]) });
      const opened = await server.client.open();
      const listed = (await server.client.request('tools/list')).result?.tools as {
        name: string;
        inputSchema: { properties: Record<string, unknown>; required?: string[] };
        outputSchema: JsonSchemaType;
        annotations?: Record<string, unknown>;
      }[];
      const names = listed.map((tool) => tool.name);
      expect(names.slice(0, 3)).toEqual(['recall', 'search', 'ask']);
      expect(names.filter((name) => name !== 'ask')).toEqual([...TOOL_NAMES]);
      const tool = listed.find((t) => t.name === 'ask');
      // só opções de recuperação: nada de provedor ou modelo
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
        'as_of',
        'limit',
        'question',
        'scope',
        'types',
      ]);
      expect(tool?.inputSchema.required).toEqual(['question']);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(JSON.stringify(opened)).toContain('`ask`');
      expect(SERVER_INSTRUCTIONS).not.toContain('`ask`');

      const result = await server.client.call('ask', { question: 'Atlas migrou para SQS?' });
      const output = toolOutput<Record<string, unknown>>(result);
      const verdict = new AjvJsonSchemaValidator().getValidator(tool?.outputSchema as JsonSchemaType)(output);
      expect(verdict.errorMessage).toBeUndefined();
      expect(output.status).toBe('answered');
      expect(output.next_step).toEqual(expect.any(String));
      const wire = JSON.stringify(result);
      expect(wire).not.toContain('provedor-que-o-agente-nao-ve');
      expect(wire).not.toContain('modelo-que-o-agente-nao-ve');
      await server.stop();
    });
  }

  it('falha do provedor não é erro MCP: unavailable com passages; entrada inválida é erro', async () => {
    const dir = await createBrainRepo();
    const server = startInMemory(dir, {
      generation: 'legacy',
      clientName: 'Claude Code',
      ask: runner([secretProvider({ failures: ['network'] })]),
    });
    await server.client.open();
    const result = await server.client.call('ask', { question: 'Atlas migrou para SQS?' });
    expect(result.isError).not.toBe(true);
    const output = toolOutput<{ status: string; unavailable_reason: string; passages: unknown[] }>(result);
    expect(output.status).toBe('unavailable');
    expect(output.unavailable_reason).toBe('provider_failed');
    expect(output.passages.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('provedor-que-o-agente-nao-ve');

    expect((await server.client.call('ask', { question: 'x', limit: 50 })).isError).toBe(true);
    expect((await server.client.call('ask', { question: 'x', types: ['nao-existe'] })).isError).toBe(true);
    await server.stop();
  });
});
