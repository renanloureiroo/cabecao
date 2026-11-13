// Esquema do banco local (docs/03-modelo-de-dados.md, "Banco local"). O banco é uma visão materializada do
// Markdown: apagar e refazer é sempre seguro, então mudança de esquema é reconstrução, nunca migração.
import type { DatabaseSync } from './sqlite.ts';

/**
 * Versão do esquema DESTE banco (não confundir com o `schemaVersion` do `.cabecao.json`). Qualquer mudança nas
 * tabelas abaixo, ou no que a varredura grava nelas, sobe este número; o banco é refeito na próxima abertura.
 */
export const INDEX_SCHEMA_VERSION = 3;

/** Chaves conhecidas da tabela `state`. */
export const STATE_KEYS = {
  schemaVersion: 'schema_version',
  /** Instante (ISO 8601, UTC) do fim da última varredura. */
  lastScanAt: 'last_scan_at',
  /** Duração da última varredura, em ms. */
  lastScanMs: 'last_scan_ms',
  /** Último commit de conteúdo indexado (gravado pelo sync). */
  lastIndexedCommit: 'last_indexed_commit',
} as const;

// Datas ficam como texto ISO (`AAAA-MM-DD`, ou com hora), do jeito que estão no frontmatter: comparar texto ISO
// é comparar datas. `frontmatter` é o JSON do frontmatter inteiro. `conflict_of` marca uma cópia de conflito do
// sync (`nota.conflict-<máquina>-<data>.md`) com o caminho da nota original: a cópia nunca recebe o `id` da
// original (fica com o id derivado do caminho) e as consultas a deixam de fora, a não ser que peçam.
const DDL = `
create table notes(
  id text primary key,
  path text not null unique,
  type text,
  title text,
  scope text,
  trust text,
  origin text,
  created text,
  updated text,
  confirmed text,
  valid_from text,
  valid_until text,
  expires_at text,
  content_hash text not null,
  mtime real not null,
  size integer not null,
  frontmatter text not null default '{}',
  frontmatter_error text,
  managed integer not null default 0,
  title_derived integer not null default 0,
  archived integer not null default 0,
  conflict_of text,
  superseded_on text,
  indexed_at text not null
);
create index notes_type on notes(type, scope);

create table chunks(
  id integer primary key,
  note_id text not null references notes(id) on delete cascade on update cascade,
  ord integer not null,
  heading_path text not null,
  title_path text not null,
  text text not null,
  token_count integer not null,
  chunk_key text not null,
  start_line integer,
  end_line integer
);
create index chunks_note on chunks(note_id, ord);
create index chunks_key on chunks(chunk_key);

create virtual table chunks_fts using fts5(
  text, title_path,
  content='chunks', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
create trigger chunks_ai after insert on chunks begin
  insert into chunks_fts(rowid, text, title_path) values (new.id, new.text, new.title_path);
end;
create trigger chunks_ad after delete on chunks begin
  insert into chunks_fts(chunks_fts, rowid, text, title_path) values ('delete', old.id, old.text, old.title_path);
end;
create trigger chunks_au after update of text, title_path on chunks begin
  insert into chunks_fts(chunks_fts, rowid, text, title_path) values ('delete', old.id, old.text, old.title_path);
  insert into chunks_fts(rowid, text, title_path) values (new.id, new.text, new.title_path);
end;

create table edges(
  id integer primary key,
  src_note text not null references notes(id) on delete cascade on update cascade,
  dst_note text references notes(id) on delete set null on update cascade,
  type text not null,
  origin text not null,
  target text not null,
  target_key text not null,
  anchor text,
  alias text,
  line integer,
  valid_from text,
  valid_until text
);
create index edges_src on edges(src_note);
create index edges_dst on edges(dst_note);
create index edges_target on edges(target_key);

create table facts(
  note_id text primary key references notes(id) on delete cascade on update cascade,
  subject text,
  predicate text,
  object text,
  subject_note text references notes(id) on delete set null on update cascade,
  object_note text references notes(id) on delete set null on update cascade,
  valid_from text,
  valid_until text
);
create index facts_subject on facts(subject_note);
create index facts_object on facts(object_note);
create index facts_predicate on facts(predicate);

-- Nomes de cada nota (título e \`aliases\`), com a chave normalizada de \`nameKey\` (minúsculas, sem acento, palavras
-- separadas por um espaço): a resolução de uma nota pelo título e o dicionário das menções (marco 3) leem daqui.
create table names(
  note_id text not null references notes(id) on delete cascade on update cascade,
  name text not null,
  key text not null,
  kind text not null
);
create index names_key on names(key);
create index names_note on names(note_id);

-- Dicionário das menções em uso (chave → nota), gravado no fim de cada varredura: a próxima compara o dicionário
-- novo com este e só reprocessa as notas que podem ter mudado.
create table mention_keys(key text primary key, note_id text not null, name text not null);

create table state(key text primary key, value text);
`;

/** Cria as tabelas num banco vazio e grava a versão. Chamar dentro de uma transação. */
export function createSchema(db: DatabaseSync): void {
  db.exec(DDL);
  db.prepare('insert into state(key, value) values (?, ?)').run(STATE_KEYS.schemaVersion, String(INDEX_SCHEMA_VERSION));
}

/**
 * Apaga tudo o que existe no banco (tabelas, índices, gatilhos, tabelas FTS). Chamar dentro de uma transação e com
 * `foreign_keys` desligado, para o `drop` não disparar cascatas linha a linha.
 */
export function dropEverything(db: DatabaseSync): void {
  const objects = (type: string): string[] =>
    db
      .prepare(`select name from sqlite_master where type = ? and name not like 'sqlite_%'`)
      .all(type)
      .map((row) => String(row.name));
  const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  for (const name of objects('trigger')) db.exec(`drop trigger if exists ${quote(name)}`);
  for (const name of objects('view')) db.exec(`drop view if exists ${quote(name)}`);
  // tabelas virtuais primeiro: elas levam junto as tabelas-sombra (`chunks_fts_data`...)
  const virtuals = db
    .prepare(`select name from sqlite_master where type = 'table' and sql like 'create virtual table%'`)
    .all()
    .map((row) => String(row.name));
  for (const name of virtuals) db.exec(`drop table if exists ${quote(name)}`);
  for (const name of objects('table')) db.exec(`drop table if exists ${quote(name)}`);
}

/** Versão gravada no banco, `null` se o banco é novo (sem a tabela `state`) ou a versão não está lá. */
export function readSchemaVersion(db: DatabaseSync): number | null {
  const table = db.prepare(`select 1 from sqlite_master where type = 'table' and name = 'state'`).get();
  if (table === undefined) return null;
  const row = db.prepare('select value from state where key = ?').get(STATE_KEYS.schemaVersion);
  const value = Number(row?.value);
  return Number.isInteger(value) ? value : null;
}

/** Verdadeiro se o banco não tem nenhuma tabela (arquivo recém-criado). */
export function isEmptyDatabase(db: DatabaseSync): boolean {
  return db.prepare(`select 1 from sqlite_master where name not like 'sqlite_%' limit 1`).get() === undefined;
}
