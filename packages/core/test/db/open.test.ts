import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filterSqliteWarning,
  getIndexState,
  INDEX_SCHEMA_VERSION,
  indexDbPath,
  indexStatus,
  installSqliteWarningFilter,
  isSqliteExperimentalWarning,
  loadSqlite,
  openIndex,
  STATE_KEYS,
  scan,
  searchKeyword,
  setIndexState,
  sqliteFilePath,
  WINDOWS_LONG_PATH_THRESHOLD,
} from '../../src/db/index.ts';
import type { TempVault } from '../vault/helpers.ts';
import { makeTempDir } from '../vault/helpers.ts';
import type { OpenVault } from './helpers.ts';
import { openFixture } from './helpers.ts';

let vault: OpenVault | undefined;
let temp: TempVault | undefined;
afterEach(async () => {
  await vault?.cleanup();
  await temp?.cleanup();
  vault = undefined;
  temp = undefined;
});

const pragma = (v: OpenVault, name: string): unknown =>
  Object.values(v.index.db.prepare(`pragma ${name}`).get() ?? {})[0];

describe('openIndex', () => {
  it('cria .cabecao/cabecao.db em WAL, com espera em trava e chaves estrangeiras', async () => {
    vault = await openFixture('open');
    expect(vault.index.dbPath).toBe(indexDbPath(vault.root));
    expect(vault.index.dbPath).toBe(join(vault.root, '.cabecao', 'cabecao.db'));
    expect(existsSync(vault.index.dbPath)).toBe(true);
    expect(vault.index.rebuilt).toBe('created');
    expect(pragma(vault, 'journal_mode')).toBe('wal');
    expect(pragma(vault, 'foreign_keys')).toBe(1);
    expect(Number(pragma(vault, 'busy_timeout'))).toBeGreaterThan(0);
    expect(getIndexState(vault.index, STATE_KEYS.schemaVersion)).toBe(String(INDEX_SCHEMA_VERSION));
    const tables = vault.index.db
      .prepare(`select name from sqlite_master where type = 'table' and name not like 'chunks_fts_%' order by name`)
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(['chunks', 'chunks_fts', 'edges', 'facts', 'notes', 'state']);
    const fts = vault.index.db.prepare(`select sql from sqlite_master where name = 'chunks_fts'`).get();
    expect(String(fts?.sql)).toContain(`tokenize='unicode61 remove_diacritics 2'`);
  });

  it('reabrir não refaz nada; versão de esquema diferente refaz o banco vazio', async () => {
    vault = await openFixture('reopen');
    await scan(vault.index, vault.root, vault.config);
    vault.index.close();
    let index = await openIndex(vault.root);
    expect(index.rebuilt).toBeNull();
    expect(indexStatus(index).notes).toBe(25);

    setIndexState(index, STATE_KEYS.schemaVersion, String(INDEX_SCHEMA_VERSION + 100));
    index.close();
    index = await openIndex(vault.root);
    try {
      expect(index.rebuilt).toBe('schema_changed');
      expect(indexStatus(index)).toMatchObject({ notes: 0, schemaVersion: INDEX_SCHEMA_VERSION });
      const summary = await scan(index, vault.root, vault.config);
      expect(summary.added).toBe(25);
    } finally {
      index.close();
    }
  });

  it('arquivo corrompido é apagado e recriado', async () => {
    temp = await makeTempDir('db-corrupt');
    await writeFile(join(temp.root, '.cabecao.json'), '{"schemaVersion":1,"noteDirs":["wiki"],"indexMd":"index.md"}');
    await mkdir(join(temp.root, '.cabecao'), { recursive: true });
    await writeFile(indexDbPath(temp.root), 'isto não é um banco SQLite '.repeat(400));
    await mkdir(join(temp.root, 'wiki'));
    await writeFile(join(temp.root, 'wiki', 'Nota.md'), '# Nota\n\nTexto sobre capivaras.\n');
    const index = await openIndex(temp.root);
    try {
      expect(index.rebuilt).toBe('corrupt');
      const summary = await scan(index, temp.root, { noteDirs: ['wiki'], indexMd: 'index.md' });
      expect(summary.added).toBe(1);
      expect(searchKeyword(index, { query: 'capivaras' }).hits).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  it('close() libera o banco e os arquivos -wal e -shm', async () => {
    vault = await openFixture('close');
    await scan(vault.index, vault.root, vault.config);
    expect(existsSync(`${vault.index.dbPath}-wal`)).toBe(true);
    vault.index.close();
    vault.index.close(); // de novo: sem erro
    expect(vault.index.closed).toBe(true);
    expect(existsSync(`${vault.index.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${vault.index.dbPath}-shm`)).toBe(false);
    expect(() => searchKeyword(vault?.index as never, { query: 'sqs' })).toThrow(/fechado/);
  });

  it('abre em caminho com acento e espaço', async () => {
    temp = await makeTempDir('db-acento');
    const dbPath = join(temp.root, 'Segundo Cérebro', 'Anotações & ideias (ção)', 'índice do cérebro.db');
    const index = await openIndex(temp.root, { dbPath });
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(index.rebuilt).toBe('created');
    } finally {
      index.close();
    }
  });

  it('dois índices no mesmo processo varrendo juntos não duplicam', async () => {
    vault = await openFixture('same-process');
    const other = await openIndex(vault.root);
    try {
      const [a, b] = await Promise.all([
        scan(vault.index, vault.root, vault.config),
        scan(other, vault.root, vault.config),
      ]);
      expect(a.added + b.added).toBe(25);
      expect(indexStatus(other).notes).toBe(25);
    } finally {
      other.close();
    }
  });
});

describe('node:sqlite', () => {
  it('tem FTS5 com remoção de acentos', () => {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`create virtual table t using fts5(x, tokenize='unicode61 remove_diacritics 2')`);
      db.prepare('insert into t(x) values (?)').run('Migração da operação');
      expect(db.prepare(`select count(*) as n from t where t match '"migracao" AND "OPERACAO"'`).get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  it('o filtro descarta só o ExperimentalWarning do SQLite', () => {
    const seen: unknown[][] = [];
    const emit = filterSqliteWarning(((...args: unknown[]) => {
      seen.push(args);
    }) as typeof process.emitWarning);
    emit('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    emit('SQLite is an experimental feature', { type: 'ExperimentalWarning' });
    emit('Outra coisa experimental', 'ExperimentalWarning');
    emit('SQLite deprecated thing', 'DeprecationWarning');
    expect(seen).toEqual([
      ['Outra coisa experimental', 'ExperimentalWarning'],
      ['SQLite deprecated thing', 'DeprecationWarning'],
    ]);
  });

  it('o filtro é instalado uma vez só, e o banco abre com ele', async () => {
    vault = await openFixture('filter');
    const installed = process.emitWarning;
    installSqliteWarningFilter();
    expect(process.emitWarning).toBe(installed);
  });

  it('reconhece o aviso em suas formas', () => {
    const warning = Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' });
    expect(isSqliteExperimentalWarning(warning)).toBe(true);
    expect(isSqliteExperimentalWarning('SQLite is experimental', 'ExperimentalWarning')).toBe(true);
    expect(isSqliteExperimentalWarning('SQLite is experimental', 'Warning')).toBe(false);
    expect(isSqliteExperimentalWarning('Type Stripping is experimental', 'ExperimentalWarning')).toBe(false);
  });

  it('caminho longo no Windows ganha o prefixo \\\\?\\', () => {
    const short = 'C:\\Users\\ana\\cerebro\\.cabecao\\cabecao.db';
    expect(sqliteFilePath(short, 'win32')).toBe(short);
    const long = `C:\\Users\\ana\\${'pasta-comprida\\'.repeat(20)}.cabecao\\cabecao.db`;
    expect(long.length).toBeGreaterThan(WINDOWS_LONG_PATH_THRESHOLD);
    expect(sqliteFilePath(long, 'win32')).toBe(`\\\\?\\${long}`);
    expect(sqliteFilePath(`\\\\?\\${long}`, 'win32')).toBe(`\\\\?\\${long}`);
    const unc = `\\\\servidor\\compartilhado\\${'pasta-comprida\\'.repeat(20)}cabecao.db`;
    expect(sqliteFilePath(unc, 'win32')).toBe(`\\\\?\\UNC\\${unc.slice(2)}`);
    // barras normais e `..` são resolvidos antes do prefixo (com `\\?\` o Windows não normaliza mais nada)
    const mixed = `C:/Users/ana/${'pasta-comprida/'.repeat(20)}x/../cabecao.db`;
    expect(sqliteFilePath(mixed, 'win32')).toBe(`\\\\?\\C:\\Users\\ana\\${'pasta-comprida\\'.repeat(20)}cabecao.db`);
    const posix = `/home/ana/${'pasta-comprida/'.repeat(20)}cabecao.db`;
    expect(sqliteFilePath(posix, 'linux')).toBe(posix);
  });
});
