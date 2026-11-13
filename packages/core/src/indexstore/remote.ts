/**
 * A branch de índice e o remoto: buscar, integrar, montar a referência do envio atômico e (opcionalmente) apagar
 * gerações antigas. O envio em si é do sync: ele põe {@link indexPushRef} no mesmo `git push --atomic` do conteúdo
 * (decisão 15) e, depois de aceito, chama {@link recordIndexPushed}.
 */
import { classifyGitError, type GitErrorCategory } from '../git/index.ts';
import { git, readObjects } from '../sync/git.ts';
import type { PushRef } from '../sync/remote.ts';
import { type IndexOptions, makeContext, readSegments, type SegmentIssue, withIndexLock } from './context.ts';
import { hasObject, type IndexRef, listIndexRefs, lsTree, updateRef } from './git.ts';
import { computeView, type DrainSource, writeView } from './integrate.ts';
import {
  generationRef,
  INDEX_REF_PATTERN,
  MANIFEST_PATH,
  parseGenerationRef,
  parseSegmentPath,
  trackingRef,
} from './layout.ts';
import { type IndexManifest, parseManifest } from './manifest.ts';

/** Referência a enviar: commit local → referência completa no remoto (mesma forma do `PushRef` do sync). */
export type IndexPushRef = PushRef;

export type FetchIndexResult =
  | {
      readonly ok: true;
      /** Geração corrente no remoto; `null` se o remoto não tem índice. */
      readonly generation: number | null;
      readonly tip: string | null;
      /** Houve `git fetch` (algo novo chegou). */
      readonly fetched: boolean;
      /** Referências do índice anunciadas pelo remoto. */
      readonly advertised: ReadonlyMap<string, string>;
    }
  | { readonly ok: false; readonly category: GitErrorCategory; readonly detail: string };

export interface FetchIndexOptions extends IndexOptions {
  /**
   * Saída de um `git ls-remote` já feito pelo sync (referência → SHA). Com ela não há ida extra ao remoto quando nada
   * mudou: o sync lista o conteúdo e {@link INDEX_REF_PATTERN} numa chamada só.
   */
  readonly advertised?: ReadonlyMap<string, string>;
}

function detailOf(stderr: string): string {
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('hint:'))
    .slice(-3)
    .join(' | ')
    .slice(0, 500);
}

async function advertisedIndexRefs(
  root: string,
  remote: string,
  options: IndexOptions,
): Promise<{ ok: true; refs: Map<string, string> } | { ok: false; category: GitErrorCategory; detail: string }> {
  const ctx = makeContext(root, options);
  const listed = await git(ctx.git, ['ls-remote', '--', remote, INDEX_REF_PATTERN], {
    network: true,
    allowFailure: true,
  });
  if (listed.exitCode !== 0)
    return { ok: false, category: classifyGitError(listed.stderr), detail: detailOf(listed.stderr) };
  const refs = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    const [oid, ref] = line.split('\t');
    if (oid && ref && parseGenerationRef(ref) !== null) refs.set(ref, oid);
  }
  return { ok: true, refs };
}

async function manifestOf(root: string, commit: string, options: IndexOptions): Promise<IndexManifest | null> {
  const ctx = makeContext(root, options);
  const blob = (await readObjects(ctx.git, [`${commit}:${MANIFEST_PATH}`])).get(`${commit}:${MANIFEST_PATH}`);
  return blob ? parseManifest(blob) : null;
}

/**
 * Busca a branch de índice do remoto para `refs/remotes/<remoto>/cabecao/index[-n]`. Uma ida ao remoto quando nada
 * mudou (`ls-remote`, ou nenhuma com `advertised`); mais um `fetch` quando há commits novos. Gerações antigas só são
 * buscadas quando avançaram depois da compactação (outra máquina enviou para elas): é o que precisa ser drenado.
 * Referências de acompanhamento de gerações que o remoto não tem mais são apagadas. Não lança por falha de rede ou
 * autenticação: devolve a categoria.
 */
export async function fetchRemoteIndex(
  root: string,
  remote = 'origin',
  options: FetchIndexOptions = {},
): Promise<FetchIndexResult> {
  const ctx = makeContext(root, options);
  let advertised: ReadonlyMap<string, string>;
  if (options.advertised) {
    advertised = new Map([...options.advertised].filter(([ref]) => parseGenerationRef(ref) !== null));
  } else {
    const listed = await advertisedIndexRefs(root, remote, options);
    if (!listed.ok) return listed;
    advertised = listed.refs;
  }
  const known = new Map(
    (await listIndexRefs(ctx.git)).filter((r) => r.remote === remote).map((r) => [r.generation, r] as const),
  );
  const gens = [...advertised]
    .map(([ref, oid]) => ({ ref, oid, generation: parseGenerationRef(ref) ?? 0 }))
    .sort((a, b) => b.generation - a.generation);
  let fetched = false;
  const sync = async (
    items: typeof gens,
  ): Promise<{ ok: true } | { ok: false; category: GitErrorCategory; detail: string }> => {
    const specs: string[] = [];
    for (const item of items) {
      const tracking = trackingRef(remote, item.generation);
      const current = known.get(item.generation)?.oid ?? null;
      if (current === item.oid) continue;
      if (await hasObject(ctx.git, `${item.oid}^{commit}`)) {
        // já temos o commit (o envio foi nosso): basta mover a referência
        await updateRef(ctx.git, tracking, item.oid, current, item.oid.length);
      } else specs.push(`+${item.ref}:${tracking}`);
    }
    if (specs.length === 0) return { ok: true };
    const result = await git(ctx.git, ['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote, ...specs], {
      network: true,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return { ok: false, category: classifyGitError(result.stderr), detail: detailOf(result.stderr) };
    }
    fetched = true;
    return { ok: true };
  };
  const [top, ...older] = gens;
  if (top !== undefined) {
    const first = await sync([top]);
    if (!first.ok) return first;
    const previous = (await manifestOf(root, top.oid, options))?.previous ?? null;
    const wanted: typeof gens = [];
    for (const item of older) {
      const consumed = previous !== null && item.oid === previous.commit;
      if (!consumed || (await hasObject(ctx.git, `${item.oid}^{commit}`))) {
        wanted.push(item);
        continue;
      }
      // a ponta exata que a compactação consumiu não tem nada a drenar: não precisa ser baixada
      const current = known.get(item.generation);
      if (current) await updateRef(ctx.git, current.ref, null, current.oid, current.oid.length);
      known.delete(item.generation);
    }
    const rest = await sync(wanted);
    if (!rest.ok) return rest;
  }
  for (const [generation, ref] of known) {
    if (![...advertised.keys()].some((name) => parseGenerationRef(name) === generation)) {
      await updateRef(ctx.git, ref.ref, null, ref.oid, ref.oid.length);
    }
  }
  return { ok: true, generation: top?.generation ?? null, tip: top?.oid ?? null, fetched, advertised };
}

export interface MergeIndexResult {
  readonly generation: number | null;
  /** Ponta da branch local depois da integração. */
  readonly commit: string | null;
  /**
   * `none`: nada a fazer; `fast-forward`: a branch local só avançou; `merged`: commit novo sobre a ponta remota (união
   * dos segmentos, drenagem de gerações antigas).
   */
  readonly outcome: 'none' | 'fast-forward' | 'merged';
  readonly drainedRecords: number;
  readonly drainSources: readonly DrainSource[];
  readonly issues: readonly SegmentIssue[];
}

/**
 * Junta a branch de índice local com a do remoto (já buscada com {@link fetchRemoteIndex}). Segmentos são imutáveis
 * e nomeados pelo conteúdo: a junção é a união dos arquivos, sem conflito por construção. O commit resultante tem a
 * ponta remota como único pai (reaplicação, como o spike decidiu), então o envio é avanço simples. O manifesto é
 * regenerado; modelos diferentes convivem em pastas diferentes. Uma geração nova no remoto é adotada e a antiga é
 * drenada (ver `compactIndex`).
 */
export async function mergeRemoteIndex(
  root: string,
  remote = 'origin',
  options: IndexOptions = {},
): Promise<MergeIndexResult> {
  const ctx = makeContext(root, { ...options, remote });
  return withIndexLock(ctx, async () => {
    const view = await computeView(ctx);
    const written = await writeView(ctx, view);
    return {
      generation: written.generation,
      commit: written.commit,
      outcome: written.created ? 'merged' : view.parent !== view.localOid ? 'fast-forward' : 'none',
      drainedRecords: written.drainedRecords,
      drainSources: view.drainSources,
      issues: view.issues,
    };
  });
}

/**
 * O que o sync deve pôr no `git push --atomic` junto com o conteúdo: a branch local da geração corrente, se ela tem
 * algo que o remoto não tem. `null` quando não há nada a enviar. Chame depois de {@link mergeRemoteIndex}, para o
 * envio ser avanço simples.
 */
export async function indexPushRef(
  root: string,
  remote = 'origin',
  options: IndexOptions = {},
): Promise<IndexPushRef | null> {
  const ctx = makeContext(root, options);
  const refs = (await listIndexRefs(ctx.git)).filter((r) => r.remote === null || r.remote === remote);
  if (refs.length === 0) return null;
  const generation = Math.max(...refs.map((r) => r.generation));
  const local = refs.find((r) => r.remote === null && r.generation === generation);
  if (!local) return null;
  const tracking = refs.find((r) => r.remote === remote && r.generation === generation);
  if (tracking?.oid === local.oid) return null;
  return { sha: local.oid, ref: generationRef(generation) };
}

/** Depois que o remoto aceitou o envio: a referência de acompanhamento passa a apontar para o que foi enviado. */
export async function recordIndexPushed(
  root: string,
  remote: string,
  pushed: IndexPushRef,
  options: IndexOptions = {},
): Promise<void> {
  const generation = parseGenerationRef(pushed.ref);
  if (generation === null) throw new TypeError(`não é uma referência do índice: ${pushed.ref}`);
  const ctx = makeContext(root, options);
  const tracking = trackingRef(remote, generation);
  const current = (await listIndexRefs(ctx.git)).find((r) => r.ref === tracking)?.oid ?? null;
  if (current !== pushed.sha) await updateRef(ctx.git, tracking, pushed.sha, current, pushed.sha.length);
}

export interface PruneResult {
  readonly deleted: readonly string[];
  readonly kept: readonly { readonly ref: string; readonly reason: string }[];
}

const DENIED_KEY = 'cabecao.indexPruneDenied';

/**
 * Opcional: apaga no remoto as gerações antigas cujo conteúdo já está todo na geração corrente do remoto. Usa
 * `--force-with-lease` (só apaga se ninguém escreveu nela desde a conferência). Servidor que proíbe exclusão: a
 * referência fica, inofensiva, e é anotada em `cabecao.indexPruneDenied` para não tentar de novo. Nunca é necessário
 * para a correção: só reduz o que um clone novo baixa.
 */
export async function pruneRemoteGenerations(
  root: string,
  remote = 'origin',
  options: IndexOptions = {},
): Promise<PruneResult> {
  const ctx = makeContext(root, options);
  const listed = await advertisedIndexRefs(root, remote, options);
  if (!listed.ok) return { deleted: [], kept: [{ ref: '*', reason: `${listed.category}: ${listed.detail}` }] };
  const gens = [...listed.refs].map(([ref, oid]) => ({ ref, oid, generation: parseGenerationRef(ref) ?? 0 }));
  if (gens.length < 2) return { deleted: [], kept: [] };
  const top = gens.reduce((a, b) => (b.generation > a.generation ? b : a));
  const deleted: string[] = [];
  const kept: { ref: string; reason: string }[] = [];
  if (!(await hasObject(ctx.git, `${top.oid}^{commit}`))) {
    return {
      deleted,
      kept: gens.filter((g) => g !== top).map((g) => ({ ref: g.ref, reason: 'geração corrente não buscada' })),
    };
  }
  const denied = new Set(
    (await git(ctx.git, ['config', '--get-all', DENIED_KEY], { allowFailure: true })).stdout
      .split('\n')
      .filter(Boolean),
  );
  const topTree = await lsTree(ctx.git, top.oid);
  const previous = (await manifestOf(root, top.oid, options))?.previous ?? null;
  const consumed = new Set(previous?.segments ?? []);
  let topKeys: Set<string> | null = null;
  for (const old of gens) {
    if (old === top) continue;
    if (denied.has(old.ref)) {
      kept.push({ ref: old.ref, reason: 'o servidor não permite apagar' });
      continue;
    }
    if (!(previous !== null && old.oid === previous.commit)) {
      if (!(await hasObject(ctx.git, `${old.oid}^{commit}`))) {
        kept.push({ ref: old.ref, reason: 'ponta não buscada' });
        continue;
      }
      const extra = [...(await lsTree(ctx.git, old.oid)).values()].filter(
        (item) => parseSegmentPath(item.path) && !topTree.has(item.path) && !consumed.has(item.path),
      );
      if (extra.length > 0) {
        if (topKeys === null) {
          topKeys = new Set();
          const items = [...topTree.values()].filter((item) => parseSegmentPath(item.path));
          for (const segment of (await readSegments(ctx, items)).segments.values()) {
            for (let i = 0; i < segment.count; i++) topKeys.add(segment.key(i));
          }
        }
        const read = await readSegments(ctx, extra);
        let covered = read.issues.length === 0;
        for (const segment of read.segments.values()) {
          for (let i = 0; i < segment.count && covered; i++) if (!topKeys.has(segment.key(i))) covered = false;
        }
        if (!covered) {
          kept.push({ ref: old.ref, reason: 'tem vetores que ainda não estão na geração corrente do remoto' });
          continue;
        }
      }
    }
    const result = await git(
      ctx.git,
      ['push', '--quiet', '--no-verify', `--force-with-lease=${old.ref}:${old.oid}`, remote, `:${old.ref}`],
      { network: true, allowFailure: true },
    );
    if (result.exitCode === 0 || /remote ref does not exist/i.test(result.stderr)) {
      deleted.push(old.ref);
      const local: IndexRef | undefined = (await listIndexRefs(ctx.git)).find(
        (r) => r.remote === remote && r.generation === old.generation,
      );
      if (local) await updateRef(ctx.git, local.ref, null, local.oid, local.oid.length).catch(() => {});
      continue;
    }
    if (/deletion prohibited|denying ref deletion|deny|declined|protected|not allowed/i.test(result.stderr)) {
      await git(ctx.git, ['config', '--add', DENIED_KEY, old.ref], { allowFailure: true });
    }
    kept.push({ ref: old.ref, reason: detailOf(result.stderr) });
  }
  return { deleted, kept };
}
