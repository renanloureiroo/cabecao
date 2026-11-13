// `relate` (doc 05, marco 3): acrescenta uma relação tipada no frontmatter de uma nota, uma propriedade por relação
// com uma lista de wikilinks (ADR 27). Passa pelo mesmo fluxo de escrita das outras tools (`executeWrite`:
// validação, scanner de segredos, gravação atômica, banco, um commit com os rodapés) e pelas mesmas restrições de
// agente (`existingNote`: nada de regra, arquivo de controle, arquivo de instrução, cópia de conflito nem `raw/`;
// numa nota que não é de agente, `edited_by` e `trust` rebaixado).
//
// Idempotente: se a relação já existe (um link na lista que resolve para a mesma nota), nada é gravado.
import type { IndexedNote } from '../db/index.ts';
import { stripWikilink } from '../db/index.ts';
import { connection } from '../db/open.ts';
import {
  buildLinkIndex,
  isWikilinkText,
  linkListFields,
  localDate,
  resolveWikiLink,
  updateNote,
} from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { withFreshIndex } from './context.ts';
import type { IssueOutput } from './errors.ts';
import { BrainError } from './errors.ts';
import { requireRef, resolveOrThrow } from './graph.ts';
import type { WriteOutput } from './write.ts';
import {
  agentEditProvenance,
  assertAgentText,
  checkUpdate,
  executeWrite,
  existingNote,
  frontmatterTargets,
  invalid,
} from './write.ts';

export interface RelateInput {
  /** Nota que ganha a relação: título, caminho, wikilink ou id. */
  readonly from: string;
  /** Tipo da relação: `uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to`, `supersedes`,
   * `superseded_by` ou uma relação do `.cabecao.json`. */
  readonly type: string;
  /** Nota de destino: título, caminho, wikilink ou id. Tem de existir. */
  readonly to: string;
  readonly session_handle?: string;
}

export interface RelateOutput extends WriteOutput {
  readonly relation: {
    /** Caminho da nota que recebeu a relação. */
    readonly from: string;
    readonly type: string;
    /** Caminho da nota de destino. */
    readonly to: string;
    /** O wikilink gravado (ou o que já estava). */
    readonly link: string;
  };
}

const RELATION_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Caracteres que quebram um wikilink. */
const LINK_UNSAFE_RE = /[[\]|#^\n]/;

/** Wikilink mais curto que, escrito em `fromPath`, resolve para `to`: o nome do arquivo, senão o caminho sem `.md`. */
function linkFor(paths: readonly string[], fromPath: string, to: IndexedNote): string {
  const index = buildLinkIndex(paths);
  const withoutExt = to.path.replace(/\.md$/i, '');
  const stem = withoutExt.slice(withoutExt.lastIndexOf('/') + 1);
  if (!LINK_UNSAFE_RE.test(stem) && resolveWikiLink(index, stem, fromPath).path === to.path) return `[[${stem}]]`;
  if (!LINK_UNSAFE_RE.test(withoutExt) && resolveWikiLink(index, withoutExt, fromPath).path === to.path) {
    return `[[${withoutExt}]]`;
  }
  throw invalid(
    `o nome de ${to.path} não serve de wikilink (tem [, ], |, # ou ^)`,
    'Renomeie a nota de destino ou grave a relação à mão.',
  );
}

export async function relate(ctx: BrainContext, input: RelateInput): Promise<RelateOutput> {
  if (typeof input !== 'object' || input === null) throw invalid('relate precisa de um objeto com from, type e to');
  const fromRef = requireRef(input.from, 'from');
  const toRef = requireRef(input.to, 'to');
  if (typeof input.type !== 'string' || !RELATION_NAME_RE.test(input.type)) {
    throw invalid('"type" deveria ser o nome de uma relação, como "uses" ou "part_of"');
  }
  const type = input.type;
  assertAgentText(ctx, fromRef, '"from"', 'path');
  assertAgentText(ctx, toRef, '"to"', 'path');

  let relation: RelateOutput['relation'] | null = null;
  const output = await executeWrite(ctx, input.session_handle, async (config) => {
    const allowed = linkListFields(config);
    if (!allowed.includes(type)) {
      throw invalid(
        `relação desconhecida: ${JSON.stringify(type)}; as relações são: ${allowed.join(', ')}`,
        'Use uma das relações listadas; o usuário acrescenta outras no .cabecao.json ("relations").',
      );
    }
    const { from, to, paths } = await withFreshIndex(ctx, () => ({
      from: resolveOrThrow(ctx, fromRef, 'from').note,
      to: resolveOrThrow(ctx, toRef, 'to').note,
      paths: connection(ctx.index)
        .prepare('select path from notes where conflict_of is null')
        .all()
        .map((row) => String(row.path)),
    }));
    if (from.id === to.id) throw invalid('"from" e "to" são a mesma nota; uma nota não se relaciona com ela mesma');
    if (to.conflictOf !== null) {
      throw invalid(`${to.path} é uma cópia de conflito do sync; relacione com a nota original (${to.conflictOf})`);
    }
    // as restrições de agente (regra, controle, instrução, conflito, raw/) e a releitura do disco
    const read = await existingNote(ctx, from.path);
    const before = read.note.frontmatter;
    const current = before[type];
    if (current !== undefined && current !== null && current !== '' && !Array.isArray(current)) {
      throw new BrainError('invalid_note', `"${type}" em ${read.path} não é uma lista de wikilinks`, {
        details: { path: read.path },
        nextStep: 'Peça ao usuário para corrigir o campo (deveria ser uma lista, como ["[[Nota]]"]).',
      });
    }
    const list = Array.isArray(current) ? (current as unknown[]) : [];
    const index = buildLinkIndex(paths);
    const existing = list.find((item) => {
      if (typeof item !== 'string' || !isWikilinkText(item)) return false;
      return resolveWikiLink(index, stripWikilink(item), read.path).path === to.path;
    });
    const link = typeof existing === 'string' ? existing.trim() : linkFor(paths, read.path, to);
    relation = { from: read.path, type, to: to.path, link };

    const set: Record<string, unknown> = existing === undefined ? { [type]: [...list, link] } : {};
    const warnings: IssueOutput[] = [];
    if (existing === undefined) {
      const provenance = agentEditProvenance(ctx, before);
      if (provenance !== null) {
        Object.assign(set, provenance.fields);
        warnings.push(provenance.warning);
      }
      checkUpdate(read, set, [], localDate(ctx.now()), config);
    }
    return {
      target: { path: read.path, diskPath: read.diskPath },
      checks: frontmatterTargets(set, config, before),
      warnings,
      apply: () =>
        updateNote(
          ctx.root,
          read.diskPath,
          { frontmatter: set },
          { config, now: ctx.now(), ifUnchangedSince: read.stamp },
        ),
    };
  });
  if (relation === null) throw new BrainError('invalid_argument', 'relate não montou a relação');
  return {
    ...output,
    relation,
    ...(output.changed ? {} : { next_step: 'A relação já existia; nada foi gravado.' }),
  };
}
