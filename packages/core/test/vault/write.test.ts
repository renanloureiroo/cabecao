import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNote } from '../../src/markdown/index.ts';
import { FileChangedError, isUlid } from '../../src/util/index.ts';
import type { BrainConfig, WriteResult } from '../../src/vault/index.ts';
import {
  addRelation,
  archiveNote,
  BRAIN_CONFIG_FILE,
  buildLinkIndex,
  createNote,
  hasErrors,
  listNoteFiles,
  localDate,
  patchNote,
  readBrainConfig,
  readNote,
  toCommitChange,
  updateNote,
  VaultError,
  validateNote,
} from '../../src/vault/index.ts';
import type { TempVault } from './helpers.ts';
import { copyFixture, exists, makeTempDir, readText, toCrlf, trySymlink, writeText } from './helpers.ts';

let temp: TempVault | undefined;
afterEach(async () => {
  await temp?.cleanup();
  temp = undefined;
});

/** 12/11/2026 às 14h32, no fuso da máquina. */
const NOW = new Date(2026, 10, 12, 14, 32, 10);
const TODAY = '2026-11-12';
const IDEMPOTENCIA_ID = '01KG2EP62GVDPTHW9YNVM4C445';

async function setup(label: string): Promise<{ root: string; config: BrainConfig }> {
  temp = await copyFixture(label);
  return { root: temp.root, config: await readBrainConfig(temp.root) };
}

async function vaultError(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultError) return error;
    throw error;
  }
  throw new Error('deveria ter lançado VaultError');
}

/** Linhas que mudaram entre dois textos de mesmo número de linhas (ignorando CRLF). */
function changedLines(before: string, after: string): string[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  expect(b.length).toBe(a.length);
  return b.filter((line, i) => line !== a[i]);
}

/** Para garantir que uma reescrita mude o mtime mesmo em sistemas de arquivos com resolução grossa. */
async function ageFile(root: string, relPath: string): Promise<void> {
  const old = new Date(2020, 0, 1);
  await utimes(join(root, ...relPath.split('/')), old, old);
}

describe('createNote', () => {
  it('cria uma decisão de agente com id, datas, padrões, pasta e nome pelo tipo', async () => {
    const { root, config } = await setup('create');
    const result = await createNote(root, config, {
      type: 'decision',
      origin: 'agent:claude-code',
      title: 'Adotar filas FIFO no faturamento',
      body: '# Adotar filas FIFO no faturamento\n\nPorque a ordem importa.',
      frontmatter: { scope: 'project:atlas', uses: ['[[SQS]]'], part_of: ['[[Projeto Atlas]]'], cor: 'azul' },
      now: NOW,
    });
    expect(result).toMatchObject({
      action: 'add',
      path: 'wiki/decisions/adotar-filas-fifo-no-faturamento.md',
      type: 'decision',
      title: 'Adotar filas FIFO no faturamento',
      changed: true,
      warnings: [],
    });
    expect(isUlid(result.id)).toBe(true);
    expect(toCommitChange(result)).toEqual({
      action: 'add',
      noteType: 'decision',
      title: 'Adotar filas FIFO no faturamento',
    });

    const text = await readText(root, result.path);
    expect(text).not.toContain('\r');
    expect(text.endsWith('Porque a ordem importa.\n')).toBe(true);
    const note = parseNote(text);
    expect(note.frontmatter).toEqual({
      id: result.id,
      type: 'decision',
      title: 'Adotar filas FIFO no faturamento',
      scope: 'project:atlas',
      tags: [],
      sources: [],
      trust: 'medium',
      origin: 'agent:claude-code',
      created: TODAY,
      updated: TODAY,
      uses: ['[[SQS]]'],
      part_of: ['[[Projeto Atlas]]'],
      cor: 'azul',
    });
    expect(validateNote({ ...note, path: result.path })).toEqual([]);
    expect(text).toContain('created: 2026-11-12\n');
    expect(text).toContain('uses: ["[[SQS]]"]\n');
    const read = await readNote(root, result.path);
    expect(result.stamp).toEqual(read.stamp);
  });

  it('cria um fato sem título, com valid_from, em memory/facts', async () => {
    const { root, config } = await setup('create');
    const result = await createNote(root, config, {
      type: 'fact',
      origin: 'human',
      frontmatter: { subject: '[[Projeto Atlas]]', predicate: 'uses_queue', object: '[[SQS FIFO]]' },
      body: 'O faturamento usa SQS FIFO.',
      now: NOW,
    });
    expect(result.path).toBe('memory/facts/projeto-atlas-uses-queue-sqs-fifo.md');
    expect(result.title).toBe('Projeto Atlas uses_queue SQS FIFO');
    const { note } = await readNote(root, result.path);
    expect(note.frontmatter).not.toHaveProperty('title');
    expect(note.frontmatter).not.toHaveProperty('scope');
    expect(note.frontmatter).toMatchObject({ trust: 'high', valid_from: TODAY, subject: '[[Projeto Atlas]]' });
    expect(Object.keys(note.frontmatter).slice(0, 5)).toEqual(['id', 'type', 'subject', 'predicate', 'object']);
  });

  it('episódio vai para memory/episodes/AAAA/MM com a data no nome; handoff com a data também', async () => {
    const { root, config } = await setup('create');
    const episode = await createNote(root, config, {
      type: 'episode',
      origin: 'agent:codex',
      title: 'Migração do consumidor de faturamento',
      now: NOW,
    });
    expect(episode.path).toBe('memory/episodes/2026/11/2026-11-12-migracao-do-consumidor-de-faturamento.md');
    const handoff = await createNote(root, config, {
      type: 'handoff',
      origin: 'agent:codex',
      title: 'Faturamento migrado',
      frontmatter: { expires_at: '2026-12-12' },
      now: NOW,
    });
    expect(handoff.path).toBe('memory/handoffs/2026-11-12-faturamento-migrado.md');
  });

  it('não colide com arquivo existente, sem diferenciar maiúsculas, nem com nome de outra pasta', async () => {
    const { root, config } = await setup('create');
    // `wiki/entities/SQS.md` existe: um conceito "sqs" deixaria [[sqs]] ambíguo
    const concept = await createNote(root, config, { type: 'concept', origin: 'human', title: 'sqs', now: NOW });
    expect(concept.path).toBe('wiki/concepts/sqs 2.md');
    const entity = await createNote(root, config, {
      type: 'entity',
      origin: 'human',
      title: 'Projeto ATLAS',
      now: NOW,
    });
    expect(entity.path).toBe('wiki/entities/Projeto ATLAS 2.md');
    const decision = await createNote(root, config, {
      type: 'decision',
      origin: 'human',
      title: 'Usar SQS para filas',
      now: NOW,
    });
    expect(decision.path).toBe('wiki/decisions/usar-sqs-para-filas-2.md');
    // os originais ficaram intactos
    expect((await readNote(root, 'wiki/entities/SQS.md')).note.frontmatter.id).toBe('01KKPWAA0RXP4MKXDKK45R2ZR5');
  });

  it('com o índice de nomes do chamador, não varre o cérebro', async () => {
    const { root, config } = await setup('create');
    const linkIndex = buildLinkIndex(['wiki/x/Banco de dados.md']);
    const result = await createNote(
      root,
      config,
      { type: 'concept', origin: 'human', title: 'Banco de dados', now: NOW },
      { linkIndex },
    );
    expect(result.path).toBe('wiki/concepts/Banco de dados 2.md');
  });

  it('título longo e com caracteres proibidos vira nome portável', async () => {
    const { root, config } = await setup('create');
    const title = `Por quê: ${'integração '.repeat(40)}?`;
    const result = await createNote(root, config, { type: 'concept', origin: 'human', title, now: NOW });
    const name = result.path.slice(result.path.lastIndexOf('/') + 1);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name).not.toMatch(/[:?]/);
    expect((await readNote(root, result.path)).note.frontmatter.title).toBe(title.trim());
  });

  it('recusa regra criada por quem não é humano', async () => {
    const { root, config } = await setup('create');
    const error = await vaultError(
      createNote(root, config, { type: 'rule', origin: 'agent:claude-code', title: 'Sempre usar tabs', now: NOW }),
    );
    expect(error.code).toBe('rule_requires_human');
    // nem passando origin: human pelo frontmatter
    const sneaky = await vaultError(
      createNote(root, config, {
        type: 'rule',
        origin: 'ingest:web',
        title: 'Sempre usar tabs',
        frontmatter: { origin: 'human' },
      }),
    );
    expect(sneaky.code).toBe('rule_requires_human');
    const ok = await createNote(root, config, { type: 'rule', origin: 'human', title: 'Sempre usar tabs', now: NOW });
    expect(ok.path).toBe('memory/rules/sempre-usar-tabs.md');
  });

  it('recusa nota inválida com todos os problemas e não grava nada', async () => {
    const { root, config } = await setup('create');
    const before = await listNoteFiles(root, config);
    const error = await vaultError(
      createNote(root, config, {
        type: 'decision',
        origin: 'human',
        frontmatter: { scope: 'qualquer', uses: 'SQS', valid_until: 'amanhã' },
      }),
    );
    expect(error.code).toBe('invalid_note');
    expect(error.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.field)).toEqual([
      'title',
      'scope',
      'valid_until',
      'uses',
    ]);
    expect(await listNoteFiles(root, config)).toEqual(before);
    expect((await vaultError(createNote(root, config, { type: 'ideia' as 'concept', origin: 'human' }))).code).toBe(
      'invalid_note',
    );
    expect((await vaultError(createNote(root, config, { type: 'concept', origin: 'robô', title: 'x' }))).code).toBe(
      'invalid_note',
    );
  });

  it('com caminho explícito: dentro de noteDirs, nome portável, sem sobrescrever', async () => {
    const { root, config } = await setup('create');
    const ok = await createNote(root, config, {
      type: 'concept',
      origin: 'agent:claude-code',
      title: 'Backoff',
      path: 'wiki\\concepts\\Backoff exponencial.md',
      now: NOW,
    });
    expect(ok.path).toBe('wiki/concepts/Backoff exponencial.md');

    const cases: [string, string][] = [
      ['wiki/concepts/idempotência.md', 'note_exists'],
      ['wiki/concepts/IDEMPOTÊNCIA.MD', 'note_exists'],
      ['../fora.md', 'unsafe_path'],
      ['.git/hooks/x.md', 'unsafe_path'],
      ['dashboards/x.md', 'invalid_note_path'],
      ['wiki/x.txt', 'invalid_note_path'],
      ['wiki/.obsidian/x.md', 'invalid_note_path'],
      ['wiki/a:b.md', 'invalid_file_name'],
      ['wiki/CON.md', 'invalid_file_name'],
    ];
    for (const [path, code] of cases) {
      const error = await vaultError(createNote(root, config, { type: 'concept', origin: 'human', title: 'x', path }));
      expect(error.code, path).toBe(code);
    }
    expect((await readNote(root, 'wiki/concepts/Idempotência.md')).note.frontmatter.id).toBe(IDEMPOTENCIA_ID);
  });

  it('recusa gravar através de um link simbólico que sai do cérebro', async () => {
    const { root, config } = await setup('create');
    const outside = await makeTempDir('fora');
    try {
      if (!(await trySymlink(outside.root, join(root, 'wiki', 'fora'), 'dir'))) return;
      const error = await vaultError(
        createNote(root, config, { type: 'concept', origin: 'human', title: 'x', path: 'wiki/fora/x.md' }),
      );
      expect(error.code).toBe('unsafe_path');
      expect(await exists(outside.root, 'x.md')).toBe(false);
    } finally {
      await outside.cleanup();
    }
  });

  it('recusa quando a pasta do tipo fica fora das pastas de notas', async () => {
    const { root, config } = await setup('create');
    const error = await vaultError(
      createNote(root, { ...config, noteDirs: ['wiki'] }, { type: 'gotcha', origin: 'human', title: 'x' }),
    );
    expect(error.code).toBe('invalid_note_path');
  });

  it('duas criações simultâneas com o mesmo título não se atropelam', async () => {
    const { root, config } = await setup('create');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createNote(root, config, { type: 'gotcha', origin: 'human', title: 'Mesmo título', body: `n${i}`, now: NOW }),
      ),
    );
    const paths = results.map((result) => result.path).sort();
    expect(new Set(paths).size).toBe(5);
    const bodies = await Promise.all(paths.map(async (path) => (await readNote(root, path)).note.body.trim()));
    expect(bodies.sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });
});

describe('updateNote', () => {
  const path = 'wiki/decisions/usar-sqs-para-filas.md';

  it('muda só as linhas dos campos alterados e o updated; o corpo fica byte a byte', async () => {
    const { root } = await setup('update');
    const before = await readNote(root, path);
    const result = await updateNote(root, path, { frontmatter: { confirmed: TODAY } }, { now: NOW });
    expect(result).toMatchObject({ action: 'update', path, type: 'decision', title: 'Usar SQS para filas' });
    expect(result.changed).toBe(true);
    const after = await readNote(root, path);
    expect(changedLines(before.text, after.text)).toEqual([`updated: ${TODAY}`, `confirmed: ${TODAY}`]);
    expect(after.note.body).toBe(before.note.body);
    expect(result.stamp).toEqual(after.stamp);
  });

  it('acrescenta campo na posição canônica, remove campo e troca o corpo', async () => {
    const { root } = await setup('update');
    const result = await updateNote(
      root,
      path,
      { frontmatter: { works_on: ['[[Projeto Atlas]]'], valid_until: TODAY }, remove: ['expires_at'], body: 'Novo.' },
      { now: NOW },
    );
    expect(result.changed).toBe(true);
    const { note, text } = await readNote(root, path);
    expect(note.body).toBe('Novo.\n');
    expect(note.frontmatter).not.toHaveProperty('expires_at');
    expect(note.frontmatter.valid_until).toBe(TODAY);
    const keys = Object.keys(note.frontmatter);
    // logo depois do último campo que vem antes dele na ordem canônica (o arquivo tem decided_by antes de depends_on)
    expect(keys.slice(-2)).toEqual(['depends_on', 'works_on']);
    expect(text.split('\n').filter((line) => line.startsWith('uses:'))).toEqual(['uses: ["[[SQS]]"]']);
  });

  it('não grava nada quando nada muda', async () => {
    const { root } = await setup('update');
    await ageFile(root, path);
    const before = await readNote(root, path);
    const result = await updateNote(root, path, {
      frontmatter: { title: 'Usar SQS para filas' },
      body: before.note.body,
    });
    expect(result.changed).toBe(false);
    expect((await readNote(root, path)).stamp).toEqual(before.stamp);
  });

  it('não atropela uma edição feita no Obsidian depois da leitura', async () => {
    const { root } = await setup('update');
    const read = await readNote(root, path);
    // o usuário edita no Obsidian
    await ageFile(root, path);
    await writeText(root, path, `${read.text}\nLinha nova do usuário.\n`);
    const error = await updateNote(root, path, { body: 'do agente' }, { ifUnchangedSince: read.stamp }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FileChangedError);
    expect(await readText(root, path)).toContain('Linha nova do usuário.');
  });

  it('não deixa trocar id nem type', async () => {
    const { root } = await setup('update');
    expect((await vaultError(updateNote(root, path, { frontmatter: { type: 'concept' } }))).code).toBe(
      'immutable_field',
    );
    expect((await vaultError(updateNote(root, path, { remove: ['id'] }))).code).toBe('immutable_field');
  });

  it('recusa só o erro que a mudança introduz; problema antigo não trava a nota', async () => {
    const { root } = await setup('update');
    const error = await vaultError(updateNote(root, path, { frontmatter: { trust: 'total' } }));
    expect(error.code).toBe('invalid_note');
    expect(error.issues.map((issue) => issue.field)).toEqual(['trust']);

    await writeText(
      root,
      'wiki/concepts/Torta.md',
      '---\nid: 01KG2EP62GVDPTHW9YN4PHGN51\ntype: concept\ntitle: Torta\nscope: errado\n---\nx\n',
    );
    const result = await updateNote(root, 'wiki/concepts/Torta.md', { body: 'y' }, { now: NOW });
    expect(result.changed).toBe(true);
    expect(hasErrors(validateNote({ frontmatter: (await readNote(root, result.path)).note.frontmatter }))).toBe(true);
  });

  it('frontmatter ilegível: só o corpo pode ser trocado', async () => {
    const { root } = await setup('update');
    await writeText(root, 'wiki/concepts/Quebrada.md', '---\ntitle: [aberto\n---\ncorpo\n');
    expect(
      (await vaultError(updateNote(root, 'wiki/concepts/Quebrada.md', { frontmatter: { title: 'x' } }))).code,
    ).toBe('invalid_frontmatter');
    await updateNote(root, 'wiki/concepts/Quebrada.md', { body: 'novo' });
    expect(await readText(root, 'wiki/concepts/Quebrada.md')).toBe('---\ntitle: [aberto\n---\nnovo\n');
  });

  it('fonte bruta sem frontmatter não ganha updated', async () => {
    const { root } = await setup('update');
    const raw = 'raw/meetings/2026-05-03-arquitetura.md';
    const before = await readNote(root, raw);
    await updateNote(root, raw, { body: `${before.note.body}Adendo.\n` });
    const after = await readNote(root, raw);
    expect(after.note.hasFrontmatter).toBe(false);
    expect(after.note.body.endsWith('Adendo.\n')).toBe(true);
  });

  it('arquivo com CRLF continua todo em CRLF, preservando BOM', async () => {
    const { root } = await setup('update');
    const crlf = `﻿${toCrlf((await readNote(root, path)).text.replace(/^﻿/, ''))}`;
    await writeFile(join(root, ...path.split('/')), crlf);
    await updateNote(root, path, { frontmatter: { confirmed: TODAY }, body: 'Linha 1\nLinha 2\n' }, { now: NOW });
    const text = await readText(root, path);
    expect(text.startsWith('﻿---\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(text.endsWith('Linha 1\r\nLinha 2\r\n')).toBe(true);
    expect(parseNote(text).frontmatter.confirmed).toBe(TODAY);
  });

  it('preserva comentários e formatação do frontmatter escrito à mão', async () => {
    const { root } = await setup('update');
    const original = [
      '---',
      '# minhas notas',
      'id: 01KG2EP62GVDPTHW9YN4PHGN51',
      'type: concept',
      "title: 'Com aspas'",
      'tags:',
      '  - a',
      '  - b',
      'updated: 2026-01-01',
      '---',
      'corpo',
      '',
    ].join('\n');
    await writeText(root, 'wiki/concepts/Manual.md', original);
    await updateNote(root, 'wiki/concepts/Manual.md', { frontmatter: { scope: 'global' } }, { now: NOW });
    expect(await readText(root, 'wiki/concepts/Manual.md')).toBe(
      original.replace("title: 'Com aspas'\n", "title: 'Com aspas'\nscope: global\n").replace('2026-01-01', TODAY),
    );
  });

  it('nota que não existe e caminho inseguro', async () => {
    const { root } = await setup('update');
    expect((await vaultError(updateNote(root, 'wiki/nada.md', { body: 'x' }))).code).toBe('note_not_found');
    expect((await vaultError(updateNote(root, '../x.md', { body: 'x' }))).code).toBe('unsafe_path');
  });

  it('atualizações simultâneas da mesma nota no mesmo processo não se perdem', async () => {
    const { root } = await setup('update');
    const tags = ['t0', 't1', 't2', 't3', 't4'];
    await Promise.all(tags.map((tag) => addRelation(root, path, 'related_to', tag)));
    const { note } = await readNote(root, path);
    expect(note.frontmatter.related_to).toEqual(expect.arrayContaining(tags.map((tag) => `[[${tag}]]`)));
  });
});

describe('patchNote', () => {
  const path = 'wiki/concepts/Idempotência.md';

  it('substitui um trecho único do corpo', async () => {
    const { root } = await setup('patch');
    const before = await readNote(root, path);
    const result = await patchNote(root, path, 'guarda o identificador', 'grava o identificador', { now: NOW });
    expect(result).toMatchObject({ action: 'update', path, type: 'concept', title: 'Idempotência', changed: true });
    const after = await readNote(root, path);
    expect(after.note.body).toBe(before.note.body.replace('guarda o identificador', 'grava o identificador'));
    expect(changedLines(before.text, after.text)).toEqual([
      `updated: ${TODAY}`,
      'No [[projeto atlas]], cada consumidor grava o identificador da mensagem já processada.',
    ]);
  });

  it('zero ou mais de uma ocorrência é erro claro, e nada é gravado', async () => {
    const { root } = await setup('patch');
    const before = await readText(root, path);
    const missing = await vaultError(patchNote(root, path, 'não existe no texto', 'x'));
    expect(missing.code).toBe('patch_not_found');
    const many = await vaultError(patchNote(root, path, '[[', 'x'));
    expect(many.code).toBe('patch_ambiguous');
    expect(many.occurrences).toBe(2);
    expect(many.message).toMatch(/2 vezes/);
    expect((await vaultError(patchNote(root, path, '', 'x'))).code).toBe('patch_empty');
    // o frontmatter não entra na busca
    expect((await vaultError(patchNote(root, path, `id: ${IDEMPOTENCIA_ID}`, 'x'))).code).toBe('patch_not_found');
    expect(await readText(root, path)).toBe(before);
  });

  it('ocorrências sobrepostas contam como ambiguidade', async () => {
    const { root } = await setup('patch');
    await writeText(
      root,
      'wiki/concepts/A.md',
      '---\nid: 01KG2EP62GVDPTHW9YN4PHGN51\ntype: concept\ntitle: A\n---\naaa\n',
    );
    expect((await vaultError(patchNote(root, 'wiki/concepts/A.md', 'aa', 'b'))).code).toBe('patch_ambiguous');
  });

  it('num arquivo com CRLF, acha trecho escrito com LF', async () => {
    const { root } = await setup('patch');
    await writeText(root, 'wiki/concepts/W.md', toCrlf('---\ntype: concept\n---\nlinha 1\nlinha 2\nlinha 3\n'));
    await patchNote(root, 'wiki/concepts/W.md', 'linha 1\nlinha 2', 'nova 1\nnova 2');
    expect(await readText(root, 'wiki/concepts/W.md')).toBe(
      toCrlf('---\ntype: concept\n---\nnova 1\nnova 2\nlinha 3\n'),
    );
  });
});

describe('addRelation', () => {
  const path = 'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md';

  it('acrescenta a relação e é idempotente', async () => {
    const { root } = await setup('relate');
    const first = await addRelation(root, path, 'uses', 'SQS', { now: NOW });
    expect(first).toMatchObject({ action: 'update', path, type: 'gotcha', changed: true });
    expect((await readNote(root, path)).note.frontmatter.uses).toEqual(['[[SQS]]']);

    await ageFile(root, path);
    const stamp = (await readNote(root, path)).stamp;
    for (const again of ['SQS', '[[sqs]]', ' [[SQS|apelido]] ', 'SQS.md']) {
      const result = await addRelation(root, path, 'uses', again);
      expect(result.changed, again).toBe(false);
    }
    expect((await readNote(root, path)).stamp).toEqual(stamp);

    await addRelation(root, path, 'part_of', '[[Lumen Logística]]', { now: NOW });
    expect((await readNote(root, path)).note.frontmatter.part_of).toEqual(['[[Projeto Atlas]]', '[[Lumen Logística]]']);
    await addRelation(root, path, 'supersedes', 'raw/meetings/2026-05-03-arquitetura', { now: NOW });
    expect((await readNote(root, path)).note.frontmatter.supersedes).toEqual([
      '[[raw/meetings/2026-05-03-arquitetura]]',
    ]);
  });

  it('aceita as relações extras do .cabecao.json e recusa as desconhecidas', async () => {
    const { root } = await setup('relate');
    expect((await vaultError(addRelation(root, path, 'mentored_by', 'Ana Prado'))).code).toBe('unknown_relation');
    const config = JSON.parse(await readText(root, BRAIN_CONFIG_FILE));
    await writeText(root, BRAIN_CONFIG_FILE, JSON.stringify({ ...config, relations: ['mentored_by'] }));
    await addRelation(root, path, 'mentored_by', 'Ana Prado', { now: NOW });
    const { note, text } = await readNote(root, path);
    expect(note.frontmatter.mentored_by).toEqual(['[[Ana Prado]]']);
    expect(text).toContain('mentored_by: ["[[Ana Prado]]"]');
  });

  it('recusa alvo inválido e campo que não é lista', async () => {
    const { root } = await setup('relate');
    for (const bad of ['', 'a|b', 'a]]', '[[a]] [[b]]']) {
      expect((await vaultError(addRelation(root, path, 'uses', bad))).code, bad).toBe('invalid_link_target');
    }
    await writeText(root, 'wiki/concepts/U.md', '---\ntype: concept\nuses: "[[SQS]]"\n---\n');
    expect((await vaultError(addRelation(root, 'wiki/concepts/U.md', 'uses', 'RabbitMQ'))).code).toBe('invalid_note');
  });
});

describe('archiveNote', () => {
  const path = 'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md';

  it('move para memory/_archive, encerra a validade e devolve o que mudou', async () => {
    const { root, config } = await setup('archive');
    const before = await readNote(root, path);
    const result: WriteResult = await archiveNote(root, path, { now: NOW });
    expect(result).toMatchObject({
      action: 'archive',
      path: 'memory/_archive/testes-de-integracao-sem-limpar-o-banco.md',
      from: path,
      type: 'gotcha',
      title: 'Testes de integração falham sem limpar o banco',
    });
    expect(await exists(root, path)).toBe(false);
    const after = await readNote(root, result.path);
    expect(after.note.frontmatter).toEqual({ ...before.note.frontmatter, updated: TODAY, valid_until: TODAY });
    expect(after.note.body).toBe(before.note.body);
    const listed = (await listNoteFiles(root, config)).find((file) => file.path === result.path);
    expect(listed?.archived).toBe(true);
  });

  it('desempata o nome no arquivo e não muda valid_until que já existe', async () => {
    const { root } = await setup('archive');
    await writeText(
      root,
      'memory/preferences/preferencia-usar-tabs.md',
      '---\nid: 01KYM56NVG0HMHFRW47626AJF4\ntype: preference\ntitle: Tabs\nvalid_until: 2026-01-01\n---\nx\n',
    );
    const result = await archiveNote(root, 'memory/preferences/preferencia-usar-tabs.md', { now: NOW });
    expect(result.path).toBe('memory/_archive/preferencia-usar-tabs-2.md');
    expect((await readNote(root, result.path)).note.frontmatter.valid_until).toBe('2026-01-01');
  });

  it('recusa arquivar de novo, e não perde edição feita no meio', async () => {
    const { root } = await setup('archive');
    expect((await vaultError(archiveNote(root, 'memory/_archive/preferencia-usar-tabs.md'))).code).toBe(
      'already_archived',
    );
    const read = await readNote(root, path);
    await ageFile(root, path);
    await writeText(root, path, `${read.text}mais\n`);
    await expect(archiveNote(root, path, { ifUnchangedSince: read.stamp })).rejects.toBeInstanceOf(FileChangedError);
    expect(await exists(root, path)).toBe(true);
    expect(await exists(root, 'memory/_archive/testes-de-integracao-sem-limpar-o-banco.md')).toBe(false);
  });
});

describe('localDate', () => {
  it('usa a data local, com zeros', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDate(NOW)).toBe(TODAY);
  });
});
