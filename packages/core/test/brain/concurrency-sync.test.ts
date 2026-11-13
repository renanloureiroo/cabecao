import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { parseCommitTrailers } from '../../src/git/index.ts';
import { collectIndexEntries, readBrainConfig, renderIndexMd } from '../../src/vault/index.ts';
import {
  cleanupAll,
  commitCount,
  commitFiles,
  createBrainRepo,
  createTwoMachines,
  disposeSandbox,
  git,
  openTest,
  porcelain,
  readText,
  spawnBrainChild,
  TEST_TIMEOUT_MS,
  waitChild,
} from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

async function expectCatalogConsistent(dir: string): Promise<void> {
  const config = await readBrainConfig(dir);
  const expected = renderIndexMd(await collectIndexEntries(dir, config), { groupOrder: config.noteDirs });
  expect(await readText(dir, 'index.md')).toBe(expected);
}

/** Cada commit novo (de `from` até HEAD) tem exatamente uma nota e o rodapé de operação. */
async function expectOneNotePerCommit(dir: string, from: string, ops: readonly string[]): Promise<void> {
  const shas = (await git(dir, ['rev-list', '--reverse', `${from}..HEAD`])).split('\n').filter(Boolean);
  expect(shas.length).toBe(ops.length);
  const seen: string[] = [];
  for (const sha of shas) {
    const notes = (await commitFiles(dir, sha)).filter((path) => path !== 'index.md' && path !== 'log.md');
    expect(notes.length).toBe(1);
    seen.push(parseCommitTrailers(await git(dir, ['log', '-1', '--format=%B', sha])).op ?? '');
  }
  expect(seen.sort()).toEqual([...ops].sort());
}

describe('escritas simultâneas', { timeout: TEST_TIMEOUT_MS }, () => {
  it('no mesmo processo: nenhuma perdida, um commit cada', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const start = await git(dir, ['rev-parse', 'HEAD']);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        brain.remember({ type: 'gotcha', title: `Paralela ${i}`, content: `Conteúdo paralelo ${i}.\n` }),
      ),
      brain.search({ query: 'paralelo' }),
      brain.recall({ task: 'paralelo' }),
    ]);
    const writes = results.slice(0, 5) as Awaited<ReturnType<typeof brain.remember>>[];
    expect(new Set(writes.map((result) => result.path)).size).toBe(5);
    await expectOneNotePerCommit(
      dir,
      start,
      writes.map((result) => result.op),
    );
    expect((await brain.search({ query: 'paralelo', limit: 20 })).hits.length).toBe(5);
    const log = await readText(dir, 'log.md');
    for (let i = 0; i < 5; i++) expect(log).toContain(`add gotcha: Paralela ${i}`);
    expect(await porcelain(dir)).toBe('');
    await expectCatalogConsistent(dir);
  });

  it('em dois processos: nenhuma perdida, um commit cada', async () => {
    const dir = await createBrainRepo();
    const start = await git(dir, ['rev-parse', 'HEAD']);
    const children = [spawnBrainChild([dir, 'proc-a', '4']), spawnBrainChild([dir, 'proc-b', '4'])];
    const outputs = await Promise.all(children.map(waitChild));
    const ops: string[] = [];
    for (const output of outputs) {
      expect(output.stderr).toBe('');
      expect(output.code).toBe(0);
      const line = output.stdout.split('\n').find((text) => text.startsWith('RESULTADO '));
      const results = JSON.parse(line?.slice('RESULTADO '.length) ?? '[]') as { op: string; commit: string }[];
      expect(results.length).toBe(4);
      ops.push(...results.map((result) => result.op));
    }
    await expectOneNotePerCommit(dir, start, ops);
    expect(await porcelain(dir)).toBe('');
    await expectCatalogConsistent(dir);
    const brain = await openTest(dir);
    expect((await brain.search({ query: 'Armadilha', limit: 20 })).hits.length).toBe(8);
  });
});

describe('sync entre duas máquinas', { timeout: TEST_TIMEOUT_MS }, () => {
  it('remember de um lado, search do outro', async () => {
    const { a, b } = await createTwoMachines();
    const brainA = await openTest(a, { machine: 'maquina-a' });
    const brainB = await openTest(b, { machine: 'maquina-b' });
    // B já indexou o cérebro antes do sync
    expect((await brainB.search({ query: 'zebrasync' })).hits).toEqual([]);

    const written = await brainA.remember({
      type: 'decision',
      title: 'Usar zebrasync nas filas',
      content: 'Decidimos usar zebrasync porque reduz custo.\n',
    });
    const sentA = await brainA.sync();
    expect(sentA).toMatchObject({ status: 'ok', pushed: 1, conflicts: [], secrets: [] });
    // o catálogo já estava certo no commit da operação: o sync não precisou de commit de correção
    expect(sentA.committed).toBe(0);

    const received = await brainB.sync();
    expect(received).toMatchObject({ status: 'ok', pulled: 1, integration: 'fast-forward' });
    expect(received.changed_paths).toContain(written.path);
    const hits = (await brainB.search({ query: 'zebrasync' })).hits;
    expect(hits.map((hit) => hit.path)).toEqual([written.path]);
    expect(hits[0]).toMatchObject({ origin: 'agent:teste', trust: 'medium' });
    expect((await brainB.read({ path: String(written.path) })).note.content).toContain('reduz custo');

    // e o undo feito em B desfaz a operação feita em A
    const undone = await brainB.undo({ op: written.op });
    expect(undone.undone.map((item) => item.op)).toEqual([written.op]);
    expect((await brainB.search({ query: 'zebrasync' })).hits).toEqual([]);
    expect((await brainB.sync()).status).toBe('ok');
    expect((await brainA.sync()).status).toBe('ok');
    expect((await brainA.search({ query: 'zebrasync' })).hits).toEqual([]);
    expect(await porcelain(a)).toBe('');
    expect(await porcelain(b)).toBe('');
    expect(await commitCount(a)).toBe(await commitCount(b));
    const status = await brainB.status();
    expect(status.sync).toMatchObject({ remote_configured: true, unpushed: 0 });
    expect(status.sync?.last_sync?.status).toBe('ok');
  });
});
