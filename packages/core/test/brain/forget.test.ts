// `forget` (marco 4): arquiva em memory/_archive/ com confirmação em duas chamadas; nunca apaga.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError, CONFIRM_TOKEN_TTL_MS } from '../../src/brain/index.ts';
import { scanSecrets } from '../../src/security/index.ts';
import {
  cleanupAll,
  commitCount,
  commitMessageOf,
  createBrainRepo,
  disposeSandbox,
  openTest,
  porcelain,
  readText,
  TEST_TIMEOUT_MS,
  TODAY,
} from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

async function errorOf(promise: Promise<unknown>): Promise<BrainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('a operação deveria ter falhado');
}

const GOTCHA_ID = 'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md';

describe('forget', { timeout: TEST_TIMEOUT_MS }, () => {
  it('primeira chamada: resumo e token, nada muda; segunda: arquiva num commit e o undo traz de volta', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const { session_handle } = await agent.recall({ task: 'limpar' });
    const commits = await commitCount(dir);
    const first = await agent.forget({ id: GOTCHA_ID, reason: 'resolvido no CI', session_handle });
    expect(first.status).toBe('confirmation_required');
    expect(first.summary).toContain('memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md');
    expect(first.summary).toContain('resolvido no CI');
    expect(first.confirm_token).toMatch(/^cbc_ct_[0-9a-z]+_[A-Za-z0-9_-]{43}$/);
    expect(first.next_step).toMatch(/confirm_token/);
    expect(await commitCount(dir)).toBe(commits);

    const done = await agent.forget({
      id: first.note.id,
      reason: 'resolvido no CI',
      session_handle,
      confirm_token: String(first.confirm_token),
    });
    expect(done).toMatchObject({ status: 'archived', confirmed_by: 'token' });
    expect(done.archived_path).toBe('memory/_archive/testes-de-integracao-sem-limpar-o-banco.md');
    const archived = await readText(dir, String(done.archived_path));
    expect(archived).toContain('forget_reason: resolvido no CI');
    expect(archived).toContain('valid_until: 2026-11-12');
    expect((await commitMessageOf(dir)).split('\n')[2]).toMatch(/^archive gotcha: /);
    expect(await porcelain(dir)).toBe('');
    const search = await agent.search({ query: 'limpar o banco' });
    expect(search.hits.map((hit) => hit.path)).not.toContain(GOTCHA_ID);

    await agent.undo({ op: String(done.op) });
    expect(await readText(dir, GOTCHA_ID)).not.toContain('forget_reason');
  });

  it('o token é amarrado à nota, ao conteúdo, à sessão e à hora', async () => {
    const dir = await createBrainRepo();
    let now = TODAY;
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code', now: () => now });
    const s1 = (await agent.recall({ task: 'a' })).session_handle;
    const s2 = (await agent.recall({ task: 'b' })).session_handle;
    const first = await agent.forget({ id: GOTCHA_ID, reason: 'x', session_handle: s1 });
    const token = String(first.confirm_token);
    const codeOf = async (input: Parameters<typeof agent.forget>[0]) => (await errorOf(agent.forget(input))).code;

    // outra nota
    expect(
      await codeOf({
        id: 'memory/preferences/respostas-em-portugues.md',
        reason: 'x',
        session_handle: s1,
        confirm_token: token,
      }),
    ).toBe('invalid_argument');
    // outra sessão, sem sessão
    expect(await codeOf({ id: GOTCHA_ID, reason: 'x', session_handle: s2, confirm_token: token })).toBe(
      'invalid_argument',
    );
    expect(await codeOf({ id: GOTCHA_ID, reason: 'x', confirm_token: token })).toBe('invalid_argument');
    // adulterado
    const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(await codeOf({ id: GOTCHA_ID, reason: 'x', session_handle: s1, confirm_token: forged })).toBe(
      'invalid_argument',
    );
    expect(await codeOf({ id: GOTCHA_ID, reason: 'x', session_handle: s1, confirm_token: 'cbc_ct_zz_curto' })).toBe(
      'invalid_argument',
    );
    // validade estendida à mão (a hora entra na assinatura)
    const [, exp = '', sig = ''] = /^cbc_ct_([0-9a-z]+)_(.+)$/.exec(token) ?? [];
    const later = `cbc_ct_${(Number.parseInt(exp, 36) + 3600).toString(36)}_${sig}`;
    expect(await codeOf({ id: GOTCHA_ID, reason: 'x', session_handle: s1, confirm_token: later })).toBe(
      'invalid_argument',
    );
    // a nota mudou depois do resumo
    await writeFile(join(dir, ...GOTCHA_ID.split('/')), `${await readText(dir, GOTCHA_ID)}\nLinha nova do Obsidian.\n`);
    expect(await codeOf({ id: GOTCHA_ID, reason: 'x', session_handle: s1, confirm_token: token })).toBe(
      'invalid_argument',
    );
    // vencido
    const fresh = await agent.forget({ id: GOTCHA_ID, reason: 'x', session_handle: s1 });
    now = new Date(TODAY.getTime() + CONFIRM_TOKEN_TTL_MS + 60_000);
    const expired = await errorOf(
      agent.forget({ id: GOTCHA_ID, reason: 'x', session_handle: s1, confirm_token: String(fresh.confirm_token) }),
    );
    expect(expired.message).toMatch(/venceu/);
    expect(await porcelain(dir)).toBe(' M memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md');
  });

  it('o token nunca é gravado numa nota: o scanner o reconhece', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const first = await agent.forget({ id: GOTCHA_ID, reason: 'x' });
    const token = String(first.confirm_token);
    expect(scanSecrets(`confirm_token: ${token}`)[0]?.rule).toBe('cabecao-confirm-token');
    const { session_handle } = await agent.recall({ task: 'x' });
    expect(
      (await errorOf(agent.remember({ type: 'gotcha', title: 'Token', content: `Use ${token} para confirmar.` }))).code,
    ).toBe('secret_detected');
    expect(
      (await errorOf(agent.handoffSave({ session_handle, next: [`forget com confirm_token ${token}`] }))).code,
    ).toBe('secret_detected');
  });

  it('já arquivada, inexistente ou sem motivo: erro claro', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    expect((await errorOf(agent.forget({ id: 'memory/_archive/preferencia-usar-tabs.md', reason: 'x' }))).code).toBe(
      'invalid_argument',
    );
    expect((await errorOf(agent.forget({ id: '01KZZZZZZZZZZZZZZZZZZZZZZZ', reason: 'x' }))).code).toBe('not_found');
    expect((await errorOf(agent.forget({ id: GOTCHA_ID, reason: '  ' }))).code).toBe('invalid_argument');
  });

  it('o usuário (CLI) também confirma, e arquiva regra', async () => {
    const dir = await createBrainRepo();
    const human = await openTest(dir, { actor: 'human', client: 'cli' });
    const first = await human.forget({ id: 'memory/rules/nunca-commitar-segredos.md', reason: 'trocada' });
    expect(first.status).toBe('confirmation_required');
    const done = await human.forget(
      { id: 'memory/rules/nunca-commitar-segredos.md', reason: 'trocada' },
      { userConfirmed: true },
    );
    expect(done).toMatchObject({ status: 'archived', confirmed_by: 'user' });
  });
});
