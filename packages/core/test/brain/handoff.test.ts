// `handoff_save` e o handoff no `recall` (marco 4): passagem de bastão com validade, episódio da sessão, o handoff
// anterior substituído e o aviso de handoff já entregue a outra sessão.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError } from '../../src/brain/index.ts';
import { parseCommitTrailers } from '../../src/git/index.ts';
import {
  cleanupAll,
  commitMessageOf,
  createBrainRepo,
  disposeSandbox,
  openTest,
  porcelain,
  readText,
  TEST_TIMEOUT_MS,
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

describe('handoff_save', { timeout: TEST_TIMEOUT_MS }, () => {
  it('grava o handoff e o episódio num commit; o recall entrega o novo e o anterior deixa de valer', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const { session_handle } = await brain.recall({ task: 'migrar consumidores do Atlas', scope: 'project:atlas' });
    const out = await brain.handoffSave({
      session_handle,
      scope: 'project:atlas',
      done: ['Migrei o consumidor de faturamento para leitura em lote.'],
      next: ['Migrar rastreio', 'Migrar auditoria'],
      decisions: ['Lotes de 10 mensagens: acima disso o tempo de visibilidade estoura.'],
      gotchas: ['O consumidor de rastreio usa o banco de réplica.'],
    });
    expect(out.expires_at).toBe('2026-12-12');
    expect(out.handoff.path).toMatch(/^memory\/handoffs\/2026-11-12-passagem-de-bastao-migrar-rastreio\.md$/);
    expect(out.episode?.path).toMatch(/^memory\/episodes\/2026\/11\/2026-11-12-sessao-/);
    expect(out.supersedes?.path).toBe('memory/handoffs/2026-11-10-atlas-consumidores.md');

    const handoff = await readText(dir, out.handoff.path);
    expect(handoff).toContain('type: handoff');
    expect(handoff).toContain('expires_at: 2026-12-12');
    expect(handoff).toContain('supersedes: ["[[2026-11-10-atlas-consumidores]]"]');
    expect(handoff).toContain(`session: ${session_handle}`);
    const episodeStem = String(out.episode?.path).split('/').at(-1)?.replace(/\.md$/, '');
    expect(handoff).toContain(`sources: ["[[${episodeStem}]]"]`);
    expect(handoff).toContain('## Próximo passo\n\n- Migrar rastreio\n- Migrar auditoria\n');
    const episode = await readText(dir, String(out.episode?.path));
    expect(episode).toContain('type: episode');
    expect(episode).not.toContain('expires_at');
    expect(episode).toContain('## Decisões');

    const message = await commitMessageOf(dir);
    expect(message.split('\n\n')[1]?.split('\n')).toEqual([
      expect.stringMatching(/^add episode: Sessão: /),
      expect.stringMatching(/^add handoff: Passagem de bastão: Migrar rastreio$/),
    ]);
    expect(parseCommitTrailers(message).session).toBe(session_handle);
    expect(await porcelain(dir)).toBe('');

    const recall = await brain.recall({ task: 'continuar a migração', scope: 'project:atlas' });
    expect(recall.handoff?.path).toBe(out.handoff.path);
    expect(recall.handoff_seen).toBeNull();
    const old = await brain.read({ path: 'memory/handoffs/2026-11-10-atlas-consumidores.md' });
    expect(old.note.validity).toBe('expired');

    // undo desfaz o handoff e o episódio juntos
    await brain.undo({ op: out.op });
    const after = await brain.recall({ task: 'continuar', scope: 'project:atlas' });
    expect(after.handoff?.path).toBe('memory/handoffs/2026-11-10-atlas-consumidores.md');
  });

  it('sem "done" não há episódio; sem "done" nem "next" é recusado; session_handle é obrigatório', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const { session_handle } = await brain.recall({ task: 'x' });
    const out = await brain.handoffSave({ session_handle, next: ['Revisar a decisão do SQS'] });
    expect(out.episode).toBeNull();
    expect(out.supersedes).toBeNull(); // o handoff do exemplo é do projeto atlas, não global
    expect((await errorOf(brain.handoffSave({ session_handle, done: [], next: ['  '] }))).code).toBe(
      'invalid_argument',
    );
    expect(
      (await errorOf(brain.handoffSave({ next: ['x'] } as unknown as Parameters<typeof brain.handoffSave>[0]))).code,
    ).toBe('invalid_argument');
    expect((await errorOf(brain.handoffSave({ session_handle: 'abc', next: ['x'] }))).code).toBe('invalid_argument');
  });

  it('recall avisa quando o handoff já foi entregue a outra sessão e ninguém gravou um novo', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const first = await brain.recall({ task: 'atlas', scope: 'project:atlas' });
    expect(first.handoff?.path).toBe('memory/handoffs/2026-11-10-atlas-consumidores.md');
    expect(first.handoff_seen).toBeNull();
    const second = await brain.recall({ task: 'atlas', scope: 'project:atlas' });
    expect(second.handoff_seen).toEqual({ at: expect.stringMatching(/^2026-11-12T/), session: first.session_handle });
    expect(second.next_step).toMatch(/já tinha sido entregue a outra sessão/);
    // o estado é local: fica em .cabecao/, que não vai para o git
    expect(await porcelain(dir)).toBe('');
  });
});
