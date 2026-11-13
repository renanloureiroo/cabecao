// `sync`: o sync do núcleo rodando no próprio processo, com o banco local reindexado a cada arquivo que mudou.
// Rodar num processo separado (como pede o doc 05) é decisão de quem chama: servidor MCP e CLI.
import { embeddingInputs, exportGraph } from '../db/index.ts';
import { type ResolvedEmbedding, readLocalEmbeddingState } from '../embeddings/index.ts';
import {
  GRAPH_EDGES_PATH,
  GRAPH_NODES_PATH,
  listIndexBranches,
  mergeRemoteIndex,
  readIndexFile,
  writeIndexFiles,
} from '../indexstore/index.ts';
import type { SyncIndexHook, SyncIndexResult, SyncResult } from '../sync/index.ts';
import { syncBrain } from '../sync/index.ts';
import { isUlid } from '../util/index.ts';
import { INVALID_CONFIG_HINT } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { assertOpen, machineName, rescan, withFreshIndex } from './context.ts';
import { refreshConfig } from './embeddings.ts';
import { BrainError } from './errors.ts';

export interface SyncInput {
  /** Sessão do agente que pediu o sync, para o rodapé dos commits de integração. */
  readonly session_handle?: string;
}

export interface SyncOutput {
  /** `ok`, `busy` (outro sync em andamento), `blocked` (segredo, operação do git pela metade, HEAD solto), `offline`, `error`. */
  readonly status: SyncResult['status'];
  /** Resumo em português. */
  readonly message: string;
  readonly pulled: number;
  readonly pushed: number;
  readonly committed: number;
  /**
   * Arquivos com as duas versões preservadas. `invalid`: o remoto trouxe um `.cabecao.json` inválido; ficou o
   * daqui, e o do remoto está em `copy` (`reason` diz por que não vale).
   */
  readonly conflicts: readonly {
    readonly path: string;
    readonly kind: 'content' | 'delete' | 'invalid';
    readonly copy: string | null;
    readonly kept: 'remote' | 'local' | null;
    readonly reason: string | null;
  }[];
  readonly changed_paths: readonly string[];
  /** Onde o scanner achou possíveis segredos (sem o segredo). */
  readonly secrets: readonly {
    readonly path: string;
    readonly line: number;
    readonly column: number;
    readonly rule: string;
    readonly description: string;
    readonly where: 'pending' | 'outgoing';
  }[];
  readonly attempts: number;
  readonly ms: number;
  readonly branch: string | null;
  readonly remote: string | null;
  readonly integration: SyncResult['integration'];
  readonly reason: SyncResult['reason'] | null;
  readonly remote_error: { readonly category: string; readonly detail: string } | null;
  readonly recovered: readonly string[];
  /**
   * O `.cabecao.json` desta pasta está inválido: o motivo e com que configuração o sync rodou. `null` quando está
   * tudo certo.
   */
  readonly config_problem: string | null;
  /**
   * A branch de índice (embeddings e grafo exportado) neste sync. `null` quando o índice não foi pedido (sync sem o
   * cérebro aberto).
   */
  readonly index: {
    /** O índice entrou neste sync (há `embedding` no `.cabecao.json` ou a branch de índice já existe). */
    readonly participating: boolean;
    readonly generation: number | null;
    /** Vetores que chegaram do remoto. */
    readonly received: number;
    /** Vetores calculados nesta máquina. */
    readonly computed: number;
    /** Vetores enviados, no mesmo envio atômico do conteúdo. */
    readonly pushed: number;
    /** Trechos que continuam sem vetor ("N trechos sem embedding"); `null` sem modelo configurado. */
    readonly pending: number | null;
    /** O grafo exportado mudou e foi gravado. */
    readonly graph_written: boolean;
    /** Por que esta máquina não calculou vetores (sem runtime, desligada aqui). */
    readonly skipped: string | null;
    /** Falha no índice que não impediu o sync do conteúdo. */
    readonly error: string | null;
  } | null;
  readonly next_step?: string;
}

function nextStep(result: SyncResult): string | undefined {
  if (result.configProblem !== undefined) return INVALID_CONFIG_HINT;
  if (result.conflicts.some((conflict) => conflict.kind === 'invalid')) {
    return 'O remoto trouxe um .cabecao.json inválido e ele não entrou: compare a cópia .cabecao.conflict-* com o .cabecao.json, corrija o que a outra máquina queria mudar e apague a cópia.';
  }
  if (result.status === 'blocked' && result.reason === 'secrets') {
    return 'Tire o segredo dos arquivos e linhas apontados (o valor nunca é mostrado), ou marque a linha com "cabecao:allow-secret" se não for um segredo, e rode o sync de novo.';
  }
  if (result.status === 'blocked' && result.reason === 'schema-too-new') {
    return 'Atualize o Cabeção nesta máquina e rode o sync de novo ("cabecao doctor" mostra o comando para a sua instalação); até lá, as mudanças daqui ficam em commits locais e nada é enviado.';
  }
  if (result.status === 'blocked') return 'Resolva o que a mensagem descreve e rode o sync de novo.';
  if (result.conflicts.length > 0) {
    return 'Há conflitos preservados: compare cada cópia .conflict-* com a nota, junte o que importa e apague a cópia.';
  }
  if (result.status === 'offline' && result.remoteError?.category === 'auth') {
    return 'O remoto recusou a credencial: rode "git fetch" na pasta do cérebro para ver o que o git pede (chave SSH, token ou gerenciador de credenciais), corrija e rode o sync de novo. As mudanças ficaram em commits locais.';
  }
  if (result.status === 'offline' && result.remoteError?.category === 'not-found') {
    return 'O remoto não foi encontrado: confira o endereço com "git remote -v" na pasta do cérebro. As mudanças ficaram em commits locais.';
  }
  if (result.status === 'offline')
    return 'As mudanças ficaram em commits locais; rode o sync de novo quando o remoto voltar.';
  if (result.status === 'busy') return 'Outro sync está em andamento; espere ele terminar.';
  if (result.status === 'error') return 'Rode o sync de novo; se repetir, rode "cabecao doctor".';
  return undefined;
}

export function toSyncOutput(result: SyncResult): SyncOutput {
  const step = nextStep(result);
  return {
    status: result.status,
    message: result.message,
    pulled: result.pulled,
    pushed: result.pushed,
    committed: result.committed,
    conflicts: result.conflicts.map((conflict) => ({
      path: conflict.path,
      kind: conflict.kind,
      copy: conflict.copy ?? null,
      kept: conflict.kept ?? null,
      reason: conflict.reason ?? null,
    })),
    changed_paths: result.changedPaths,
    secrets: (result.secrets ?? []).map((hit) => ({
      path: hit.path,
      line: hit.line,
      column: hit.column,
      rule: hit.rule,
      description: hit.description,
      where: hit.where,
    })),
    attempts: result.attempts,
    ms: result.ms,
    branch: result.branch,
    remote: result.remote,
    integration: result.integration,
    reason: result.reason ?? null,
    remote_error: result.remoteError ?? null,
    recovered: result.recovered ?? [],
    config_problem: result.configProblem ?? null,
    index: result.index === undefined ? null : indexOutput(result.index),
    ...(step === undefined ? {} : { next_step: step }),
  };
}

function indexOutput(index: SyncIndexResult): NonNullable<SyncOutput['index']> {
  return {
    participating: index.participating,
    generation: index.generation,
    received: index.received,
    computed: index.computed,
    pushed: index.pushed,
    pending: index.pending,
    graph_written: index.graphWritten,
    skipped: index.skipped,
    error: index.error,
  };
}

const NOT_PARTICIPATING = {
  participating: false,
  received: 0,
  computed: 0,
  pending: null,
  graphWritten: false,
  skipped: 'a busca por significado não está ativada neste cérebro',
  error: null,
} as const;

/**
 * O índice no sync (doc 04, passos E e G): junta a branch de índice com a do remoto (vetores de outras máquinas são
 * usados, nunca recalculados), calcula só os vetores que faltam e regenera o grafo exportado. Um cérebro sem
 * `embedding` no `.cabecao.json` e sem branch de índice não ganha uma: quem só usa a palavra-chave não vê branch
 * nova aparecer por causa do grafo.
 */
function indexHook(ctx: BrainContext): SyncIndexHook {
  /**
   * Vetores do modelo em uso antes de buscar o remoto (e de qual pasta), para contar o que chegou. Sem modelo ainda
   * (`modelDir: null`), tudo o que houver do modelo que chegar neste sync conta como recebido.
   */
  let before: { modelDir: string | null; count: number } | null = null;
  const known = async (resolved: ResolvedEmbedding | null): Promise<number> =>
    resolved === null ? 0 : (await ctx.engine.knownKeys(resolved)).size;
  const resolvedOf = (): ResolvedEmbedding | null => {
    const embedding = ctx.config.embedding;
    if (embedding === undefined) return null;
    try {
      return ctx.engine.resolve(embedding);
    } catch {
      return null;
    }
  };
  return {
    async beforeFetch() {
      const resolved = resolvedOf();
      before =
        resolved === null
          ? { modelDir: null, count: 0 }
          : await known(resolved)
              .then((count) => ({ modelDir: resolved.modelDir, count }))
              .catch(() => null);
    },
    async update({ remote, contentCommit }) {
      const counted = before;
      before = null;
      const config = await refreshConfig(ctx);
      const embedding = config.embedding;
      if (embedding === undefined && (await listIndexBranches(ctx.root)).length === 0) return { ...NOT_PARTICIPATING };
      await mergeRemoteIndex(ctx.root, remote ?? 'origin');
      let received = 0;
      let computed = 0;
      let pending: number | null = null;
      let skipped: string | null = null;
      let error: string | null = null;
      if (embedding !== undefined) {
        let resolved: ResolvedEmbedding | null = null;
        try {
          resolved = ctx.engine.resolve(embedding);
        } catch (problem) {
          error = problem instanceof Error ? problem.message : String(problem);
        }
        if (resolved !== null) {
          // o modelo pode ter mudado neste sync (troca feita em outra máquina): aí tudo o que há dele chegou agora
          if (counted !== null) {
            const now = await known(resolved);
            received = Math.max(0, now - (counted.modelDir === resolved.modelDir ? counted.count : 0));
          }
          const inputs = await withFreshIndex(ctx, () => embeddingInputs(ctx.index));
          if ((await readLocalEmbeddingState(ctx.root)).disabled) {
            skipped = 'a busca por significado está desligada nesta máquina ("cabecao embeddings on" religa)';
          } else {
            const availability = await ctx.engine.available(embedding);
            if (!availability.ok) skipped = availability.reason;
            else {
              try {
                computed = (await ctx.engine.compute(embedding, inputs, { contentCommit })).computed;
              } catch (problem) {
                error = `o cálculo dos embeddings parou: ${problem instanceof Error ? problem.message : String(problem)}`;
              }
            }
          }
          pending = await ctx.engine.missing(embedding, inputs);
        }
      } else {
        skipped = NOT_PARTICIPATING.skipped;
      }
      // grafo exportado: idêntico byte a byte em todas as máquinas para o mesmo conteúdo; só grava quando muda
      const graph = await withFreshIndex(ctx, () => exportGraph(ctx.index));
      const [nodes, edges] = await Promise.all([
        readIndexFile(ctx.root, GRAPH_NODES_PATH),
        readIndexFile(ctx.root, GRAPH_EDGES_PATH),
      ]);
      const graphWritten = nodes?.toString('utf8') !== graph.nodes || edges?.toString('utf8') !== graph.edges;
      if (graphWritten) {
        await writeIndexFiles(
          ctx.root,
          [
            [GRAPH_NODES_PATH, graph.nodes],
            [GRAPH_EDGES_PATH, graph.edges],
          ],
          { contentCommit },
        );
      }
      return { participating: true, received, computed, pending, graphWritten, skipped, error };
    },
  };
}

export async function sync(ctx: BrainContext, input: SyncInput = {}): Promise<SyncOutput> {
  assertOpen(ctx);
  const session = input.session_handle;
  if (session !== undefined && !isUlid(session)) {
    throw new BrainError(
      'invalid_argument',
      '"session_handle" deveria ser o identificador devolvido pelo recall (ULID)',
    );
  }
  const result = await syncBrain(ctx.root, {
    machine: await machineName(ctx),
    client: ctx.client,
    session,
    now: ctx.now,
    onApplied: async () => {
      // o banco é só uma visão: se a reindexação falhar aqui, a próxima leitura varre de novo
      await rescan(ctx).catch(() => undefined);
    },
    index: indexHook(ctx),
    ...(ctx.syncFaultAt === undefined ? {} : { faultAt: ctx.syncFaultAt }),
  });
  if (result.changedPaths.length > 0) await rescan(ctx).catch(() => undefined);
  return toSyncOutput(result);
}
