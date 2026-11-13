// Estado de um cérebro aberto e as peças que todas as operações usam: índice sempre atualizado antes de consultar,
// trava da pasta de trabalho em volta das escritas e o nome da máquina.
import type { LocalIndex } from '../db/index.ts';
import { scan } from '../db/index.ts';
import { syncLayout } from '../sync/index.ts';
import {
  defaultMachineName,
  isValidMachineName,
  readMachineConfig,
  sanitizeMachineName,
  withLock,
} from '../util/index.ts';
import type { BrainConfig } from '../vault/index.ts';
import { localDate } from '../vault/index.ts';
import { BrainError, toBrainError } from './errors.ts';
import type { Mutex } from './mutex.ts';

/** Quem escreve: o usuário (CLI) ou um agente (MCP). Define `origin`, `trust` e se pode criar regras. */
export type Actor = 'human' | 'agent';

/**
 * Passos da escrita em que o gancho de teste `faultAt` é chamado. Lançar ali simula uma falha depois da gravação;
 * a operação tem de deixar arquivo, banco e git de acordo.
 *
 * - `written`: a nota foi gravada no disco.
 * - `indexed`: o banco local já tem a nota.
 * - `cataloged`: `index.md` e `log.md` já foram atualizados; falta o commit.
 * - `reverted` (só no `undo`): o commit de revert foi feito; falta acertar o `index.md` nele. Um teste pode
 *   commitar ali, como outro programa faria, para conferir que o commit de revert não é reescrito por cima.
 */
export type WriteStep = 'written' | 'indexed' | 'cataloged' | 'reverted';

/** Quanto uma escrita espera pela trava da pasta de trabalho (o sync a segura por milissegundos). */
export const WORKTREE_LOCK_TIMEOUT_MS = 30_000;

export interface BrainContext {
  readonly root: string;
  /** Relida a cada escrita (o sync pode trazer um `.cabecao.json` novo). */
  config: BrainConfig;
  readonly client: string;
  readonly actor: Actor;
  readonly now: () => Date;
  readonly index: LocalIndex;
  readonly machineOption: string | undefined;
  /** Resolvido na primeira vez que é preciso. */
  machine: string | null;
  /** Varreduras e consultas ao banco, uma por vez: uma consulta nunca enxerga a transação aberta de uma varredura. */
  readonly dbMutex: Mutex;
  /** Escritas deste processo, uma por vez (a trava de arquivo serializa entre processos). */
  readonly writeMutex: Mutex;
  /** `performance.now()` do início da última varredura concluída. */
  lastScanStartedAt: number;
  closed: boolean;
  readonly faultAt: ((step: WriteStep) => void | Promise<void>) | undefined;
}

export function assertOpen(ctx: BrainContext): void {
  if (ctx.closed) throw new BrainError('closed', 'este cérebro já foi fechado; abra de novo com openBrain');
}

export function today(ctx: BrainContext): string {
  return localDate(ctx.now());
}

async function runScan(ctx: BrainContext): Promise<void> {
  const started = performance.now();
  try {
    await scan(ctx.index, ctx.root, ctx.config);
  } catch (error) {
    throw toBrainError(error);
  }
  ctx.lastScanStartedAt = started;
}

/**
 * Executa `fn` com o banco atualizado: se nenhuma varredura COMEÇOU depois deste pedido, faz uma (incremental; sem
 * mudança custa poucos milissegundos). Pedidos simultâneos aproveitam a mesma varredura. `fn` roda com o banco
 * só para si: faça ali todas as consultas, de preferência sem `await` no meio.
 */
export async function withFreshIndex<T>(ctx: BrainContext, fn: () => T | Promise<T>): Promise<T> {
  assertOpen(ctx);
  const requested = performance.now();
  return ctx.dbMutex.run(async () => {
    assertOpen(ctx);
    if (ctx.lastScanStartedAt < requested) await runScan(ctx);
    return fn();
  });
}

/** Varre de novo, mesmo que outra varredura recente exista (depois de uma escrita, de um sync ou de um undo). */
export async function rescan(ctx: BrainContext): Promise<void> {
  await withFreshIndex(ctx, () => undefined);
}

/**
 * Executa `fn` como escrita: uma por vez neste processo e, entre processos, sob a trava curta da pasta de trabalho
 * (`syncLayout(root).worktreeLock`), a mesma que o sync segura para commitar e aplicar. Assim uma escrita nunca
 * corre contra o `reset` do sync nem contra a escrita de outro processo.
 */
export function withWriteLock<T>(ctx: BrainContext, fn: () => Promise<T>): Promise<T> {
  assertOpen(ctx);
  return ctx.writeMutex.run(async () => {
    assertOpen(ctx);
    try {
      return await withLock(syncLayout(ctx.root).worktreeLock, fn, { timeoutMs: WORKTREE_LOCK_TIMEOUT_MS });
    } catch (error) {
      throw toBrainError(error);
    }
  });
}

/** Nome da máquina: o da opção, senão o da configuração da máquina, senão o hostname (mesma regra do sync). */
export async function machineName(ctx: BrainContext): Promise<string> {
  if (ctx.machine !== null) return ctx.machine;
  let name: string;
  if (ctx.machineOption !== undefined) {
    name = isValidMachineName(ctx.machineOption) ? ctx.machineOption : sanitizeMachineName(ctx.machineOption);
  } else {
    try {
      name = (await readMachineConfig())?.machine ?? defaultMachineName();
    } catch {
      name = defaultMachineName();
    }
  }
  ctx.machine = name;
  return name;
}
