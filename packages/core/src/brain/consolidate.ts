// `consolidate` (doc 05; doc 07, "Manutenção sem Pull Request" e "Rotinas"; ADR 29; marco 4): a manutenção em que o
// AGENTE raciocina (o servidor não tem LLM, ADR 22) e o Cabeção cuida da segurança.
//
// - `start`: cria o ponto de restauração (tag local `cabecao/restore/<data>-<id>`) e devolve o material: episódios
//   que se repetem, pares de notas que parecem duplicatas, e o que o `lint` achou. Devolve também o
//   `consolidation_id`, que o agente passa como `session_handle` em todas as escritas (as tools normais, com todas as
//   restrições de agente: nenhuma regra em `memory/rules/`; uma regra só pode ser PROPOSTA em `wiki/syntheses/`).
// - `finish`: fecha tudo num commit `consolidate`, com uma linha por nota. As linhas saem do diff entre o ponto de
//   restauração e o HEAD (nunca do texto do agente): nada fica escondido num commit grande. Quando todos os commits
//   desde o ponto de restauração são operações desta consolidação e nenhum foi enviado ao remoto, eles viram UM
//   commit (com a árvore exatamente igual, sem reescrever nada que já saiu desta máquina). Quando não dá (o sync
//   enviou, o usuário editou no meio, outra sessão gravou), os commits ficam como estão e um commit `consolidate`
//   no diário marca o fim. Nos dois casos, `undo({ session: <consolidation_id> })` desfaz a consolidação inteira, e o
//   ponto de restauração continua lá para quem quiser voltar à mão.
import type { IndexedNote } from '../db/index.ts';
import { indexedBodies, listNotes, validityOf } from '../db/index.ts';
import {
  commitPaths,
  createRestorePoint,
  formatCommitMessage,
  parseCommitTrailers,
  RESTORE_TAG_PREFIX,
  restorePointName,
  runGit,
} from '../git/index.ts';
import { splitFrontmatter } from '../markdown/index.ts';
import { isUlid, ulid } from '../util/index.ts';
import { appendLogLine, displayTitle, isArchivedPath, LOG_MD } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { machineName, rescan, today, withFreshIndex, withWriteLock } from './context.ts';
import type { DataEnvelope } from './envelope.ts';
import { DATA_NOTICE } from './envelope.ts';
import { BrainError, toBrainError } from './errors.ts';
import type { LintFinding } from './lint.ts';
import { lint } from './lint.ts';
import { scopesFor } from './read.ts';
import type { DedupVerdict } from './similarity.ts';
import { compareMemories, memoryTerms } from './similarity.ts';
import { assertAgentText, invalid, isRecord, refreshForWrite } from './write.ts';

/** Jaccard dos termos a partir do qual dois episódios entram no mesmo grupo ("episódios que se repetem"). */
export const EPISODE_GROUP_JACCARD = 0.3;
/** Notas comparadas por tipo na procura de duplicatas (as mais recentes). */
const DUPLICATE_SCAN_LIMIT = 300;
const MATERIAL_LIMIT = 40;
/** Tipos que não entram na procura de duplicatas: regras (do usuário), episódios e handoffs (têm material próprio). */
const NO_DEDUP_TYPES = new Set(['rule', 'episode', 'handoff']);

export interface ConsolidateInput {
  readonly action: 'start' | 'finish';
  /** No `finish`: o id devolvido pelo `start`. */
  readonly consolidation_id?: string;
  /** No `start`: `project:<slug>` (inclui o global) ou `global`. */
  readonly scope?: string;
  /** No `finish`: o rótulo do commit (`consolidate: <título>`). */
  readonly title?: string;
}

export interface MaterialNote {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly created: string | null;
}

export interface ConsolidateOutput extends DataEnvelope {
  readonly action: 'start' | 'finish';
  readonly consolidation_id: string;
  readonly restore_point: { readonly tag: string; readonly commit: string };
  /** Só no `start`. */
  readonly material: {
    /** Grupos de episódios parecidos: candidatos a virar um fato, um procedimento ou uma armadilha. */
    readonly repeated_episodes: readonly {
      readonly notes: readonly MaterialNote[];
      readonly terms: readonly string[];
    }[];
    /** Episódios recentes (os grupos acima saem daqui). */
    readonly episodes: readonly MaterialNote[];
    /** Pares do mesmo tipo e escopo que a regra de duplicatas acha parecidos. */
    readonly duplicates: readonly {
      readonly a: MaterialNote;
      readonly b: MaterialNote;
      readonly verdict: DedupVerdict;
      readonly reason: string;
    }[];
    /** Achados do `lint` que a consolidação pode resolver. */
    readonly lint: readonly LintFinding[];
  } | null;
  /** Só no `start`: os passos. */
  readonly instructions: readonly string[];
  /** Só no `finish`. */
  readonly op: string | null;
  readonly commit: string | null;
  /** Os commits da consolidação viraram um só. */
  readonly squashed: boolean;
  /** Uma linha por nota alterada desde o ponto de restauração. */
  readonly changes: readonly string[];
  readonly next_step: string;
}

const materialNote = (note: IndexedNote): MaterialNote => ({
  id: note.id,
  path: note.path,
  title: note.title,
  type: note.type,
  created: note.created,
});

async function git(ctx: BrainContext, args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
  return runGit(args, { cwd: ctx.root, allowFailure: true });
}

function instructionsFor(id: string): string[] {
  return [
    `Passe session_handle: "${id}" em TODAS as escritas desta consolidação (remember, write_page, patch_page, relate, forget).`,
    'Episódios em repeated_episodes que contam a mesma coisa: grave o que se aprendeu como fato, procedimento ou armadilha (remember).',
    'Pares em duplicates: junte numa nota só (remember com resolution "update:<id>" ou "supersede:<id>") e arquive a sobra com forget.',
    'Achados do lint: corrija o que for seguro (link quebrado, fato substituído); o resto, conte ao usuário.',
    'Algo que deveria virar regra: proponha numa nota type: synthesis em wiki/syntheses/. Regras em memory/rules/ só o usuário grava.',
    `No fim, chame consolidate com action: "finish" e consolidation_id: "${id}".`,
  ];
}

async function start(ctx: BrainContext, input: ConsolidateInput): Promise<ConsolidateOutput> {
  const scopes = scopesFor(input.scope);
  const id = ulid();
  const restore = await withWriteLock(ctx, async () => {
    await refreshForWrite(ctx);
    try {
      return await createRestorePoint(ctx.root, `${restorePointName(ctx.now())}-${id}`);
    } catch (error) {
      throw toBrainError(error);
    }
  });
  const day = today(ctx);
  const material = await withFreshIndex(ctx, () => {
    const filter = scopes === undefined ? {} : { scope: scopes };
    const episodes = listNotes(ctx.index, { types: ['episode'], ...filter, limit: 200 });
    const bodies = indexedBodies(
      ctx.index,
      episodes.map((note) => note.id),
    );
    const terms = new Map(
      episodes.map((note) => [note.id, memoryTerms(`${note.title ?? ''}\n${bodies.get(note.id) ?? ''}`)]),
    );
    // grupos por ligação simples: dois episódios com Jaccard alto ficam juntos
    const group = new Map<string, number>();
    const groups: IndexedNote[][] = [];
    for (const [i, a] of episodes.entries()) {
      for (const b of episodes.slice(i + 1)) {
        const ta = terms.get(a.id) ?? new Set<string>();
        const tb = terms.get(b.id) ?? new Set<string>();
        let shared = 0;
        for (const term of ta) if (tb.has(term)) shared++;
        const jaccard = shared / Math.max(1, ta.size + tb.size - shared);
        if (jaccard < EPISODE_GROUP_JACCARD) continue;
        const ga = group.get(a.id);
        const gb = group.get(b.id);
        if (ga === undefined && gb === undefined) {
          group.set(a.id, groups.length);
          group.set(b.id, groups.length);
          groups.push([a, b]);
        } else if (ga !== undefined && gb === undefined) {
          group.set(b.id, ga);
          groups[ga]?.push(b);
        } else if (gb !== undefined && ga === undefined) {
          group.set(a.id, gb);
          groups[gb]?.push(a);
        }
      }
    }
    const repeated = groups.slice(0, MATERIAL_LIMIT).map((notes) => {
      const shared = [...(terms.get(notes[0]?.id ?? '') ?? [])].filter((term) =>
        notes.every((note) => terms.get(note.id)?.has(term)),
      );
      return { notes: notes.map(materialNote), terms: shared.slice(0, 12) };
    });

    const duplicates: NonNullable<ConsolidateOutput['material']>['duplicates'][number][] = [];
    const candidates = listNotes(ctx.index, { ...filter, limit: 5000 }).filter(
      (note) =>
        note.type !== null &&
        !NO_DEDUP_TYPES.has(note.type) &&
        !note.path.startsWith('raw/') &&
        validityOf(note, day) === 'current',
    );
    const byKey = new Map<string, IndexedNote[]>();
    for (const note of candidates) {
      const key = `${note.type}\u0000${note.type === 'fact' ? '' : (note.scope ?? 'global')}`;
      const list = byKey.get(key) ?? [];
      if (list.length < DUPLICATE_SCAN_LIMIT) list.push(note);
      byKey.set(key, list);
    }
    for (const list of byKey.values()) {
      const texts = indexedBodies(
        ctx.index,
        list.map((note) => note.id),
      );
      const fact = (note: IndexedNote) =>
        note.type === 'fact'
          ? {
              subject: String(note.frontmatter.subject ?? ''),
              predicate: String(note.frontmatter.predicate ?? ''),
              object: String(note.frontmatter.object ?? ''),
            }
          : null;
      for (const [i, a] of list.entries()) {
        for (const b of list.slice(i + 1)) {
          if (duplicates.length >= MATERIAL_LIMIT) break;
          const comparison = compareMemories(
            { title: a.title ?? '', body: texts.get(a.id) ?? '', fact: fact(a) },
            { title: b.title ?? '', body: texts.get(b.id) ?? '', fact: fact(b) },
          );
          if (comparison.verdict === 'distinct') continue;
          duplicates.push({
            a: materialNote(a),
            b: materialNote(b),
            verdict: comparison.verdict,
            reason: comparison.reason,
          });
        }
      }
    }
    return {
      repeated_episodes: repeated,
      episodes: episodes.slice(0, MATERIAL_LIMIT).map(materialNote),
      duplicates,
    };
  });
  const report = await lint(ctx, {
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    rules: ['fact_contradiction', 'expired_note', 'unconfirmed_memory', 'broken_link', 'unlinked_mention'],
    limit: MATERIAL_LIMIT,
  });
  return {
    data_notice: DATA_NOTICE,
    action: 'start',
    consolidation_id: id,
    restore_point: { tag: restore.tag, commit: restore.sha },
    material: { ...material, lint: report.findings },
    instructions: instructionsFor(id),
    op: null,
    commit: null,
    squashed: false,
    changes: [],
    next_step: `Siga instructions, com session_handle "${id}" em toda escrita, e termine com consolidate({ action: "finish", consolidation_id: "${id}" }). Se algo der errado, o ponto de restauração é ${restore.tag}.`,
  };
}

/** A tag do ponto de restauração de uma consolidação. */
async function restorePointOf(ctx: BrainContext, id: string): Promise<{ tag: string; sha: string }> {
  const listed = await git(ctx, [
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    `refs/tags/${RESTORE_TAG_PREFIX}`,
  ]);
  for (const line of listed.stdout.split('\n')) {
    const [tag = '', sha = ''] = line.trim().split(' ');
    if (tag.endsWith(`-${id}`) && /^[0-9a-f]{40,64}$/.test(sha)) return { tag, sha };
  }
  throw new BrainError('not_found', `nenhuma consolidação ${id} nesta máquina (o ponto de restauração não existe)`, {
    nextStep: 'Use o consolidation_id devolvido por consolidate({ action: "start" }) nesta mesma máquina.',
  });
}

interface RangeCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly session: string | undefined;
  readonly client: string | undefined;
  readonly op: string | undefined;
}

/** Uma linha por nota alterada entre `from` e `to`, a partir do diff (e do frontmatter das notas). */
async function changeLines(ctx: BrainContext, from: string, to: string): Promise<string[]> {
  const diff = await git(ctx, ['diff', '--name-status', '--no-renames', '-z', from, to]);
  const parts = diff.stdout.split('\0').filter((part) => part !== '');
  const entries: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) entries.push({ status: parts[i] ?? '', path: parts[i + 1] ?? '' });
  const ignored = new Set([ctx.config.indexMd, LOG_MD]);
  const fm = async (rev: string, path: string): Promise<Record<string, unknown>> => {
    const shown = await git(ctx, ['show', `${rev}:${path}`]);
    if (shown.exitCode !== 0) return {};
    const split = splitFrontmatter(shown.stdout);
    return split.error === null ? { ...split.data } : {};
  };
  const lines: string[] = [];
  const archivedNames = new Set(
    entries
      .filter((entry) => entry.status === 'A' && isArchivedPath(entry.path))
      .map((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1)),
  );
  for (const { status, path } of entries) {
    if (ignored.has(path) || !/\.md$/i.test(path)) {
      if (!ignored.has(path)) lines.push(`${status === 'D' ? 'delete' : status === 'A' ? 'add' : 'update'}: ${path}`);
      continue;
    }
    const data = await fm(status === 'D' ? from : to, path);
    const type = typeof data.type === 'string' ? ` ${data.type}` : '';
    const title = displayTitle(data, path).replace(/\s+/g, ' ');
    if (status === 'A') {
      if (isArchivedPath(path)) lines.push(`archive${type}: ${title}`);
      else if (path.toLowerCase().startsWith('raw/')) lines.push(`ingest: ${title}`);
      else if (Array.isArray(data.supersedes) && data.supersedes.length > 0) lines.push(`supersede${type}: ${title}`);
      else lines.push(`add${type}: ${title}`);
    } else if (status === 'D') {
      // a origem de um arquivamento já aparece como "archive"
      if (!archivedNames.has(path.slice(path.lastIndexOf('/') + 1))) lines.push(`delete${type}: ${title} (${path})`);
    } else {
      lines.push(`update${type}: ${title}`);
    }
  }
  return lines;
}

async function finish(ctx: BrainContext, input: ConsolidateInput): Promise<ConsolidateOutput> {
  const id = typeof input.consolidation_id === 'string' ? input.consolidation_id.trim().toUpperCase() : '';
  if (!isUlid(id)) {
    throw invalid('"consolidation_id" deveria ser o id devolvido por consolidate({ action: "start" }), inteiro');
  }
  if (input.title !== undefined && typeof input.title !== 'string') throw invalid('"title" deveria ser um texto');
  const label = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || `consolidação ${id.slice(0, 8)}`;
  assertAgentText(ctx, label, 'o campo "title"', 'name');

  return withWriteLock(ctx, async () => {
    const head = await refreshForWrite(ctx);
    const restore = await restorePointOf(ctx, id);
    const ancestor = await git(ctx, ['merge-base', '--is-ancestor', restore.sha, head]);
    if (ancestor.exitCode !== 0) {
      throw new BrainError('conflict', `o ponto de restauração ${restore.tag} não está mais no histórico do HEAD`, {
        nextStep: 'Rode "cabecao status"; a consolidação não pode ser fechada daqui.',
      });
    }
    const logged = await git(ctx, ['log', '-z', '--format=%H%n%P%n%B', `${restore.sha}..${head}`]);
    const commits: RangeCommit[] = [];
    for (const record of logged.stdout.split('\0')) {
      const [sha, parents, ...lines] = record.replace(/^\n+/, '').split('\n');
      if (!sha || parents === undefined) continue;
      const trailers = parseCommitTrailers(lines.join('\n'));
      commits.push({
        sha,
        parents: parents.split(' ').filter((parent) => parent !== ''),
        session: trailers.session,
        client: trailers.client,
        op: trailers.op,
      });
    }
    const changes = await changeLines(ctx, restore.sha, head);
    const restorePoint = { tag: restore.tag, commit: restore.sha };
    const base = {
      data_notice: DATA_NOTICE,
      action: 'finish' as const,
      consolidation_id: id,
      restore_point: restorePoint,
      material: null,
      instructions: [],
    };
    if (commits.length === 0 || changes.length === 0) {
      return {
        ...base,
        op: null,
        commit: null,
        squashed: false,
        changes,
        next_step: 'Nada mudou desde o início da consolidação; nada foi gravado.',
      };
    }

    // juntar só o que é desta consolidação e ainda não saiu desta máquina
    const ours = commits.every(
      (commit) =>
        commit.parents.length === 1 && commit.session === id && commit.op !== undefined && commit.client !== 'manual',
    );
    let pushed = false;
    const upstream = await git(ctx, ['rev-parse', '--verify', '--quiet', '@{upstream}']);
    if (upstream.exitCode === 0) {
      const oldest = commits.at(-1)?.sha ?? head;
      pushed = (await git(ctx, ['merge-base', '--is-ancestor', oldest, upstream.stdout.trim()])).exitCode === 0;
    }
    const op = ulid();
    const header = `consolidate: ${label}`;
    const message = formatCommitMessage({
      ...(ctx.config.commit?.message === undefined ? {} : { subjectTemplate: ctx.config.commit.message }),
      ...(ctx.config.commit?.dateFormat === undefined ? {} : { dateFormat: ctx.config.commit.dateFormat }),
      date: ctx.now(),
      action: 'consolidate',
      body: [header, ...changes.map((line) => `- ${line}`)],
      numFiles: changes.length,
      trailers: { op, session: id, machine: await machineName(ctx), client: ctx.client },
    });

    if (ours && !pushed) {
      try {
        const tree = (await runGit(['rev-parse', `${head}^{tree}`], { cwd: ctx.root })).stdout.trim();
        const commit = (
          await runGit(['commit-tree', '--no-gpg-sign', tree, '-p', restore.sha, '-F', '-'], {
            cwd: ctx.root,
            input: message,
          })
        ).stdout.trim();
        const moved = await git(ctx, ['update-ref', '-m', 'cabecao consolidate', 'HEAD', commit, head]);
        if (moved.exitCode === 0) {
          await rescan(ctx);
          return {
            ...base,
            op,
            commit,
            squashed: true,
            changes,
            next_step: `Consolidação fechada num commit. undo({ session: "${id}" }) desfaz tudo de uma vez; o ponto de restauração ${restore.tag} continua na máquina.`,
          };
        }
      } catch (error) {
        throw toBrainError(error);
      }
    }

    // não dá para juntar: os commits ficam; um commit no diário fecha a consolidação
    await appendLogLine(ctx.root, { action: 'consolidate', title: label, date: ctx.now() });
    let commit: string | null;
    try {
      commit = await commitPaths(ctx.root, [LOG_MD], message);
    } catch (error) {
      throw toBrainError(error);
    }
    const why = pushed
      ? 'parte dos commits já foi enviada ao remoto'
      : 'há commits de fora desta consolidação no meio (edição do usuário, sync ou outra sessão)';
    return {
      ...base,
      op,
      commit,
      squashed: false,
      changes,
      next_step: `Consolidação fechada; os commits não foram juntados porque ${why}. undo({ session: "${id}" }) desfaz o que esta consolidação gravou.`,
    };
  });
}

export async function consolidate(ctx: BrainContext, input: ConsolidateInput): Promise<ConsolidateOutput> {
  if (!isRecord(input)) throw invalid('consolidate precisa de um objeto com action');
  if (input.action === 'start') return start(ctx, input);
  if (input.action === 'finish') return finish(ctx, input);
  throw invalid('"action" deveria ser "start" ou "finish"');
}
