// Decisão 37 pelo protocolo: uma ação elevada (aqui, criar uma regra com write_page) devolve `confirmation_required`
// com o token num cliente sem elicitação; num cliente com elicitação, o servidor pergunta direto ao usuário, como no
// `forget`: aceitar grava (confirmada pelo usuário), recusar não grava, cancelar cai no fluxo do token.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Generation } from './helpers.ts';
import { createBrainRepo, disposeSandbox, startInMemory, stopAll, TEST_TIMEOUT_MS, toolOutput } from './helpers.ts';

afterAll(async () => {
  await stopAll();
  disposeSandbox();
});

const GENERATIONS: readonly Generation[] = ['legacy', 'modern'];
const RULE = 'memory/rules/sempre-em-portugues.md';
const ARGS = {
  path: RULE,
  mode: 'create',
  frontmatter: { type: 'rule', title: 'Sempre em português' },
  content: 'Responda em português.',
};
const ELICITS = { elicitation: { form: {} } };

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

describe.each(GENERATIONS)('geração %s', (generation) => {
  it(
    'sem elicitação: resumo e token na primeira chamada, grava na segunda com a marca de aprovação',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation, clientName: 'claude-code' });
      await server.client.open();
      const first = toolOutput<{ status: string; confirm_token: string; summary: string }>(
        await server.client.call('write_page', ARGS),
      );
      expect(first.status).toBe('confirmation_required');
      expect(first.summary).toContain(RULE);
      expect(existsSync(join(dir, ...RULE.split('/')))).toBe(false);
      // um campo a mais na entrada (tentar se passar por "confirmado pelo usuário") é recusado pelo esquema ou ignorado
      await server.client.call('write_page', { ...ARGS, userConfirmed: true });
      expect(existsSync(join(dir, ...RULE.split('/')))).toBe(false);
      const done = toolOutput<{ changed: boolean; confirmed_by: string }>(
        await server.client.call('write_page', { ...ARGS, confirm_token: first.confirm_token }),
      );
      expect(done).toMatchObject({ changed: true, confirmed_by: 'token' });
      const read = toolOutput<{ frontmatter: Record<string, unknown> }>(
        await server.client.call('read', { path: RULE }),
      );
      expect(read.frontmatter).toMatchObject({ origin: 'agent:claude-code', approved_by: 'user' });
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  for (const [answer, expected] of [
    [{ action: 'accept', content: { confirm: true } }, 'written'],
    [{ action: 'decline' }, 'declined'],
    [{ action: 'cancel' }, 'confirmation_required'],
  ] as [Answer, string][]) {
    it(
      `com elicitação, resposta ${answer.action}: ${expected}`,
      async () => {
        const dir = await createBrainRepo();
        const server = startInMemory(dir, {
          generation,
          capabilities: ELICITS,
          onServerRequest: () => answer,
        });
        await server.client.open();
        let response = await server.client.request('tools/call', { name: 'write_page', arguments: ARGS });
        if (generation === 'modern') {
          const result = response.result as { resultType?: string; inputRequests?: Record<string, unknown> };
          expect(result.resultType).toBe('input_required');
          expect(JSON.stringify(result.inputRequests)).toContain(RULE);
          response = await server.client.request('tools/call', {
            name: 'write_page',
            arguments: ARGS,
            inputResponses: { confirm: answer },
          });
        }
        const output = toolOutput<{ status?: string; confirmed_by?: string; changed: boolean }>(
          response.result as never,
        );
        expect(existsSync(join(dir, ...RULE.split('/')))).toBe(expected === 'written');
        if (expected === 'written') expect(output).toMatchObject({ changed: true, confirmed_by: 'user' });
        else expect(output.status).toBe(expected);
        await server.stop();
      },
      TEST_TIMEOUT_MS,
    );
  }
});
