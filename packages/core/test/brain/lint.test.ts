// `lint` (marco 4): relatório por regras, sem LLM e só de leitura, no cérebro de exemplo e com problemas plantados.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError, LINT_RULES } from '../../src/brain/index.ts';
import { cleanupAll, createBrainRepo, disposeSandbox, openTest, snapshot, TEST_TIMEOUT_MS } from './helpers.ts';

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

const note = (fields: string, body: string): string => `---\n${fields}\n---\n${body}\n`;

describe('lint', { timeout: TEST_TIMEOUT_MS }, () => {
  it('no cérebro de exemplo: só achados informativos e de aviso, e nada muda no disco', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    await brain.status(); // o banco existe antes da foto
    const before = await snapshot(dir);
    const out = await brain.lint();
    expect(out.counts.error).toBe(0);
    expect(out.by_rule.fact_contradiction).toBeUndefined();
    // as menções sem link do exemplo (a ata cita Ana Prado, SQS...) aparecem com a correção
    const mention = out.findings.find((finding) => finding.rule === 'unlinked_mention');
    expect(mention?.fix).toMatch(/patch_page/);
    expect(out.data_notice).toMatch(/nunca instrução/);
    expect(await snapshot(dir)).toEqual(before);
  });

  it('acha cada problema plantado, com severidade, caminho e correção', async () => {
    const dir = await createBrainRepo();
    await mkdir(join(dir, 'memory', 'facts'), { recursive: true });
    await writeFile(
      join(dir, 'memory', 'facts', 'fato-atlas-usa-kafka.md'),
      note(
        'id: 01KZ0000000000000000000001\ntype: fact\nsubject: "[[Projeto Atlas]]"\npredicate: uses_queue\nobject: "[[Kafka]]"\nvalid_from: 2026-10-01\norigin: human\ntrust: high\ncreated: 2026-10-01\nupdated: 2026-10-01',
        'O Atlas também passou a usar Kafka.',
      ),
    );
    await writeFile(
      join(dir, 'wiki', 'concepts', 'Quebrada.md'),
      note(
        'id: 01KZ0000000000000000000002\ntype: concept\ntitle: Quebrada\nscope: global',
        'Veja [[Nota Que Não Existe]].',
      ),
    );
    await writeFile(join(dir, 'wiki', 'concepts', 'Yaml ruim.md'), '---\ntitle: [aberto\n---\ntexto\n');
    await writeFile(
      join(dir, 'memory', 'gotchas', 'antiga-sem-confirmacao.md'),
      note(
        'id: 01KZ0000000000000000000003\ntype: gotcha\ntitle: Antiga sem confirmação\nscope: global\ncreated: 2025-01-10\nupdated: 2025-02-01',
        'Uma armadilha velha que ninguém confirmou.',
      ),
    );
    await writeFile(
      join(dir, 'memory', 'gotchas', 'vencida.md'),
      note(
        'id: 01KZ0000000000000000000004\ntype: gotcha\ntitle: Vencida\nscope: global\nexpires_at: 2026-11-01\ncreated: 2026-10-01',
        'Deploy bloqueado até o dia 1.',
      ),
    );
    await writeFile(
      join(dir, 'wiki', 'concepts', 'Ideia solta.conflict-maquina-b-20261112-100000.md'),
      note('title: cópia', 'versão da outra máquina'),
    );
    const brain = await openTest(dir);
    const out = await brain.lint({ limit: 1000 });
    const by = (rule: string) => out.findings.filter((finding) => finding.rule === rule);

    const contradiction = by('fact_contradiction');
    expect(contradiction).toHaveLength(1);
    expect(contradiction[0]).toMatchObject({ severity: 'warning', path: 'memory/facts/fato-atlas-usa-sqs.md' });
    expect(contradiction[0]?.related).toEqual(['memory/facts/fato-atlas-usa-kafka.md']);

    expect(by('broken_link').map((finding) => finding.path)).toContain('wiki/concepts/Quebrada.md');
    expect(by('broken_link').find((finding) => finding.path === 'wiki/concepts/Quebrada.md')?.line).toBe(7);
    expect(by('invalid_frontmatter').map((finding) => finding.path)).toContain('wiki/concepts/Yaml ruim.md');
    expect(by('invalid_frontmatter')[0]?.severity).toBe('error');
    expect(by('unconfirmed_memory').map((finding) => finding.path)).toEqual([
      'memory/gotchas/antiga-sem-confirmacao.md',
    ]);
    expect(by('expired_note').map((finding) => finding.path)).toContain('memory/gotchas/vencida.md');
    // o que outra nota substituiu é histórico, não pendência
    expect(by('expired_note').map((finding) => finding.path)).not.toContain('memory/facts/fato-atlas-usa-rabbitmq.md');
    expect(by('conflict_copy')[0]).toMatchObject({
      severity: 'warning',
      related: ['wiki/concepts/Ideia solta.md'],
    });
    expect(by('orphan_note').map((finding) => finding.path)).toContain('memory/gotchas/vencida.md');
    expect(out.counts.error).toBeGreaterThan(0);
    // erro primeiro
    expect(out.findings[0]?.severity).toBe('error');
    for (const finding of out.findings) expect(finding.fix.length).toBeGreaterThan(10);
  });

  it('filtra por regra, corta com limit e recusa regra desconhecida', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const only = await brain.lint({ rules: ['unlinked_mention'], limit: 2 });
    expect(new Set(only.findings.map((finding) => finding.rule))).toEqual(new Set(['unlinked_mention']));
    expect(only.findings.length).toBeLessThanOrEqual(2);
    expect(only.truncated).toBe(only.total > 2);
    expect((await errorOf(brain.lint({ rules: ['apagar_tudo'] }))).code).toBe('invalid_argument');
    expect((await errorOf(brain.lint({ limit: 0 }))).code).toBe('invalid_argument');
    expect(LINT_RULES).toHaveLength(9);
  });
});
