// Exportação do grafo para a branch de índice (doc 03, "Branch de índice": `graph/nodes.jsonl` e `edges.jsonl`).
// Só a função pura: a gravação na branch é do marco 2. A saída é idêntica byte a byte em qualquer máquina para o
// mesmo cérebro: ordem estável (comparação por unidade de código, nunca pela localidade), campos sempre na mesma
// ordem, nada que dependa da máquina (sem datas de geração, de modificação ou de indexação, sem hash do arquivo, que
// muda com a conversão de fim de linha do git, e sem cópias de conflito, cujo nome traz a máquina).
import type { LocalIndex } from './open.ts';
import { connection } from './open.ts';

export interface GraphExport {
  /** Uma nota por linha, ordenadas pelo id. Termina com `\n` (vazio se não houver notas). */
  readonly nodes: string;
  /** Uma aresta resolvida por linha, ordenadas por origem, destino, tipo de origem, tipo e alvo, sem repetição. */
  readonly edges: string;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const jsonl = (lines: readonly string[]): string => (lines.length === 0 ? '' : `${lines.join('\n')}\n`);

/** Gera `nodes.jsonl` e `edges.jsonl` a partir do banco. Não grava nada. */
export function exportGraph(index: LocalIndex): GraphExport {
  const db = connection(index);
  const nodes = db
    .prepare(
      `select id, path, type, title, scope, valid_from, valid_until, archived from notes where conflict_of is null`,
    )
    .all()
    .map((row) => ({
      id: String(row.id),
      path: String(row.path),
      type: text(row.type),
      title: text(row.title),
      scope: text(row.scope),
      valid_from: text(row.valid_from),
      valid_until: text(row.valid_until),
      archived: Number(row.archived) === 1,
    }))
    .sort((a, b) => compare(a.id, b.id));

  const seen = new Set<string>();
  const edges = db
    .prepare(
      `select e.src_note, e.dst_note, e.origin, e.type, e.target
       from edges e join notes s on s.id = e.src_note join notes d on d.id = e.dst_note
       where s.conflict_of is null and d.conflict_of is null`,
    )
    .all()
    .map((row) => ({
      src: String(row.src_note),
      dst: String(row.dst_note),
      origin: String(row.origin),
      type: String(row.type),
      target: String(row.target),
    }))
    .sort(
      (a, b) =>
        compare(a.src, b.src) ||
        compare(a.dst, b.dst) ||
        compare(a.origin, b.origin) ||
        compare(a.type, b.type) ||
        compare(a.target, b.target),
    )
    .map((edge) => JSON.stringify(edge))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });

  return { nodes: jsonl(nodes.map((node) => JSON.stringify(node))), edges: jsonl(edges) };
}
