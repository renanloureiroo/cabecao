// `sync`: o sync do núcleo rodando no próprio processo, com o banco local reindexado a cada arquivo que mudou.
// Rodar num processo separado (como pede o doc 05) é decisão de quem chama: servidor MCP e CLI.
import type { SyncResult } from '../sync/index.ts';
import { syncBrain } from '../sync/index.ts';
import { isUlid } from '../util/index.ts';
import { INVALID_CONFIG_HINT } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { assertOpen, machineName, rescan } from './context.ts';
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
  readonly next_step?: string;
}

function nextStep(result: SyncResult): string | undefined {
  if (result.configProblem !== undefined) return INVALID_CONFIG_HINT;
  if (result.conflicts.some((conflict) => conflict.kind === 'invalid')) {
    return 'O remoto trouxe um .cabecao.json inválido e ele não entrou: compare a cópia .cabecao.conflict-* com o .cabecao.json, corrija o que a outra máquina queria mudar e apague a cópia.';
  }
  if (result.status === 'blocked' && result.reason === 'secrets') {
    return 'Tire o segredo dos arquivos apontados em secrets (ou marque a linha com "cabecao:allow-secret" se não for um) e rode sync de novo.';
  }
  if (result.status === 'blocked') return 'Resolva o estado do repositório descrito em message e rode sync de novo.';
  if (result.conflicts.length > 0) {
    return 'Há conflitos preservados: compare cada cópia .conflict-* com a nota, junte o que importa e apague a cópia.';
  }
  if (result.status === 'offline')
    return 'As mudanças ficaram em commits locais; rode sync de novo quando o remoto voltar.';
  if (result.status === 'busy') return 'Outro sync está em andamento; espere ele terminar.';
  if (result.status === 'error') return 'Rode sync de novo; se repetir, rode "cabecao doctor".';
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
    ...(step === undefined ? {} : { next_step: step }),
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
  });
  if (result.changedPaths.length > 0) await rescan(ctx).catch(() => undefined);
  return toSyncOutput(result);
}
