// Integração do conteúdo EM MEMÓRIA: `git merge-tree --write-tree` calcula a árvore integrada só com objetos, e
// nada na pasta de trabalho muda até a aplicação única (`reset --keep`). Não existe rebase pela metade para sobrar.
import { GitError } from '../git/index.ts';
import { normalizeNfc } from '../util/index.ts';
import { LOG_MD } from '../vault/index.ts';
import { withCatalog } from './catalog.ts';
import { commitMessage, type SyncContext } from './context.ts';
import {
  type AuthorInfo,
  commitTree,
  editTree,
  git,
  gitText,
  readObjects,
  revParse,
  type TreeEdit,
  treeOf,
  writeBlob,
} from './git.ts';
import { conflictCopyPath } from './layout.ts';
import type { SyncConflict, SyncIntegration } from './types.ts';

/** O remoto e o local não têm ancestral comum; juntar os dois é decisão do usuário. */
export class UnrelatedHistoriesError extends Error {
  override readonly name = 'UnrelatedHistoriesError';
}

/** `merge-tree --merge-base` chegou no git 2.40; sem ele a reaplicação linear dá lugar ao merge. */
class MergeBaseUnsupportedError extends Error {}

interface StageEntry {
  readonly mode: string;
  readonly oid: string;
}

interface MergeTreeResult {
  readonly tree: string;
  /** Por caminho: estágio 1 (base), 2 (primeiro lado) e 3 (segundo lado). */
  readonly conflicts: Map<string, { 1?: StageEntry; 2?: StageEntry; 3?: StageEntry }>;
}

async function mergeTree(ctx: SyncContext, args: readonly string[]): Promise<MergeTreeResult> {
  const result = await git(ctx, ['merge-tree', '--write-tree', '-z', '--no-messages', ...args], {
    allowFailure: true,
  });
  // 0 = limpo, 1 = com conflitos; qualquer outro código é erro de verdade
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    if (/unrelated histories/i.test(result.stderr)) {
      throw new UnrelatedHistoriesError('o remoto e o local não têm nenhum commit em comum');
    }
    if (/merge-base/.test(result.stderr) && /unknown option|usage:/i.test(result.stderr)) {
      throw new MergeBaseUnsupportedError(result.stderr);
    }
    throw new GitError({ args: result.args, exitCode: result.exitCode, stderr: result.stderr });
  }
  const [tree = '', ...records] = result.stdout.split('\0');
  const conflicts: MergeTreeResult['conflicts'] = new Map();
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode = '', oid = '', stage = ''] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    const entry = conflicts.get(path) ?? {};
    if (stage === '1' || stage === '2' || stage === '3') entry[stage] = { mode, oid };
    conflicts.set(path, entry);
  }
  return { tree, conflicts };
}

/**
 * União de linhas para o `log.md` quando o `.gitattributes` (`log.md merge=union`) não está valendo: tudo do
 * primeiro lado, depois as linhas do segundo que o primeiro não tem. Num diário que só cresce, dá a base mais as
 * duas sequências de linhas novas; nunca perde uma linha.
 */
export function unionLines(first: string, second: string): string {
  const firstLines = first.split('\n');
  if (firstLines.at(-1) === '') firstLines.pop();
  const counts = new Map<string, number>();
  for (const line of firstLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out = [...firstLines];
  const secondLines = second.split('\n');
  if (secondLines.at(-1) === '') secondLines.pop();
  for (const line of secondLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else out.push(line);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

type ConflictPolicy = 'copies' | 'derived-only';

/**
 * Resolve os conflitos de um `merge-tree` sem perder nenhuma versão. Lado 2 = remoto, lado 3 = local.
 *
 * - `index.md`: qualquer lado; o catálogo é regenerado depois.
 * - `log.md`: união de linhas.
 * - Qualquer outro arquivo (nota, anexo, configuração como `.gitignore`, `.cabecao.json`, `CLAUDE.md`,
 *   `.obsidian/*`) editado nos dois lados em regiões que o git não junta sozinho: o caminho fica com a versão remota e
 *   a local vai para a cópia `.conflict-*`, com a extensão original. Nada é reescrito nem reformatado.
 * - Editado de um lado e apagado do outro: a edição fica.
 *
 * Com `derived-only` (reaplicação linear), qualquer conflito fora do catálogo e do diário devolve `null`: o
 * chamador desiste da reaplicação e faz um merge, que registra o conflito com dois pais.
 */
async function resolveConflicts(
  ctx: SyncContext,
  merged: MergeTreeResult,
  policy: ConflictPolicy,
): Promise<{ tree: string; conflicts: SyncConflict[] } | null> {
  const edits: TreeEdit[] = [];
  const conflicts: SyncConflict[] = [];
  const taken = new Set<string>();
  const logTexts = new Map<string, Buffer>();
  const logEntry = merged.conflicts.get(LOG_MD);
  if (logEntry?.[2] && logEntry[3]) {
    for (const [name, buffer] of await readObjects(ctx, [logEntry[2].oid, logEntry[3].oid])) logTexts.set(name, buffer);
  }

  for (const [path, stages] of merged.conflicts) {
    const remote = stages[2];
    const local = stages[3];
    const normalized = normalizeNfc(path);
    if (normalized === ctx.config.indexMd) {
      const keep = remote ?? local;
      edits.push(keep ? { path, oid: keep.oid, mode: keep.mode } : { path, oid: null });
      continue;
    }
    if (normalized === LOG_MD && remote && local) {
      const text = unionLines(
        logTexts.get(remote.oid)?.toString('utf8') ?? '',
        logTexts.get(local.oid)?.toString('utf8') ?? '',
      );
      edits.push({ path, oid: await writeBlob(ctx, text), mode: remote.mode });
      continue;
    }
    if (policy === 'derived-only') return null;
    if (remote && local) {
      const copy = await freeCopyPath(ctx, merged.tree, path, taken);
      taken.add(copy);
      edits.push({ path, oid: remote.oid, mode: remote.mode }, { path: copy, oid: local.oid, mode: local.mode });
      conflicts.push({ path, kind: 'content', copy });
    } else if (remote || local) {
      const keep = (remote ?? local) as StageEntry;
      edits.push({ path, oid: keep.oid, mode: keep.mode });
      conflicts.push({ path, kind: 'delete', kept: remote ? 'remote' : 'local' });
    }
  }
  return { tree: await editTree(ctx, merged.tree, edits), conflicts };
}

/** Nome de cópia de conflito que ainda não existe na árvore. */
async function freeCopyPath(ctx: SyncContext, tree: string, path: string, taken: ReadonlySet<string>): Promise<string> {
  const date = ctx.now();
  for (let n = 1; ; n++) {
    const candidate = conflictCopyPath(path, ctx.machine, date, n);
    if (taken.has(candidate)) continue;
    if ((await revParse(ctx, `${tree}:${candidate}`)) === null) return candidate;
  }
}

export interface IntegrationResult {
  /** Commit que a branch local deve passar a apontar. */
  readonly target: string;
  readonly kind: Exclude<SyncIntegration, 'none' | 'fast-forward'>;
  readonly conflicts: SyncConflict[];
  /** Commits novos criados (merge; reaplicados não contam: são os mesmos commits locais, sobre o remoto). */
  readonly created: number;
}

interface CommitInfo {
  readonly author: AuthorInfo;
  readonly message: string;
}

async function commitInfo(ctx: SyncContext, commit: string): Promise<CommitInfo> {
  const { stdout } = await git(ctx, ['show', '-s', '--format=%an%x00%ae%x00%aI%x00%B', commit]);
  const [name = '', email = '', date = '', ...rest] = stdout.split('\0');
  return { author: { name, email, date }, message: rest.join('\0') };
}

/**
 * Reaplica os commits locais (`up..head`) sobre o remoto, um a um, em memória. O histórico fica linear e cada
 * commit mantém autor, data e mensagem (com os rodapés). Devolve `null` quando não dá: commit de merge no trecho
 * local ou conflito de verdade.
 */
async function replay(ctx: SyncContext, up: string, head: string): Promise<IntegrationResult | null> {
  const listed = await gitText(ctx, ['rev-list', '--reverse', '--topo-order', '--parents', `${up}..${head}`]);
  const commits = listed
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
  if (commits.some((parts) => parts.length !== 2)) return null;

  let base = up;
  let baseTree = await treeOf(ctx, up);
  let last: { parent: string; tree: string; info: CommitInfo } | null = null;
  for (const [commit = '', parent = ''] of commits) {
    let merged: MergeTreeResult;
    try {
      merged = await mergeTree(ctx, [`--merge-base=${parent}`, base, commit]);
    } catch (error) {
      if (error instanceof MergeBaseUnsupportedError) return null;
      throw error;
    }
    let tree = merged.tree;
    if (merged.conflicts.size > 0) {
      const resolved = await resolveConflicts(ctx, merged, 'derived-only');
      if (resolved === null) return null;
      tree = resolved.tree;
    }
    if (tree === baseTree) continue; // a mudança já estava no remoto
    const info = await commitInfo(ctx, commit);
    last = { parent: base, tree, info };
    base = await commitTree(ctx, tree, [base], info.message, info.author);
    baseTree = tree;
  }
  if (last !== null) {
    // o catálogo entra no último commit reaplicado, em vez de num commit a mais
    const fixed = await withCatalog(ctx, last.tree);
    if (fixed !== last.tree) base = await commitTree(ctx, fixed, [last.parent], last.info.message, last.info.author);
  }
  return { target: base, kind: 'replay', conflicts: [], created: 0 };
}

function mergeMessage(ctx: SyncContext, conflicts: readonly SyncConflict[]): string {
  if (conflicts.length === 0) {
    return commitMessage(ctx, { action: 'sync', body: ['sync: integra as mudanças de outra máquina'] });
  }
  // nota (`.md`) no feminino, qualquer outro arquivo (anexo, configuração) no masculino
  const isNote = (path: string): boolean => path.toLowerCase().endsWith('.md');
  const lines = conflicts.map((c) => {
    const a = isNote(c.path) ? 'a' : 'o';
    return c.kind === 'content'
      ? `- ${c.path}: editad${a} nas duas máquinas; a versão daqui está em ${c.copy}`
      : `- ${c.path}: editad${a} ${c.kept === 'local' ? 'aqui' : 'na outra máquina'} e apagad${a} ${c.kept === 'local' ? 'na outra' : 'aqui'}; a edição foi mantida`;
  });
  const n = conflicts.length;
  const notes = conflicts.every((c) => isNote(c.path));
  const noun = notes ? (n === 1 ? 'nota' : 'notas') : n === 1 ? 'arquivo' : 'arquivos';
  return commitMessage(ctx, {
    action: 'conflict',
    body: [`conflict: ${n} ${noun} com conflito preservado`, ...lines],
    numFiles: n,
  });
}

/** Commit de merge com dois pais (remoto primeiro). Conflitos viram cópias; nenhum commit local é reescrito. */
async function merge(ctx: SyncContext, up: string, head: string): Promise<IntegrationResult> {
  const merged = await mergeTree(ctx, [up, head]);
  let tree = merged.tree;
  let conflicts: SyncConflict[] = [];
  if (merged.conflicts.size > 0) {
    const resolved = await resolveConflicts(ctx, merged, 'copies');
    if (resolved === null) throw new Error('conflito sem resolução');
    ({ tree, conflicts } = resolved);
  }
  tree = await withCatalog(ctx, tree);
  const target = await commitTree(ctx, tree, [up, head], mergeMessage(ctx, conflicts));
  return { target, kind: 'merge', conflicts, created: 1 };
}

/** Integra `up` (remoto) com `head` (local) quando os dois divergiram. */
export async function integrateDiverged(ctx: SyncContext, up: string, head: string): Promise<IntegrationResult> {
  const base = await git(ctx, ['merge-base', up, head], { allowFailure: true });
  if (base.exitCode === 1) throw new UnrelatedHistoriesError('o remoto e o local não têm nenhum commit em comum');
  return (await replay(ctx, up, head)) ?? merge(ctx, up, head);
}

/**
 * Garante que o commit traz o `index.md` certo. Commits feitos por fora (Obsidian Git, celular) podem chegar com o
 * catálogo desatualizado: nesse caso entra um commit a mais, só com o catálogo regenerado.
 */
export async function withCatalogCommit(
  ctx: SyncContext,
  commit: string,
): Promise<{ commit: string; created: boolean }> {
  const tree = await treeOf(ctx, commit);
  const fixed = await withCatalog(ctx, tree);
  if (fixed === tree) return { commit, created: false };
  const message = commitMessage(ctx, { action: 'sync', body: [`sync: ${ctx.config.indexMd} regenerado`] });
  return { commit: await commitTree(ctx, fixed, [commit], message), created: true };
}
