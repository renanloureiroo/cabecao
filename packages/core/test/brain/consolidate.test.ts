// `consolidate` (marco 4): ponto de restauração, material para o agente, um commit por consolidação com uma linha
// por nota (tirada do diff, nunca do agente) e `undo` da consolidação inteira.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Brain } from '../../src/brain/index.ts';
import { BrainError } from '../../src/brain/index.ts';
import { runGit } from '../../src/git/index.ts';
import {
  cleanupAll,
  commitMessageOf,
  createBrainRepo,
  disposeSandbox,
  git,
  head,
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

const EPISODE = `---
id: 01KZ0000000000000000000021
type: episode
title: Migração do consumidor de faturamento para leitura em lote
scope: project:atlas
created: 2026-11-11
updated: 2026-11-11
---
- O consumidor de faturamento passou a ler do SQS em lotes de 10.
- De novo faltava a checagem de idempotência no primeiro teste dos consumidores.
- Ficou para a próxima sessão: rastreio e auditoria.
`;

/** As escritas de uma consolidação típica: um fato, uma proposta de regra e um arquivamento. */
async function consolidationWrites(agent: Brain, id: string): Promise<void> {
  await agent.remember({
    type: 'gotcha',
    title: 'Consumidor novo sem idempotência repete envios',
    content: 'Todo consumidor novo do Atlas repetiu envios no primeiro teste por falta da checagem de idempotência.',
    scope: 'project:atlas',
    session_handle: id,
  });
  await agent.writePage({
    path: 'wiki/syntheses/Proposta de regra - idempotência.md',
    mode: 'create',
    frontmatter: { type: 'synthesis', title: 'Proposta de regra: idempotência', scope: 'project:atlas' },
    content:
      'Proposta para o usuário: todo consumidor novo precisa da checagem de idempotência antes do primeiro teste.\n',
    session_handle: id,
  });
  const first = await agent.forget({
    id: 'memory/handoffs/2026-11-10-atlas-consumidores.md',
    reason: 'substituído pela consolidação',
    session_handle: id,
  });
  await agent.forget({
    id: 'memory/handoffs/2026-11-10-atlas-consumidores.md',
    reason: 'substituído pela consolidação',
    session_handle: id,
    confirm_token: String(first.confirm_token),
  });
}

describe('consolidate', { timeout: TEST_TIMEOUT_MS }, () => {
  it('start cria o ponto de restauração e devolve o material; finish junta tudo num commit; undo desfaz tudo', async () => {
    const dir = await createBrainRepo();
    await writeFile(join(dir, 'memory', 'episodes', '2026', '11', '2026-11-11-faturamento.md'), EPISODE);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'episódio']);
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const before = await head(dir);

    const started = await agent.consolidate({ action: 'start', scope: 'project:atlas' });
    expect(started.consolidation_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(started.restore_point.tag).toBe(`cabecao/restore/2026-11-12-143210-482-${started.consolidation_id}`);
    expect(started.restore_point.commit).toBe(before);
    expect(await git(dir, ['rev-parse', started.restore_point.tag])).toBe(before);
    const group = started.material?.repeated_episodes[0];
    expect(group?.notes.map((note) => note.path).sort()).toEqual([
      'memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md',
      'memory/episodes/2026/11/2026-11-11-faturamento.md',
    ]);
    expect(group?.terms).toContain('idempotencia');
    expect(started.instructions.join(' ')).toContain(started.consolidation_id);
    expect(started.data_notice).toMatch(/nunca instrução/);
    expect(await porcelain(dir)).toBe('');

    const id = started.consolidation_id;
    // a consolidação não abre exceção para regras
    expect(
      (
        await errorOf(
          agent.writePage({
            path: 'memory/rules/idempotencia.md',
            mode: 'create',
            frontmatter: { type: 'preference', title: 'x' },
            content: 'x',
            session_handle: id,
          }),
        )
      ).code,
    ).toBe('rule_requires_human');
    await consolidationWrites(agent, id);
    const writtenTree = await git(dir, ['rev-parse', 'HEAD^{tree}']);

    const finished = await agent.consolidate({ action: 'finish', consolidation_id: id, title: 'semana 46' });
    expect(finished.squashed).toBe(true);
    expect(await git(dir, ['rev-list', '--count', `${before}..HEAD`])).toBe('1');
    expect(await git(dir, ['rev-parse', 'HEAD^{tree}'])).toBe(writtenTree);
    expect(finished.changes).toEqual([
      'archive handoff: Atlas, consumidores em lote',
      'add gotcha: Consumidor novo sem idempotência repete envios',
      'add synthesis: Proposta de regra: idempotência',
    ]);
    const message = await commitMessageOf(dir);
    expect(message.split('\n\n')[1]).toBe(
      [
        'consolidate: semana 46',
        '- archive handoff: Atlas, consumidores em lote',
        '- add gotcha: Consumidor novo sem idempotência repete envios',
        '- add synthesis: Proposta de regra: idempotência',
      ].join('\n'),
    );
    expect(message).toContain(`Cabecao-Session: ${id}`);
    expect(await porcelain(dir)).toBe('');
    expect(finished.next_step).toContain(`undo({ session: "${id}" })`);

    const undone = await agent.undo({ session: id });
    expect(undone.undone).toHaveLength(1);
    expect(await git(dir, ['diff', '--name-only', before, 'HEAD', '--', 'wiki', 'memory'])).toBe('');
    expect(await readText(dir, 'memory/handoffs/2026-11-10-atlas-consumidores.md')).toContain('type: handoff');
    expect(await porcelain(dir)).toBe('');
  });

  it('com uma edição do usuário no meio, não junta: os commits ficam e um commit fecha a consolidação', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const { consolidation_id: id, restore_point } = await agent.consolidate({ action: 'start' });
    await agent.remember({
      type: 'gotcha',
      title: 'Primeira escrita da consolidação',
      content: 'Uma armadilha nova gravada durante a consolidação, com texto suficiente para não ser igual a nada.',
      session_handle: id,
    });
    // o usuário edita no Obsidian uma nota que o agente vai tocar: a escrita commita a edição antes, como "edit"
    const pref = 'memory/preferences/respostas-em-portugues.md';
    await writeFile(join(dir, ...pref.split('/')), `${await readText(dir, pref)}\nEditado pelo usuário.\n`);
    await agent.patchPage({
      path: pref,
      old: 'Editado pelo usuário.',
      new: 'Editado pelo usuário (revisado).',
      session_handle: id,
    });
    const finished = await agent.consolidate({ action: 'finish', consolidation_id: id });
    expect(finished.squashed).toBe(false);
    expect(finished.next_step).toMatch(/não foram juntados/);
    expect(Number(await git(dir, ['rev-list', '--count', `${restore_point.commit}..HEAD`]))).toBe(4);
    expect(await commitMessageOf(dir)).toMatch(/\n\nconsolidate: consolidação /);
    expect(finished.changes).toEqual([
      'add gotcha: Primeira escrita da consolidação',
      'update preference: Respostas em português',
    ]);
    // o undo da sessão desfaz o que a consolidação gravou; a edição do usuário fica
    await agent.undo({ session: id });
    const text = await readText(dir, pref);
    expect(text).toContain('Editado pelo usuário.');
    expect(text).not.toContain('(revisado)');
  });

  it('não junta o que já foi enviado ao remoto', async () => {
    const dir = await createBrainRepo();
    const remote = join(dir, '..', 'remoto.git');
    await runGit(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
    await git(dir, ['remote', 'add', 'origin', remote]);
    await git(dir, ['push', '--quiet', '-u', 'origin', 'main']);
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const { consolidation_id: id } = await agent.consolidate({ action: 'start' });
    await agent.remember({
      type: 'gotcha',
      title: 'Escrita enviada',
      content: 'Esta escrita sai para o remoto antes do fim da consolidação, então não pode ser reescrita.',
      session_handle: id,
    });
    await git(dir, ['push', '--quiet']);
    const finished = await agent.consolidate({ action: 'finish', consolidation_id: id });
    expect(finished.squashed).toBe(false);
    expect(finished.next_step).toMatch(/enviada ao remoto/);
    expect(await git(dir, ['rev-list', '--count', '@{upstream}..HEAD'])).toBe('1');
  });

  it('id forjado, malformado ou sem mudanças', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    expect(
      (await errorOf(agent.consolidate({ action: 'finish', consolidation_id: '01KZ0000000000000000000000' }))).code,
    ).toBe('not_found');
    expect((await errorOf(agent.consolidate({ action: 'finish', consolidation_id: '../../x' }))).code).toBe(
      'invalid_argument',
    );
    expect(
      (await errorOf(agent.consolidate({ action: 'apagar' } as unknown as Parameters<Brain['consolidate']>[0]))).code,
    ).toBe('invalid_argument');
    const { consolidation_id: id } = await agent.consolidate({ action: 'start' });
    const empty = await agent.consolidate({ action: 'finish', consolidation_id: id });
    expect(empty).toMatchObject({ commit: null, squashed: false, changes: [] });
  });
});
