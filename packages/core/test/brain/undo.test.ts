import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError } from '../../src/brain/index.ts';
import { parseCommitTrailers } from '../../src/git/index.ts';
import { collectIndexEntries, readBrainConfig, renderIndexMd } from '../../src/vault/index.ts';
import {
  cleanupAll,
  commitCount,
  commitMessageOf,
  createBrainRepo,
  disposeSandbox,
  git,
  head,
  openTest,
  porcelain,
  readText,
  snapshot,
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

async function expectCatalogConsistent(dir: string): Promise<void> {
  const config = await readBrainConfig(dir);
  const expected = renderIndexMd(await collectIndexEntries(dir, config), { groupOrder: config.noteDirs });
  expect(await readText(dir, 'index.md')).toBe(expected);
}

const gotcha = (title: string, extra: Record<string, unknown> = {}) => ({
  type: 'gotcha',
  title,
  content: `${title}: conteúdo com zebraundo.\n`,
  ...extra,
});

describe('undo', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sem argumento desfaz a última operação; o cérebro volta idêntico byte a byte, e o banco também', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    // a primeira escrita reformata o index.md do exemplo; o "antes" é depois dela
    await brain.remember(gotcha('Primeira'));
    const before = await snapshot(dir);
    const result = await brain.remember(gotcha('Segunda'));
    expect((await brain.search({ query: 'Segunda' })).hits.length).toBe(1);

    const undone = await brain.undo();
    expect(undone.undone.map((item) => item.op)).toEqual([result.op]);
    expect(undone.undone[0]?.changes).toEqual(['add gotcha: Segunda']);
    expect(undone.commit).toBe(await head(dir));
    expect([...undone.changed_paths].sort()).toEqual(['index.md', 'log.md', result.path].sort());
    expect(await snapshot(dir)).toEqual(before);
    expect(await porcelain(dir)).toBe('');
    expect((await brain.search({ query: 'Segunda' })).hits).toEqual([]);

    const message = await commitMessageOf(dir);
    expect(message).toMatch(/\n\nrevert gotcha: Segunda\n\n/);
    expect(parseCommitTrailers(message)).toMatchObject({
      op: undone.op,
      reverts: [result.op],
      client: 'teste',
      machine: 'maquina-a',
    });
    const ops = await brain.listOperations();
    expect(ops.operations[0]).toMatchObject({ op: undone.op, action: 'revert', reverts: [result.op], undone: false });
    expect(ops.operations.find((op) => op.op === result.op)).toMatchObject({ undone: true, undone_by: undone.op });
  });

  it('undo de undo refaz a operação; e por op, uma operação antiga sai sem levar a mais nova', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const first = await brain.remember(gotcha('Alfa'));
    const afterFirst = await snapshot(dir);
    const second = await brain.remember(gotcha('Beta'));
    const afterSecond = await snapshot(dir);

    const undo = await brain.undo();
    const redo = await brain.undo();
    expect(redo.undone.map((item) => item.op)).toEqual([undo.op]);
    expect(await snapshot(dir)).toEqual(afterSecond);
    expect((await brain.search({ query: 'Beta' })).hits.length).toBe(1);
    const again = await errorOf(brain.undo({ op: undo.op }));
    expect(again.code).toBe('already_undone');

    // desfaz a primeira (antiga): as linhas do index.md e do log.md são vizinhas, e mesmo assim não há conflito
    const old = await brain.undo({ op: first.op });
    expect(old.undone.map((item) => item.op)).toEqual([first.op]);
    expect((await brain.search({ query: 'Alfa' })).hits).toEqual([]);
    expect((await brain.search({ query: 'Beta' })).hits.length).toBe(1);
    expect(await porcelain(dir)).toBe('');
    await expectCatalogConsistent(dir);
    expect(await readText(dir, 'index.md')).not.toContain('alfa');
    expect(await readText(dir, 'index.md')).toContain('[[beta]]');
    expect(second.path).toBe('memory/gotchas/beta.md');
    // as notas são as de antes da segunda menos a primeira
    const expected = new Map(afterSecond);
    expected.delete(String(first.path));
    const now = await snapshot(dir);
    for (const [path, data] of expected) if (path !== 'index.md' && path !== 'log.md') expect(now.get(path)).toBe(data);
    expect(now.has(String(first.path))).toBe(false);
    expect(afterFirst.has(String(first.path))).toBe(true);
    expect((await errorOf(brain.undo({ op: first.op }))).code).toBe('already_undone');
    expect((await errorOf(brain.undo({ op: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ' }))).code).toBe('not_found');
  });

  it('por sessão: desfaz tudo que a sessão gravou, num commit, e deixa o resto', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    await brain.remember(gotcha('Fora da sessão antes'));
    const before = await snapshot(dir);
    const { session_handle: session } = await brain.recall({ task: 'qualquer' });
    const x = await brain.remember(gotcha('Sessão X', { session_handle: session }));
    await brain.patchPage({ path: String(x.path), old: 'conteúdo', new: 'texto', session_handle: session });
    await brain.remember(gotcha('Sessão Y', { session_handle: session }));
    const listed = await brain.listOperations({ session });
    expect(listed.operations.length).toBe(3);
    expect(listed.operations.every((op) => op.session === session)).toBe(true);

    const commits = await commitCount(dir);
    const result = await brain.undo({ session });
    expect(await commitCount(dir)).toBe(commits + 1);
    expect(result.undone.length).toBe(3);
    expect(parseCommitTrailers(await commitMessageOf(dir)).reverts.length).toBe(3);
    expect(await snapshot(dir)).toEqual(before);
    expect((await errorOf(brain.undo({ session }))).code).toBe('nothing_to_undo');
  });

  it('não desfaz o que não é do Cabeção: commits manuais e edições de fora ficam', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    expect((await errorOf(brain.undo())).code).toBe('nothing_to_undo');
    const op = await brain.remember(gotcha('Do Cabeção'));
    await writeFile(join(dir, 'wiki', 'concepts', 'Manual.md'), '# Manual\n\nEscrito à mão.\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'commit feito à mão']);
    const result = await brain.undo();
    expect(result.undone.map((item) => item.op)).toEqual([op.op]);
    expect(await readText(dir, 'wiki/concepts/Manual.md')).toBe('# Manual\n\nEscrito à mão.\n');
    expect(await porcelain(dir)).toBe('');
  });

  it('conflito no revert: erro claro e repositório intacto', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const created = await brain.remember(gotcha('Conflitante'));
    await brain.patchPage({ path: String(created.path), old: 'conteúdo', new: 'conteúdo alterado' });
    const before = await snapshot(dir);
    const sha = await head(dir);
    const error = await errorOf(brain.undo({ op: created.op }));
    expect(error.code).toBe('conflict');
    expect(error.nextStep).toBeTruthy();
    expect(await head(dir)).toBe(sha);
    expect(await snapshot(dir)).toEqual(before);
    expect(await porcelain(dir)).toBe('');

    // edição sem commit no arquivo que o revert mudaria: também recusa sem mexer em nada
    const other = await brain.remember(gotcha('Editada depois'));
    const edited = `${await readText(dir, String(other.path))}Linha do Obsidian.\n`;
    await writeFile(join(dir, ...String(other.path).split('/')), edited);
    const sha2 = await head(dir);
    expect((await errorOf(brain.undo())).code).toBe('conflict');
    expect(await head(dir)).toBe(sha2);
    expect(await readText(dir, String(other.path))).toBe(edited);
  });

  it('argumentos: op e session juntos, identificador inválido', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    expect((await errorOf(brain.undo({ op: 'A', session: 'B' }))).code).toBe('invalid_argument');
    expect((await errorOf(brain.undo({ op: 'não é ulid' }))).code).toBe('invalid_argument');
    expect((await errorOf(brain.listOperations({ limit: 0 }))).code).toBe('invalid_argument');
  });
});
