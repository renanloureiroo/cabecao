// `forget` pelo protocolo (marco 4; ADR 24; spike 10, P4): confirmação em duas chamadas em qualquer cliente; com
// elicitação declarada, o servidor pergunta ao usuário (MRTR na geração 2026, `elicitation/create` na 2025); `cancel`
// é "ninguém respondeu" e cai no token; `decline` não arquiva.
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
const NOTE = 'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md';
const ARCHIVED = 'memory/_archive/testes-de-integracao-sem-limpar-o-banco.md';
const ELICITS = { elicitation: { form: {} } };

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

describe.each(GENERATIONS)('geração %s', (generation) => {
  it(
    'sem elicitação: resumo e token na primeira chamada, arquiva na segunda',
    async () => {
      const dir = await createBrainRepo();
      const server = startInMemory(dir, { generation });
      await server.client.open();
      const first = toolOutput<{ status: string; confirm_token: string; next_step: string }>(
        await server.client.call('forget', { id: NOTE, reason: 'resolvido' }),
      );
      expect(first.status).toBe('confirmation_required');
      expect(existsSync(join(dir, ...NOTE.split('/')))).toBe(true);
      const done = toolOutput<{ status: string; confirmed_by: string; archived_path: string }>(
        await server.client.call('forget', { id: NOTE, reason: 'resolvido', confirm_token: first.confirm_token }),
      );
      expect(done).toMatchObject({ status: 'archived', confirmed_by: 'token', archived_path: ARCHIVED });
      // um campo a mais na entrada (tentar se passar por "confirmado pelo usuário") não muda nada
      const sneaky = toolOutput<{ status: string }>(
        await server.client.call('forget', {
          id: 'memory/preferences/respostas-em-portugues.md',
          reason: 'x',
          userConfirmed: true,
        }),
      );
      expect(sneaky.status).toBe('confirmation_required');
      await server.stop();
    },
    TEST_TIMEOUT_MS,
  );

  for (const [answer, expected] of [
    [{ action: 'accept', content: { confirm: true } }, 'archived'],
    [{ action: 'decline' }, 'declined'],
    [{ action: 'accept', content: { confirm: false } }, 'declined'],
    [{ action: 'cancel' }, 'confirmation_required'],
  ] as [Answer, string][]) {
    it(
      `com elicitação, resposta ${answer.action}${answer.content === undefined ? '' : ` (${JSON.stringify(answer.content)})`}: ${expected}`,
      async () => {
        const dir = await createBrainRepo();
        const asked: unknown[] = [];
        const server = startInMemory(dir, {
          generation,
          capabilities: ELICITS,
          onServerRequest: (method, params) => {
            asked.push({ method, params });
            return answer;
          },
        });
        await server.client.open();
        let response = await server.client.request('tools/call', {
          name: 'forget',
          arguments: { id: NOTE, reason: 'resolvido' },
        });
        if (generation === 'modern') {
          // MRTR: o servidor devolve o pedido de confirmação; o cliente pergunta e repete a chamada com a resposta
          const result = response.result as { resultType?: string; inputRequests?: Record<string, { method: string }> };
          expect(result.resultType).toBe('input_required');
          expect(result.inputRequests?.confirm?.method).toBe('elicitation/create');
          expect(JSON.stringify(result.inputRequests)).toContain(NOTE);
          response = await server.client.request('tools/call', {
            name: 'forget',
            arguments: { id: NOTE, reason: 'resolvido' },
            inputResponses: { confirm: answer },
          });
        } else {
          expect(asked).toHaveLength(1);
          expect(JSON.stringify(asked[0])).toContain('elicitation/create');
        }
        const output = toolOutput<{ status: string; confirmed_by: string | null; confirm_token: string | null }>(
          response.result as never,
        );
        expect(output.status).toBe(expected);
        expect(existsSync(join(dir, ...NOTE.split('/')))).toBe(expected !== 'archived');
        if (expected === 'archived') expect(output.confirmed_by).toBe('user');
        if (expected === 'confirmation_required') expect(output.confirm_token).toMatch(/^cbc_ct_/);
        await server.stop();
      },
      TEST_TIMEOUT_MS,
    );
  }
});
