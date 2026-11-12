// Spike 1: node:sqlite embutido serve como índice? (FTS5, diacríticos, WAL, CTE recursiva)
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
const f = '/tmp/cabecao-spike.db'; rmSync(f, { force: true });
const db = new DatabaseSync(f);
console.log('sqlite', db.prepare('select sqlite_version() v').get().v, '| node', process.version);
console.log('journal', db.prepare('pragma journal_mode=WAL').get());
db.exec(`create virtual table t using fts5(text, heading, tokenize='unicode61 remove_diacritics 2');`);
const ins = db.prepare('insert into t(text, heading) values (?, ?)');
ins.run('A migração para SQS reduziu o custo de operação das filas', 'Decisão › Filas');
ins.run('Receita de bolo de cenoura com cobertura', 'Culinária');
console.log('fts5 sem acento:', db.prepare(`select heading, round(bm25(t),3) s from t where t match 'migracao operacao'`).all());
// volume
db.exec('begin'); const N = 50000;
for (let i = 0; i < N; i++) ins.run(`nota ${i} sobre arquitetura hexagonal filas eventos deploy ${i % 97} postgres ${i % 13}`, `Seção ${i % 500}`);
db.exec('commit');
let t0 = performance.now();
const r = db.prepare(`select rowid from t where t match 'hexagonal postgres' order by bm25(t) limit 50`).all();
console.log(`bm25 em ${N} trechos: ${(performance.now() - t0).toFixed(1)}ms, ${r.length} hits`);
db.exec('create table edges(src int, dst int); create index e1 on edges(src);');
const ie = db.prepare('insert into edges values (?,?)'); db.exec('begin');
for (let i = 0; i < 100000; i++) ie.run(i % 20000, (i * 7919) % 20000); db.exec('commit');
t0 = performance.now();
const g = db.prepare(`with recursive w(n,d) as (select 1,0 union select e.dst, w.d+1 from edges e join w on e.src=w.n where w.d<2) select count(distinct n) c from w`).get();
console.log(`grafo 2 saltos (100k arestas): ${(performance.now() - t0).toFixed(1)}ms, ${g.c} nós`);
