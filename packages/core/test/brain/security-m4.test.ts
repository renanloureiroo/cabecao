// Revisão adversária das tools do marco 4 (ciclo de vida da memória). O agente que chama as tools pode estar
// manipulado por conteúdo malicioso: cada bloco tenta usar uma tool nova para ler, escrever ou esconder o que não pode,
// e confere a recusa. Os segredos falsos são montados em tempo de execução.
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError } from '../../src/brain/index.ts';
import {
  cleanupAll,
  commitCount,
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

describe('ingest: um agente não faz o servidor ler arquivo de fora do cérebro', { timeout: TEST_TIMEOUT_MS }, () => {
  it('caminho absoluto, com .., pasta oculta, .cabecao/ e .git/ são recusados sem ler nada', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const outside = join(dir, '..', 'segredo-de-fora.md');
    await writeFile(outside, 'conteúdo de fora do cérebro\n');
    await agent.recall({ task: 'cria o segredo local' }); // garante a pasta .cabecao/
    await writeFile(join(dir, '.cabecao', 'notas.md'), 'local\n');
    const commits = await commitCount(dir);
    for (const path of [
      outside,
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '\\\\servidor\\pasta\\x.md',
      '../fora.md',
      'wiki/../../fora.md',
      '.cabecao/confirm.key',
      '.cabecao/notas.md',
      '.git/config',
      '.GIT/HEAD',
      'wiki/.oculta/x.md',
    ]) {
      const error = await errorOf(agent.ingest({ path }));
      expect(['unsafe_path', 'invalid_argument'], path).toContain(error.code);
      expect(error.message).not.toContain('conteúdo de fora');
    }
    expect(await commitCount(dir)).toBe(commits);
    expect(await porcelain(dir)).toBe('');
  });

  it('link simbólico dentro do cérebro que aponta para fora é recusado', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const target = join(dir, '..', 'alvo-de-fora.md');
    await writeFile(target, 'segredo fora do cérebro\n');
    await mkdir(join(dir, 'inbox'), { recursive: true });
    try {
      await symlink(target, join(dir, 'inbox', 'atalho.md'));
    } catch {
      return; // sem permissão para criar link simbólico (Windows sem modo de desenvolvedor)
    }
    const error = await errorOf(agent.ingest({ path: 'inbox/atalho.md' }));
    expect(error.code).toBe('unsafe_path');
  });

  it('a opção de arquivo do usuário não chega pelo input: content de agente é sempre ingest:text', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir, { actor: 'agent', client: 'claude-code' });
    const out = await agent.ingest({
      content: 'texto',
      title: 'Fonte',
      fromUserFile: true,
    } as unknown as Parameters<typeof agent.ingest>[0]);
    expect(out.source.origin).toBe('ingest:text');
    expect(await readText(dir, out.source.path)).toContain('ingested_by: agent:claude-code');
  });
});
