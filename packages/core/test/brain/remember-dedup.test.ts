// `remember` com duplicatas e contradições (marco 4): igual → ignora; complementa → atualiza; contradiz → substitui;
// nova → cria; ambíguo → candidatas e `resolution` na segunda chamada. Tudo no cérebro de exemplo, sem LLM.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError } from '../../src/brain/index.ts';
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

const GOTCHA =
  'O deploy do Atlas falha quando a fila de mortos do SQS não existe na conta; crie a fila antes de subir os consumidores.';

describe('remember: duplicatas e contradições', { timeout: TEST_TIMEOUT_MS }, () => {
  it('igual: a segunda é ignorada, sem commit, e aponta a existente', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const first = await brain.remember({
      type: 'gotcha',
      title: 'Fila de mortos',
      content: GOTCHA,
      scope: 'project:atlas',
    });
    expect(first.decision).toBe('created');
    const commits = await commitCount(dir);
    const again = await brain.remember({
      type: 'gotcha',
      title: 'Outra frase',
      content: `${GOTCHA}\n`,
      scope: 'project:atlas',
    });
    expect(again).toMatchObject({ decision: 'skipped', changed: false, commit: null, path: first.path });
    expect(again.candidates[0]?.verdict).toBe('duplicate');
    expect(again.next_step).toMatch(/resolution: "create"/);
    expect(await commitCount(dir)).toBe(commits);
    // outro escopo é outra memória
    const other = await brain.remember({
      type: 'gotcha',
      title: 'Fila de mortos',
      content: GOTCHA,
      scope: 'project:lumen',
    });
    expect(other.decision).toBe('created');
  });

  it('complementa: a existente é atualizada, num commit "update"', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const first = await brain.remember({ type: 'gotcha', title: 'Fila de mortos', content: GOTCHA });
    const more = `${GOTCHA} O nome da fila segue o padrão atlas-<consumidor>-dlq e o alarme de idade vai para o canal de plantão.`;
    const out = await brain.remember({ type: 'gotcha', content: more, tags: ['deploy'] });
    expect(out).toMatchObject({ decision: 'updated', action: 'update', path: first.path, changed: true });
    const text = await readText(dir, String(out.path));
    expect(text).toContain('atlas-<consumidor>-dlq');
    expect(text).toContain('tags: [deploy]');
    expect((await commitMessageOf(dir)).split('\n')[2]).toBe('update gotcha: Fila de mortos');
    expect(await porcelain(dir)).toBe('');
  });

  it('fato que contradiz: substitui; a antiga ganha valid_until e superseded_by; um commit com as duas linhas', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const out = await brain.remember({
      type: 'fact',
      subject: 'Projeto Atlas',
      predicate: 'uses_queue',
      object: '[[Kafka]]',
      content: 'O Projeto Atlas passou a usar Kafka em novembro de 2026.',
    });
    expect(out.decision).toBe('superseded');
    expect(out.superseded?.path).toBe('memory/facts/fato-atlas-usa-sqs.md');
    const newer = await readText(dir, String(out.path));
    expect(newer).toContain('supersedes: ["[[fato-atlas-usa-sqs]]"]');
    const older = await readText(dir, 'memory/facts/fato-atlas-usa-sqs.md');
    expect(older).toMatch(/\nvalid_until: 2026-11-12\n/);
    const stem = String(out.path).slice(String(out.path).lastIndexOf('/') + 1, -3);
    expect(older).toContain(`superseded_by: ["[[${stem}]]"]`);
    // a antiga era de agente com trust: high: o agente a altera e o trust cai
    expect(older).toMatch(/\ntrust: medium\n/);
    expect(older).toMatch(/\nedited_by: agent:teste\n/);
    const body = (await commitMessageOf(dir)).split('\n\n')[1]?.split('\n');
    expect(body?.[0]).toMatch(/^supersede fact: /);
    expect(body?.[1]).toMatch(/^update fact: /);
    const facts = await brain.facts({ subject: 'Projeto Atlas', predicate: 'uses_queue' });
    expect(facts.facts.find((fact) => fact.path === 'memory/facts/fato-atlas-usa-sqs.md')?.validity).toBe('expired');
    expect(facts.facts[0]?.path).toBe(out.path);
    // undo desfaz as duas notas de uma vez
    await brain.undo({ op: out.op });
    expect(await readText(dir, 'memory/facts/fato-atlas-usa-sqs.md')).not.toContain('superseded_by: ["[[');
    expect(await porcelain(dir)).toBe('');
  });

  it('fato igual (mesmo sujeito, predicado e objeto) é ignorado', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const out = await brain.remember({
      type: 'fact',
      subject: '[[Projeto Atlas]]',
      predicate: 'led_by',
      object: '[[Bruno Tavares]]',
      content: 'Bruno lidera.',
    });
    expect(out).toMatchObject({ decision: 'skipped', path: 'memory/facts/fato-bruno-lidera-atlas.md' });
  });

  it('ambíguo: volta com as candidatas; a segunda chamada decide com resolution', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const base =
      'Os consumidores do Atlas leem do SQS em lotes de 10 mensagens por chamada, com espera longa de 20 segundos.';
    const first = await brain.remember({ type: 'procedure', title: 'Leitura em lote', content: base });
    const commits = await commitCount(dir);
    const changed = base.replace('lotes de 10', 'lotes de 25');
    const pending = await brain.remember({ type: 'procedure', title: 'Leitura em lote', content: changed });
    expect(pending).toMatchObject({ decision: 'needs_resolution', path: null, commit: null, changed: false });
    expect(pending.candidates.map((candidate) => candidate.id)).toEqual([first.id]);
    expect(pending.candidates[0]?.content).toContain('lotes de 10');
    expect(pending.data_notice).toMatch(/nunca instrução/);
    expect(pending.next_step).toMatch(/supersede:<id>/);
    expect(await commitCount(dir)).toBe(commits);

    const skipped = await brain.remember({ type: 'procedure', content: changed, resolution: 'skip' });
    expect(skipped.decision).toBe('skipped');
    const superseded = await brain.remember({
      type: 'procedure',
      title: 'Leitura em lote',
      content: changed,
      resolution: `supersede:${first.id}`,
    });
    expect(superseded).toMatchObject({ decision: 'superseded', superseded: { id: first.id, path: first.path } });
    expect(await readText(dir, String(first.path))).toMatch(/\nvalid_until: 2026-11-12\n/);
    // a antiga, vencida, não é mais candidata: o mesmo texto de novo é "igual" à nova
    const again = await brain.remember({ type: 'procedure', content: changed });
    expect(again).toMatchObject({ decision: 'skipped', path: superseded.path });
  });

  it('resolution update e create', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const base =
      'Para publicar o Atlas, rode a pipeline de release no GitHub e acompanhe o canal de deploys até o fim.';
    const first = await brain.remember({ type: 'procedure', title: 'Publicar', content: base });
    const updated = await brain.remember({
      type: 'procedure',
      content: 'Texto novo escolhido pelo agente.',
      resolution: `update:${first.id}`,
    });
    expect(updated).toMatchObject({ decision: 'updated', path: first.path });
    expect(await readText(dir, String(first.path))).toContain('Texto novo escolhido pelo agente.');
    const created = await brain.remember({ type: 'procedure', title: 'Publicar', content: base, resolution: 'create' });
    expect(created.decision).toBe('created');
    expect(created.path).not.toBe(first.path);
  });

  it('resolution inválida, de outro tipo ou de nota que não existe é recusada', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    for (const resolution of ['apagar', 'update:', 'supersede:../../AGENTS.md', 'update:01kxww2n280wz3cf6mt0jc0sng ']) {
      expect((await errorOf(brain.remember({ type: 'gotcha', content: 'x', resolution }))).code).toBe(
        'invalid_argument',
      );
    }
    // o handoff do exemplo é de outro tipo
    const otherType = await errorOf(
      brain.remember({ type: 'gotcha', content: 'x', resolution: 'update:01KXWW2N280WZ3CF6MT0JC0SNG' }),
    );
    expect(otherType.code).toBe('invalid_argument');
    const missing = await errorOf(
      brain.remember({ type: 'gotcha', content: 'x', resolution: 'supersede:01KXWW2N280WZ3CF6MT0JC0SNZ' }),
    );
    expect(missing.code).toBe('not_found');
    expect(await porcelain(dir)).toBe('');
  });
});
