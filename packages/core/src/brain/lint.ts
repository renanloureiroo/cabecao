// `lint` (doc 05; doc 07, "Rotinas"; marco 4): relatório de saúde do cérebro por REGRAS, sem LLM e só de leitura.
// Cada achado traz a regra, a severidade, o caminho (e a linha, quando há), o que está errado e a correção sugerida.
// O que é texto de nota (títulos, nomes citados) vai como dado, dentro do envelope.
import type { IndexedNote } from '../db/index.ts';
import { brokenLinks, listNotes, nameKey, queryFacts, validityOf } from '../db/index.ts';
import { connection } from '../db/open.ts';
import type { ConflictCopy } from '../sync/index.ts';
import { listConflicts } from '../sync/index.ts';
import { validateNote } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { today, withFreshIndex } from './context.ts';
import type { DataEnvelope } from './envelope.ts';
import { DATA_NOTICE } from './envelope.ts';
import { scopesFor } from './read.ts';
import { invalid } from './write.ts';

/** As regras, na ordem do relatório. */
export const LINT_RULES = [
  'invalid_frontmatter',
  'fact_contradiction',
  'conflict_copy',
  'broken_link',
  'expired_note',
  'unconfirmed_memory',
  'unlinked_mention',
  'orphan_note',
] as const;
export type LintRule = (typeof LINT_RULES)[number];
export type LintSeverity = 'error' | 'warning' | 'info';

/** Dias sem confirmação (e sem atualização) a partir dos quais uma memória entra no relatório. */
export const UNCONFIRMED_AFTER_DAYS = 180;
/** Tipos de memória que pedem confirmação do usuário de tempos em tempos (fatos têm data de validade; não pedem). */
export const CONFIRMABLE_TYPES = ['preference', 'gotcha', 'procedure'] as const;
export const DEFAULT_LINT_LIMIT = 200;
export const MAX_LINT_LIMIT = 1000;

export interface LintFinding {
  readonly rule: LintRule;
  readonly severity: LintSeverity;
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
  /** A correção sugerida, em português. */
  readonly fix: string;
  /** Outras notas envolvidas (o outro fato da contradição, a nota citada, a original da cópia). */
  readonly related: readonly string[];
}

export interface LintInput {
  /** Só estas regras. Padrão: todas. */
  readonly rules?: readonly string[];
  /** `project:<slug>` (inclui o global) ou `global`. Notas sem escopo (fatos) entram sempre. */
  readonly scope?: string;
  /** Máximo de achados no relatório (padrão 200, máximo 1000). */
  readonly limit?: number;
}

export interface LintOutput extends DataEnvelope {
  readonly findings: readonly LintFinding[];
  /** Achados por severidade, antes do corte de `limit`. */
  readonly counts: { readonly error: number; readonly warning: number; readonly info: number };
  /** Achados por regra, antes do corte. */
  readonly by_rule: Readonly<Record<string, number>>;
  readonly checked_notes: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly next_step?: string;
}

const SEVERITY_ORDER: Readonly<Record<LintSeverity, number>> = { error: 0, warning: 1, info: 2 };
const RAW_PREFIX = 'raw/';

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 86_400_000);
}

/** As regras pedidas, conferidas. */
function rulesOf(value: unknown): Set<LintRule> {
  if (value === undefined || value === null) return new Set(LINT_RULES);
  if (!Array.isArray(value) || !value.every((rule) => (LINT_RULES as readonly unknown[]).includes(rule))) {
    throw invalid(`"rules" deveria ser uma lista com algumas destas regras: ${LINT_RULES.join(', ')}`);
  }
  return new Set(value as LintRule[]);
}

export async function lint(ctx: BrainContext, input: LintInput = {}): Promise<LintOutput> {
  const rules = rulesOf(input?.rules);
  const scopes = scopesFor(input?.scope);
  const limit = input?.limit ?? DEFAULT_LINT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LINT_LIMIT) {
    throw invalid(`"limit" deveria ser um inteiro de 1 a ${MAX_LINT_LIMIT}`);
  }
  const day = today(ctx);
  const inScope = (note: Pick<IndexedNote, 'scope'>): boolean =>
    scopes === undefined || note.scope === null || scopes.includes(note.scope);

  let conflicts: ConflictCopy[] = [];
  if (rules.has('conflict_copy')) {
    try {
      conflicts = await listConflicts(ctx.root);
    } catch {
      conflicts = []; // sem git legível, o status já avisa
    }
  }

  const { findings, checked } = await withFreshIndex(ctx, () => {
    const out: LintFinding[] = [];
    const db = connection(ctx.index);
    const notes = listNotes(ctx.index, { orderBy: 'path' }).filter(inScope);
    const byId = new Map(notes.map((note) => [note.id, note]));

    if (rules.has('invalid_frontmatter')) {
      for (const note of notes) {
        if (note.path.startsWith(RAW_PREFIX) && !note.managed) continue;
        if (note.frontmatterError !== null) {
          out.push({
            rule: 'invalid_frontmatter',
            severity: 'error',
            path: note.path,
            line: null,
            message: `o frontmatter não pôde ser lido: ${note.frontmatterError}`,
            fix: 'Corrija o YAML do frontmatter no Obsidian ou num editor (o Cabeção não altera uma nota com frontmatter ilegível).',
            related: [],
          });
          continue;
        }
        for (const issue of validateNote({ frontmatter: note.frontmatter, path: note.path }, ctx.config)) {
          if (issue.severity !== 'error') continue;
          out.push({
            rule: 'invalid_frontmatter',
            severity: 'error',
            path: note.path,
            line: null,
            message: issue.message,
            fix: issue.field === null ? 'Corrija o frontmatter da nota.' : `Corrija o campo "${issue.field}".`,
            related: [],
          });
        }
      }
    }

    if (rules.has('fact_contradiction')) {
      const groups = new Map<string, { path: string; object: string; validFrom: string }[]>();
      for (const fact of queryFacts(ctx.index, { asOf: day })) {
        if (fact.validity !== 'current' || fact.predicate === null) continue;
        const subject = fact.subjectNote?.id ?? nameKey(fact.subject ?? '');
        const key = `${subject}\u0000${fact.predicate}`;
        const object = fact.objectNote?.id ?? nameKey(fact.object ?? '');
        const list = groups.get(key) ?? [];
        list.push({ path: fact.path, object, validFrom: fact.validFrom ?? '' });
        groups.set(key, list);
      }
      for (const list of groups.values()) {
        if (new Set(list.map((item) => item.object)).size < 2) continue;
        // o mais antigo é o candidato a substituir
        const sorted = [...list].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
        const [oldest, ...others] = sorted;
        if (oldest === undefined) continue;
        out.push({
          rule: 'fact_contradiction',
          severity: 'warning',
          path: oldest.path,
          line: null,
          message: `fatos vigentes com o mesmo sujeito e predicado e objetos diferentes (${list.length})`,
          fix: 'Se o mais novo vale, substitua o antigo: remember do fato com resolution "supersede:<id do antigo>" (a antiga ganha valid_until e superseded_by). Se o predicado aceita vários valores ao mesmo tempo, ignore.',
          related: others.map((item) => item.path),
        });
      }
    }

    if (rules.has('broken_link')) {
      for (const link of brokenLinks(ctx.index)) {
        const note = byId.get(link.noteId);
        // fontes de raw/ são imutáveis: link quebrado ou menção nelas não é pendência
        if (note === undefined || note.path.startsWith(RAW_PREFIX)) continue;
        out.push({
          rule: 'broken_link',
          severity: 'warning',
          path: link.path,
          line: link.line,
          message: `link para uma nota que não existe: [[${link.target}]]${link.type === 'link' ? '' : ` (${link.type})`}`,
          fix: `Corrija o link (patch_page) para uma nota que existe, ou crie a nota "${link.target}".`,
          related: [],
        });
      }
    }

    if (rules.has('expired_note')) {
      for (const note of notes) {
        if (note.archived || note.conflictOf !== null || note.path.startsWith(RAW_PREFIX)) continue;
        const ended = (value: string | null): boolean => value !== null && value.slice(0, 10) <= day;
        // o que outra nota substituiu é histórico, não pendência
        if (ended(note.supersededOn)) continue;
        if (!ended(note.validUntil) && !ended(note.expiresAt)) continue;
        const when = ended(note.expiresAt) ? `expires_at ${note.expiresAt}` : `valid_until ${note.validUntil}`;
        out.push({
          rule: 'expired_note',
          severity: 'info',
          path: note.path,
          line: null,
          message: `${note.type ?? 'nota'} vencida (${when}); a busca já a rebaixa`,
          fix: 'Se não vale mais nada, arquive com forget (vai para memory/_archive/ e continua no git).',
          related: [],
        });
      }
    }

    if (rules.has('unconfirmed_memory')) {
      for (const note of notes) {
        if (!(CONFIRMABLE_TYPES as readonly (string | null)[]).includes(note.type)) continue;
        if (note.confirmed !== null || note.archived || validityOf(note, day) !== 'current') continue;
        const last = note.updated ?? note.created;
        if (last === null || daysBetween(last, day) < UNCONFIRMED_AFTER_DAYS) continue;
        out.push({
          rule: 'unconfirmed_memory',
          severity: 'info',
          path: note.path,
          line: null,
          message: `${note.type} sem confirmação e sem atualização há ${daysBetween(last, day)} dias (desde ${last.slice(0, 10)})`,
          fix: 'Pergunte ao usuário se ainda vale: se sim, ele grava "confirmed" com a data de hoje; se não, arquive com forget.',
          related: [],
        });
      }
    }

    if (rules.has('unlinked_mention')) {
      const rows = db
        .prepare(
          `select s.path, s.scope, e.target, e.line, d.path as dst_path
           from edges e join notes s on s.id = e.src_note join notes d on d.id = e.dst_note
           where e.origin = 'mention' and s.archived = 0 and s.conflict_of is null and s.path not like 'raw/%'
           order by s.path, e.line`,
        )
        .all();
      for (const row of rows) {
        const scope = row.scope === null ? null : String(row.scope);
        if (!inScope({ scope })) continue;
        const line = row.line === null ? null : Number(row.line);
        const name = String(row.target);
        const stem = String(row.dst_path).replace(/\.md$/i, '').split('/').at(-1) ?? '';
        const link = stem.toLowerCase() === name.toLowerCase() ? `[[${stem}]]` : `[[${stem}|${name}]]`;
        out.push({
          rule: 'unlinked_mention',
          severity: 'info',
          path: String(row.path),
          line,
          message: `"${name}" é citado sem link`,
          fix: `Troque o nome por um link para a nota (patch_page: "${name}" → "${link}"), se for mesmo ela.`,
          related: [String(row.dst_path)],
        });
      }
    }

    if (rules.has('orphan_note')) {
      const rows = db
        .prepare(
          `select n.id from notes n
           where n.managed = 1 and n.archived = 0 and n.conflict_of is null and n.path not like 'raw/%'
             and coalesce(n.type, '') not in ('handoff', 'episode', 'rule')
             and not exists (select 1 from edges e where e.src_note = n.id and e.origin <> 'mention' and e.dst_note is not null)
             and not exists (select 1 from edges e where e.dst_note = n.id and e.origin <> 'mention' and e.src_note <> n.id)
           order by n.path`,
        )
        .all();
      for (const row of rows) {
        const note = byId.get(String(row.id));
        if (note === undefined) continue;
        out.push({
          rule: 'orphan_note',
          severity: 'info',
          path: note.path,
          line: null,
          message: 'nota sem nenhum link de entrada nem de saída',
          fix: 'Ligue a nota ao que ela trata (relate ou um [[link]] no texto), ou arquive com forget se não serve mais.',
          related: [],
        });
      }
    }
    return { findings: out, checked: notes.length };
  });

  if (rules.has('conflict_copy')) {
    for (const conflict of conflicts) {
      findings.push({
        rule: 'conflict_copy',
        severity: 'warning',
        path: conflict.copy,
        line: null,
        message: `cópia de conflito do sync (máquina ${conflict.machine}, ${conflict.date})${conflict.originalExists ? '' : '; a nota original não existe mais'}`,
        fix: 'Compare com a nota original, junte nela o que importa e apague a cópia (quem apaga é o usuário).',
        related: [conflict.original],
      });
    }
  }

  const ruleOrder = new Map(LINT_RULES.map((rule, i) => [rule, i]));
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (ruleOrder.get(a.rule) ?? 0) - (ruleOrder.get(b.rule) ?? 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0)),
  );
  const counts = { error: 0, warning: 0, info: 0 };
  const byRule: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.severity]++;
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  }
  const shown = findings.slice(0, limit);
  return {
    data_notice: DATA_NOTICE,
    findings: shown,
    counts,
    by_rule: byRule,
    checked_notes: checked,
    total: findings.length,
    truncated: shown.length < findings.length,
    ...(findings.length === 0
      ? {}
      : {
          next_step:
            'Corrija o que for seguro (links quebrados, menções sem link, fatos substituídos) e pergunte ao usuário sobre o resto (memórias sem confirmação, vencidas, cópias de conflito). O lint só lê; nada foi alterado.',
        }),
  };
}
