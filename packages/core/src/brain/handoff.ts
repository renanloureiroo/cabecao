// `handoff_save` (doc 05; doc 07, "Como a memória entra"; marco 4): a passagem de bastão de uma sessão para a
// próxima. Grava, num commit só:
//
// - o handoff em `memory/handoffs/` (o que foi feito, o que falta, decisões e armadilhas), com `expires_at` (vale
//   `HANDOFF_TTL_DAYS`) e `supersedes` apontando o handoff vigente anterior do mesmo escopo, que deixa de valer;
// - quando a sessão fez alguma coisa (`done` não vazio), o episódio da sessão em `memory/episodes/AAAA/MM/`, que
//   fica como registro durável (sem validade) e é o material do `consolidate`.
//
// Cada item vira UMA linha de lista (quebras de linha viram espaço): um item não abre seção, não imita frontmatter e
// não se passa por regra. O handoff é `type: handoff` de agente (`trust: medium`) e o `recall` o entrega como dado,
// na seção `handoff`, nunca entre as regras.
import type { IndexedNote } from '../db/index.ts';
import { listNotes, validityOf } from '../db/index.ts';
import { connection } from '../db/open.ts';
import type { WriteResult } from '../vault/index.ts';
import { createNote, isValidScope, localDate } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { withFreshIndex } from './context.ts';
import type { IssueOutput } from './errors.ts';
import { BrainError } from './errors.ts';
import { linkFor } from './relate.ts';
import type { Prepared } from './write.ts';
import { assertAgentText, executeBatch, invalid, isRecord, prepareMemory, titleFromContent } from './write.ts';

/** Quantos dias um handoff vale (`expires_at`). */
export const HANDOFF_TTL_DAYS = 30;
/** Itens por lista e caracteres por item. */
export const HANDOFF_MAX_ITEMS = 50;
export const HANDOFF_ITEM_MAX_CHARS = 2000;

export interface HandoffSaveInput {
  /** O `session_handle` do `recall` desta sessão (obrigatório: liga o handoff, o episódio e os commits da sessão). */
  readonly session_handle: string;
  /** O que foi feito. */
  readonly done?: readonly string[];
  /** O que falta, na ordem. */
  readonly next?: readonly string[];
  /** Decisões tomadas, com o porquê. */
  readonly decisions?: readonly string[];
  /** Armadilhas descobertas. */
  readonly gotchas?: readonly string[];
  /** `global` (padrão) ou `project:<slug>`. */
  readonly scope?: string;
  /** Título; padrão: "Passagem de bastão: <primeiro próximo passo>". */
  readonly title?: string;
}

export interface NoteRefOutput {
  readonly id: string | null;
  readonly path: string;
}

export interface HandoffSaveOutput {
  readonly op: string;
  readonly commit: string | null;
  readonly handoff: NoteRefOutput;
  /** O episódio da sessão; `null` quando `done` veio vazio. */
  readonly episode: NoteRefOutput | null;
  /** O handoff anterior do mesmo escopo, que esta passagem substitui. */
  readonly supersedes: NoteRefOutput | null;
  readonly expires_at: string;
  readonly warnings: readonly IssueOutput[];
  readonly next_step: string;
}

const SECTIONS = [
  ['done', 'Feito'],
  ['next', 'Próximo passo'],
  ['decisions', 'Decisões'],
  ['gotchas', 'Armadilhas'],
] as const;

type ListName = (typeof SECTIONS)[number][0];

/** Uma lista de itens, cada um numa linha só, sem caracteres de controle. */
function items(ctx: BrainContext, value: unknown, name: ListName): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`"${name}" deveria ser uma lista de textos`);
  if (value.length > HANDOFF_MAX_ITEMS) throw invalid(`"${name}" tem itens demais: o limite é ${HANDOFF_MAX_ITEMS}`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalid(`"${name}" deveria ser uma lista de textos`);
    const line = item.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (line === '') continue;
    if (line.length > HANDOFF_ITEM_MAX_CHARS) {
      throw invalid(`um item de "${name}" passa de ${HANDOFF_ITEM_MAX_CHARS} caracteres; resuma`);
    }
    assertAgentText(ctx, line, `um item de "${name}"`, 'value');
    out.push(line);
  }
  return out;
}

/** Item de lista seguro: um traço, e o texto escapado o bastante para não virar outra estrutura do Markdown. */
const bullet = (line: string): string => `- ${line.replace(/^([#>]|-{3,}|\d+[.)])/, '\\$1')}`;

function section(heading: string, lines: readonly string[]): string {
  return lines.length === 0 ? '' : `## ${heading}\n\n${lines.map(bullet).join('\n')}\n`;
}

/** `AAAA-MM-DD` daqui a `days` dias, no fuso da máquina. */
function addDays(now: Date, days: number): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12);
  return localDate(date);
}

const shorten = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text
        .slice(0, max)
        .replace(/\s+\S*$/, '')
        .trimEnd()}…`;

const stemOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

export async function handoffSave(ctx: BrainContext, input: HandoffSaveInput): Promise<HandoffSaveOutput> {
  if (!isRecord(input)) throw invalid('handoff_save precisa de um objeto com session_handle, done e next');
  if (input.session_handle === undefined || input.session_handle === null) {
    throw invalid('"session_handle" é obrigatório no handoff_save', 'Use o session_handle que o recall devolveu.');
  }
  const lists = Object.fromEntries(SECTIONS.map(([name]) => [name, items(ctx, input[name], name)])) as Record<
    ListName,
    string[]
  >;
  if (lists.done.length === 0 && lists.next.length === 0) {
    throw invalid('o handoff precisa de pelo menos um item em "done" ou em "next"');
  }
  const scope = input.scope ?? 'global';
  if (!isValidScope(scope)) throw invalid('"scope" deveria ser "global" ou "project:<slug>"');
  if (input.title !== undefined && typeof input.title !== 'string') throw invalid('"title" deveria ser um texto');
  const now = ctx.now();
  const day = localDate(now);
  const expiresAt = addDays(now, HANDOFF_TTL_DAYS);
  const lead = lists.next[0] ?? lists.done[0] ?? '';
  const title = input.title?.trim() || `Passagem de bastão: ${shorten(titleFromContent(lead), 60)}`;
  assertAgentText(ctx, title, 'o campo "title"', 'name');

  const handoffBody = [
    `# ${title}\n`,
    section('Feito', lists.done),
    section('Próximo passo', lists.next),
    section('Decisões', lists.decisions),
    section('Armadilhas', lists.gotchas),
  ]
    .filter((part) => part !== '')
    .join('\n');
  const episodeTitle = `Sessão: ${shorten(titleFromContent(lists.done[0] ?? ''), 60)}`;
  const episodeBody = [
    `# ${episodeTitle}\n`,
    section('Feito', lists.done),
    section('Decisões', lists.decisions),
    section('Armadilhas', lists.gotchas),
  ]
    .filter((part) => part !== '')
    .join('\n');

  let previous: IndexedNote | null = null;
  const out = await executeBatch(ctx, input.session_handle, async (config) => {
    const { prior, paths } = await withFreshIndex(ctx, () => ({
      prior:
        listNotes(ctx.index, { types: ['handoff'], scope, limit: 20 }).find(
          (note) => validityOf(note, day) === 'current',
        ) ?? null,
      paths: connection(ctx.index)
        .prepare('select path from notes where conflict_of is null')
        .all()
        .map((row) => String(row.path)),
    }));
    previous = prior;
    const session = input.session_handle;
    const steps: Prepared[] = [];
    if (lists.done.length > 0) {
      steps.push(
        prepareMemory(
          ctx,
          { type: 'episode', title: episodeTitle, content: episodeBody, scope, tags: ['sessao'] },
          config,
          { session },
        ),
      );
    }
    const supersedes = prior === null ? [] : [linkFor(paths, 'memory/handoffs/x.md', prior)];
    const handoff = prepareMemory(
      ctx,
      { type: 'handoff', title, content: handoffBody, scope, tags: ['sessao'], expires_at: expiresAt },
      config,
      { session, ...(supersedes.length === 0 ? {} : { supersedes }) },
    );
    steps.push({
      ...handoff,
      // com episódio, o handoff aponta para ele em `sources` (o nome do episódio só existe depois de gravado)
      apply: (done: readonly WriteResult[]) => {
        const episode = done[0];
        if (episode === undefined) return handoff.apply(done);
        return createNote(ctx.root, config, {
          type: 'handoff',
          origin: String(handoff.frontmatter.origin),
          body: handoffBody,
          frontmatter: { ...handoff.frontmatter, sources: [`[[${stemOf(episode.path)}]]`] },
          now,
        });
      },
    });
    return { steps };
  });

  const results = out.results;
  const handoffResult = results.at(-1);
  if (handoffResult === undefined) throw new BrainError('invalid_argument', 'o handoff não foi gravado');
  const episodeResult = results.length > 1 ? (results[0] ?? null) : null;
  const prior = previous as IndexedNote | null;
  return {
    op: out.op,
    commit: out.commit,
    handoff: { id: handoffResult.id, path: handoffResult.path },
    episode: episodeResult === null ? null : { id: episodeResult.id, path: episodeResult.path },
    supersedes: prior === null ? null : { id: prior.id, path: prior.path },
    expires_at: expiresAt,
    warnings: out.warnings,
    next_step: `Handoff gravado; o próximo recall ${scope === 'global' ? '' : `com scope "${scope}" `}o entrega até ${expiresAt}. Para refazer, desfaça com undo({ op: "${out.op}" }) e grave de novo.`,
  };
}
