import { rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backlinks,
  brokenLinks,
  getNote,
  indexStatus,
  outgoingLinks,
  PATH_ID_PREFIX,
  reindexFull,
  scan,
  searchKeyword,
} from '../../src/db/index.ts';
import { readText, writeText } from '../vault/helpers.ts';
import type { OpenVault } from './helpers.ts';
import { openEmptyVault, openFixture } from './helpers.ts';

let vault: OpenVault | undefined;
afterEach(async () => {
  await vault?.cleanup();
  vault = undefined;
});

const abs = (root: string, rel: string): string => join(root, ...rel.split('/'));
const count = (v: OpenVault, sql: string): number => Number(v.index.db.prepare(sql).get()?.n ?? 0);

const SQS_DECISION = 'wiki/decisions/usar-sqs-para-filas.md';
const SQS_DECISION_ID = '01KNWQPCCGW9YN4PHGN519T4H6';

describe('scan: cérebro de exemplo', () => {
  it('indexa todas as notas na primeira varredura e reporta as fontes sem id', async () => {
    vault = await openFixture('first');
    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 25, updated: 0, removed: 0, renamed: 0, unchanged: 0, filesRead: 25 });
    expect(summary.total).toBe(25);
    // as duas fontes brutas não têm id; nenhuma outra nota tem problema
    expect(summary.errors.map((e) => [e.path, e.code]).sort()).toEqual([
      ['raw/articles/filas-gerenciadas-vs-autogeridas.md', 'missing_id'],
      ['raw/meetings/2026-05-03-arquitetura.md', 'missing_id'],
    ]);

    const status = indexStatus(vault.index);
    expect(status).toMatchObject({
      notes: 25,
      archived: 1,
      unmanaged: 2,
      untyped: 2,
      facts: 4,
      brokenLinks: 1,
      schemaVersion: status.expectedSchemaVersion,
    });
    expect(status.byType).toEqual({
      concept: 2,
      decision: 2,
      entity: 6,
      episode: 1,
      fact: 4,
      gotcha: 1,
      handoff: 1,
      preference: 1,
      procedure: 1,
      rule: 1,
      source: 1,
      synthesis: 1,
    });
    expect(status.chunks).toBeGreaterThanOrEqual(25);
    expect(status.lastScanAt).not.toBeNull();

    const raw = getNote(vault.index, { path: 'raw/meetings/2026-05-03-arquitetura.md' });
    expect(raw).toMatchObject({ id: `${PATH_ID_PREFIX}raw/meetings/2026-05-03-arquitetura.md`, managed: false });
    expect(raw?.title).toBe('Reunião de arquitetura — 03/05/2026');
  });

  it('não lê nenhum arquivo quando nada mudou', async () => {
    vault = await openFixture('nothing');
    await scan(vault.index, vault.root, vault.config);
    const again = await scan(vault.index, vault.root, vault.config);
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, renamed: 0, unchanged: 25, filesRead: 0 });
    expect(again.errors).toEqual([]);
  });

  it('lê, mas não reprocessa, um arquivo de data nova e conteúdo igual (git checkout)', async () => {
    vault = await openFixture('touch');
    await scan(vault.index, vault.root, vault.config);
    const chunkIds = vault.index.db.prepare('select id from chunks where note_id = ? order by id').all(SQS_DECISION_ID);
    const later = new Date(Date.now() + 60_000);
    await utimes(abs(vault.root, SQS_DECISION), later, later);

    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 0, updated: 0, unchanged: 25, filesRead: 1 });
    expect(vault.index.db.prepare('select id from chunks where note_id = ? order by id').all(SQS_DECISION_ID)).toEqual(
      chunkIds,
    );
    expect(getNote(vault.index, { id: SQS_DECISION_ID })?.mtimeMs).toBe(
      (await stat(abs(vault.root, SQS_DECISION))).mtimeMs,
    );
    // e a próxima varredura volta a não ler nada
    expect((await scan(vault.index, vault.root, vault.config)).filesRead).toBe(0);
  });

  it('atualiza uma nota editada', async () => {
    vault = await openFixture('edit');
    await scan(vault.index, vault.root, vault.config);
    const text = await readText(vault.root, SQS_DECISION);
    await writeText(vault.root, SQS_DECISION, `${text}\n## Custos\n\nA conta mensal ficou em torno de zebubalina.\n`);

    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 0, updated: 1, removed: 0, renamed: 0, filesRead: 1 });
    const hits = searchKeyword(vault.index, { query: 'zebubalina' }).hits;
    expect(hits.map((h) => h.path)).toEqual([SQS_DECISION]);
    expect(hits[0]?.headingPath).toEqual(['Usar SQS para filas', 'Custos']);
  });

  it('remove uma nota apagada, e o link para ela fica quebrado', async () => {
    vault = await openFixture('delete');
    await scan(vault.index, vault.root, vault.config);
    const idempotencia = getNote(vault.index, { path: 'wiki/concepts/Idempotência.md' });
    expect(idempotencia).not.toBeNull();
    await rm(abs(vault.root, 'wiki/concepts/Idempotência.md'));

    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 0, removed: 1, filesRead: 0, total: 24 });
    expect(getNote(vault.index, { path: 'wiki/concepts/Idempotência.md' })).toBeNull();
    expect(count(vault, `select count(*) as n from chunks where note_id = '${idempotencia?.id}'`)).toBe(0);
    expect(count(vault, `select count(*) as n from chunks_fts where chunks_fts match '"idempotente"'`)).toBe(0);
    const broken = brokenLinks(vault.index).map((b) => b.target);
    expect(broken).toContain('Idempotência');
    expect(broken).toContain('Kafka');
  });

  it('renomear o arquivo mantém o id e não reprocessa os trechos', async () => {
    vault = await openFixture('rename');
    await scan(vault.index, vault.root, vault.config);
    const before = vault.index.db
      .prepare('select id, chunk_key from chunks where note_id = ? order by id')
      .all(SQS_DECISION_ID);
    const renamedPath = 'wiki/decisions/adotar-sqs.md';
    await rename(abs(vault.root, SQS_DECISION), abs(vault.root, renamedPath));

    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 0, updated: 0, removed: 0, renamed: 1, filesRead: 1, total: 25 });
    const note = getNote(vault.index, { id: SQS_DECISION_ID });
    expect(note?.path).toBe(renamedPath);
    expect(
      vault.index.db.prepare('select id, chunk_key from chunks where note_id = ? order by id').all(SQS_DECISION_ID),
    ).toEqual(before);
    // quem apontava para `[[usar-sqs-para-filas]]` agora aponta para um nome que não existe
    expect(brokenLinks(vault.index).some((b) => b.target === 'usar-sqs-para-filas')).toBe(true);
    // e os links de saída da nota renomeada continuam resolvidos
    expect(outgoingLinks(vault.index, SQS_DECISION_ID).find((l) => l.target === 'SQS')?.broken).toBe(false);
  });

  it('mover e editar ao mesmo tempo é renomeação pelo id', async () => {
    vault = await openFixture('move-edit');
    await scan(vault.index, vault.root, vault.config);
    const text = await readText(vault.root, SQS_DECISION);
    await rm(abs(vault.root, SQS_DECISION));
    await writeText(vault.root, 'wiki/decisions/2026/usar-sqs-para-filas.md', text.replace('por custo', 'pelo custo'));

    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 0, updated: 0, removed: 0, renamed: 1, total: 25 });
    expect(getNote(vault.index, { id: SQS_DECISION_ID })?.path).toBe('wiki/decisions/2026/usar-sqs-para-filas.md');
    // o nome do arquivo é o mesmo: os links continuam resolvidos
    expect(brokenLinks(vault.index).map((b) => b.target)).toEqual(['Kafka']);
  });

  it('renomear uma fonte sem id troca o id derivado do caminho', async () => {
    vault = await openFixture('rename-raw');
    await scan(vault.index, vault.root, vault.config);
    await rename(abs(vault.root, 'raw/meetings/2026-05-03-arquitetura.md'), abs(vault.root, 'raw/meetings/ata.md'));
    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary.renamed).toBe(1);
    expect(getNote(vault.index, { path: 'raw/meetings/ata.md' })?.id).toBe(`${PATH_ID_PREFIX}raw/meetings/ata.md`);
    const hits = searchKeyword(vault.index, { query: 'intervenções manuais' }).hits;
    expect(hits.map((h) => h.path)).toEqual(['raw/meetings/ata.md']);
  });

  it('link para nota inexistente fica quebrado e é corrigido quando a nota é criada', async () => {
    vault = await openFixture('kafka');
    await scan(vault.index, vault.root, vault.config);
    const fila = getNote(vault.index, { path: 'wiki/concepts/Fila de mensagens.md' });
    const kafkaLink = () => outgoingLinks(vault?.index as never, fila?.id ?? '').find((l) => l.target === 'Kafka');
    expect(kafkaLink()).toMatchObject({ broken: true, noteId: null, origin: 'wikilink', type: 'link' });
    expect(brokenLinks(vault.index)).toEqual([
      expect.objectContaining({ path: 'wiki/concepts/Fila de mensagens.md', target: 'Kafka' }),
    ]);

    await writeText(
      vault.root,
      'wiki/entities/Kafka.md',
      '---\nid: 01KZZZZZZZZZZZZZZZZZZZZZZZ\ntype: entity\ntitle: Kafka\n---\n# Kafka\n\nUm log distribuído.\n',
    );
    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 1, filesRead: 1 });
    expect(kafkaLink()).toMatchObject({
      broken: false,
      noteId: '01KZZZZZZZZZZZZZZZZZZZZZZZ',
      path: 'wiki/entities/Kafka.md',
    });
    expect(brokenLinks(vault.index)).toEqual([]);
    expect(backlinks(vault.index, '01KZZZZZZZZZZZZZZZZZZZZZZZ').map((b) => b.path)).toEqual([
      'wiki/concepts/Fila de mensagens.md',
    ]);
  });

  it('nota com frontmatter malformado entra pelo texto e é reportada', async () => {
    vault = await openFixture('bad-yaml');
    await scan(vault.index, vault.root, vault.config);
    await writeText(
      vault.root,
      'wiki/concepts/Quebrada.md',
      '---\nid: 01KQQQQQQQQQQQQQQQQQQQQQQQ\ntitle: [sem fechar\n---\n# Quebrada\n\nTexto com a palavra ornitorrinco e [[SQS]].\n',
    );
    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary.added).toBe(1);
    expect(summary.errors).toEqual([
      expect.objectContaining({ path: 'wiki/concepts/Quebrada.md', code: 'invalid_frontmatter' }),
    ]);
    const note = getNote(vault.index, { path: 'wiki/concepts/Quebrada.md' });
    expect(note).toMatchObject({ id: `${PATH_ID_PREFIX}wiki/concepts/Quebrada.md`, title: 'Quebrada', type: null });
    expect(note?.frontmatterError).not.toBeNull();
    expect(searchKeyword(vault.index, { query: 'ornitorrinco' }).hits.map((h) => h.path)).toEqual([
      'wiki/concepts/Quebrada.md',
    ]);
    // o link do corpo vale mesmo com o frontmatter quebrado
    expect(outgoingLinks(vault.index, note?.id ?? '').map((l) => [l.target, l.broken])).toEqual([['SQS', false]]);

    // consertado o frontmatter, a nota ganha o id de verdade sem duplicar
    await writeText(
      vault.root,
      'wiki/concepts/Quebrada.md',
      '---\nid: 01KQQQQQQQQQQQQQQQQQQQQQQQ\ntitle: Consertada\n---\n# Quebrada\n\nTexto com a palavra ornitorrinco e [[SQS]].\n',
    );
    const fixed = await scan(vault.index, vault.root, vault.config);
    expect(fixed).toMatchObject({ updated: 1, errors: [], total: 26 });
    expect(getNote(vault.index, { path: 'wiki/concepts/Quebrada.md' })).toMatchObject({
      id: '01KQQQQQQQQQQQQQQQQQQQQQQQ',
      title: 'Consertada',
    });
    expect(outgoingLinks(vault.index, '01KQQQQQQQQQQQQQQQQQQQQQQQ')).toHaveLength(1);
  });

  it('id repetido (arquivo copiado) não derruba a varredura e se resolve quando a cópia some', async () => {
    vault = await openFixture('dup');
    await scan(vault.index, vault.root, vault.config);
    const text = await readText(vault.root, SQS_DECISION);
    await writeText(vault.root, 'wiki/decisions/copia.md', text.replace('# Usar SQS para filas', '# Cópia'));

    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary.added).toBe(1);
    expect(summary.errors).toEqual([
      expect.objectContaining({ path: 'wiki/decisions/copia.md', code: 'duplicate_id' }),
    ]);
    expect(getNote(vault.index, { id: SQS_DECISION_ID })?.path).toBe(SQS_DECISION);
    expect(getNote(vault.index, { path: 'wiki/decisions/copia.md' })?.id).toBe(
      `${PATH_ID_PREFIX}wiki/decisions/copia.md`,
    );
    // o conflito continua sendo reportado, sem contar como mudança
    const again = await scan(vault.index, vault.root, vault.config);
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 26 });
    expect(again.errors.map((e) => e.code)).toEqual(['duplicate_id']);

    // a original sai; a cópia herda o id
    await rm(abs(vault.root, SQS_DECISION));
    const after = await scan(vault.index, vault.root, vault.config);
    expect(after.errors).toEqual([]);
    expect(getNote(vault.index, { id: SQS_DECISION_ID })?.path).toBe('wiki/decisions/copia.md');
    expect(after.total).toBe(25);
  });

  it('nota arquivada fica no banco, marcada', async () => {
    vault = await openFixture('archive');
    await scan(vault.index, vault.root, vault.config);
    expect(getNote(vault.index, { path: 'memory/_archive/preferencia-usar-tabs.md' })).toMatchObject({
      archived: true,
      type: 'preference',
    });
    // arquivar (mover para _archive) atualiza a marca
    await rename(
      abs(vault.root, 'memory/preferences/respostas-em-portugues.md'),
      abs(vault.root, 'memory/_archive/respostas-em-portugues.md'),
    );
    await scan(vault.index, vault.root, vault.config);
    expect(getNote(vault.index, { id: '01KR2K2ER8WSC66YEXP487Q72D' })).toMatchObject({
      archived: true,
      path: 'memory/_archive/respostas-em-portugues.md',
    });
  });

  it('grava arestas de wikilink, relação, supersedes e fato, e a tabela de fatos', async () => {
    vault = await openFixture('edges');
    await scan(vault.index, vault.root, vault.config);
    const links = outgoingLinks(vault.index, SQS_DECISION_ID);
    const pairs = links.map((l) => `${l.origin}:${l.type}:${l.target}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        'wikilink:sources:raw/meetings/2026-05-03-arquitetura',
        'supersedes:supersedes:usar-rabbitmq-para-filas',
        'relation:uses:SQS',
        'relation:decided_by:Ana Prado',
        'relation:decided_by:Bruno Tavares',
        'relation:part_of:Projeto Atlas',
        'relation:depends_on:Idempotência',
        'wikilink:link:Reunião de arquitetura 2026-05-03',
      ]),
    );
    expect(links.every((l) => !l.broken)).toBe(true);
    expect(links.every((l) => l.origin !== 'relation' || l.type !== 'uses' || l.path === 'wiki/entities/SQS.md')).toBe(
      true,
    );
    // validade da nota vai para as arestas
    const edgeValidity = vault.index.db
      .prepare(`select distinct valid_from, valid_until from edges where src_note = ?`)
      .all('01KN5EJBK8JVN2NCEKEC7KRV93');
    expect(edgeValidity).toEqual([{ valid_from: '2026-01-14', valid_until: '2026-05-03' }]);

    // embed `![[nota#seção]]`
    const synthesis = getNote(vault.index, { path: 'wiki/syntheses/Mensageria no Projeto Atlas.md' });
    expect(outgoingLinks(vault.index, synthesis?.id ?? '').find((l) => l.type === 'embed')).toMatchObject({
      target: 'usar-sqs-para-filas',
      anchor: 'Consequência',
      noteId: SQS_DECISION_ID,
    });

    const facts = vault.index.db
      .prepare(
        `select f.subject, f.predicate, f.object, s.path as subject_path, o.path as object_path, f.valid_from, f.valid_until
         from facts f left join notes s on s.id = f.subject_note left join notes o on o.id = f.object_note
         where f.note_id = ?`,
      )
      .get('01KTZQJHX82Q9ZW0ZF69APQRF1');
    expect(facts).toEqual({
      subject: 'Projeto Atlas',
      predicate: 'uses_queue',
      object: 'SQS',
      subject_path: 'wiki/entities/Projeto Atlas.md',
      object_path: 'wiki/entities/SQS.md',
      valid_from: '2026-05-03',
      valid_until: null,
    });
    expect(
      outgoingLinks(vault.index, '01KTZQJHX82Q9ZW0ZF69APQRF1').map((l) => `${l.origin}:${l.type}:${l.target}`),
    ).toEqual(['fact:subject:Projeto Atlas', 'fact:object:SQS', 'supersedes:supersedes:fato-atlas-usa-rabbitmq']);
  });

  it('relação extra do .cabecao.json vira aresta de relação', async () => {
    vault = await openFixture('extra-relation');
    await writeText(
      vault.root,
      'wiki/entities/Carla.md',
      '---\nid: 01KCCCCCCCCCCCCCCCCCCCCCCC\ntype: entity\ntitle: Carla\nmentored_by: ["[[Ana Prado]]"]\n---\nPessoa.\n',
    );
    await scan(vault.index, vault.root, { ...vault.config, relations: ['mentored_by'] });
    expect(outgoingLinks(vault.index, '01KCCCCCCCCCCCCCCCCCCCCCCC')).toEqual([
      expect.objectContaining({ origin: 'relation', type: 'mentored_by', path: 'wiki/entities/Ana Prado.md' }),
    ]);
  });

  it('reindexFull reconstrói do zero com o mesmo resultado', async () => {
    vault = await openFixture('full');
    await scan(vault.index, vault.root, vault.config);
    const snapshot = (v: OpenVault) =>
      v.index.db
        .prepare(
          `select n.path, n.id, (select count(*) from chunks c where c.note_id = n.id) as chunks,
             (select count(*) from edges e where e.src_note = n.id and e.dst_note is not null) as resolved
           from notes n order by n.path`,
        )
        .all();
    const before = snapshot(vault);
    const summary = await reindexFull(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 25, filesRead: 25, total: 25 });
    expect(snapshot(vault)).toEqual(before);
    expect(vault.index.db.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(count(vault, `select count(*) as n from chunks_fts where chunks_fts match '"idempotente"'`)).toBeGreaterThan(
      0,
    );
  });

  it('cérebro vazio e pasta de notas inexistente não são erro', async () => {
    vault = await openEmptyVault('empty');
    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 0, total: 0, errors: [] });
    expect(searchKeyword(vault.index, { query: 'qualquer coisa' }).hits).toEqual([]);
  });

  it('CRLF e BOM são indexados como LF', async () => {
    vault = await openEmptyVault('crlf');
    await writeText(
      vault.root,
      'wiki/concepts/Windows.md',
      '﻿---\r\nid: 01KWWWWWWWWWWWWWWWWWWWWWWW\r\ntype: concept\r\ntitle: Windows\r\n---\r\n# Windows\r\n\r\nQuebra de linha do Windows com operação.\r\n',
    );
    const summary = await scan(vault.index, vault.root, vault.config);
    expect(summary).toMatchObject({ added: 1, errors: [] });
    const hit = searchKeyword(vault.index, { query: 'operacao' }).hits[0];
    expect(hit?.noteId).toBe('01KWWWWWWWWWWWWWWWWWWWWWWW');
    expect(hit?.snippet).not.toContain('\r');
  });
});
