import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isErrno, isWindowsTransient } from './errors.ts';

export interface LockOptions {
  /** Quanto esperar pela trava antes de desistir com `LockTimeoutError`. `0` tenta uma vez só. Padrão: 30 s. */
  timeoutMs?: number;
  /**
   * Idade (pela data de modificação do arquivo) a partir da qual a trava é considerada abandonada. Quem segura a
   * trava renova essa data sozinho enquanto estiver vivo, então isto só vence para processo morto ou congelado.
   * Todos os processos que disputam a mesma trava devem usar o mesmo valor. Padrão: 10 min.
   */
  staleMs?: number;
}

export interface LockHandle {
  /** Solta a trava. Pode ser chamada mais de uma vez. */
  release(): Promise<void>;
}

/** Conteúdo do arquivo de trava. */
export interface LockOwner {
  pid: number;
  host: string;
  /** Instante da aquisição (ms desde 1970). */
  at: number;
  /** Sorteado a cada aquisição: distingue esta trava de outra criada depois no mesmo caminho. */
  token: string;
}

export class LockTimeoutError extends Error {
  readonly code = 'ELOCKTIMEOUT';
  readonly path: string;
  /** Quem segurava a trava na última olhada, se deu para ler. */
  readonly owner: LockOwner | null;

  constructor(path: string, timeoutMs: number, owner: LockOwner | null, cause?: unknown) {
    const who = owner ? ` (em uso pelo processo ${owner.pid} em ${owner.host})` : '';
    super(`não consegui a trava em ${timeoutMs} ms: ${path}${who}`, cause === undefined ? undefined : { cause });
    this.name = 'LockTimeoutError';
    this.path = path;
    this.owner = owner;
  }
}

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
export const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
/** Trava ilegível (vazia ou cortada: o dono morreu entre criar e escrever) vence rápido, não em `staleMs`. */
const UNREADABLE_STALE_MS = 2_000;
/** O "roubo" dura milissegundos; um mutex de roubo mais velho que isto é de um processo que morreu no meio. */
const STEAL_MUTEX_STALE_MS = 5_000;

type LockState =
  | { kind: 'gone' }
  /** Existe mas não deu para ler agora (Windows com o arquivo ocupado): trata como em uso. */
  | { kind: 'busy' }
  | { kind: 'unreadable'; mtimeMs: number }
  | { kind: 'owned'; owner: LockOwner; mtimeMs: number };

function parseOwner(text: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { pid, host, at, token } = value as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof host !== 'string' || typeof at !== 'number' || typeof token !== 'string') return null;
    return { pid, host, at, token };
  } catch {
    return null;
  }
}

async function readState(path: string): Promise<LockState> {
  try {
    const text = await readFile(path, 'utf8');
    const { mtimeMs } = await stat(path);
    const owner = parseOwner(text);
    return owner ? { kind: 'owned', owner, mtimeMs } : { kind: 'unreadable', mtimeMs };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'gone' };
    if (isWindowsTransient(error)) return { kind: 'busy' };
    throw error;
  }
}

/** Verdadeiro se existe um processo com esse PID nesta máquina (mesmo que seja de outro usuário). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

function isStale(state: LockState, staleMs: number): boolean {
  if (state.kind === 'gone' || state.kind === 'busy') return false;
  const age = Date.now() - state.mtimeMs;
  if (state.kind === 'unreadable') return age > Math.min(staleMs, UNREADABLE_STALE_MS);
  if (age > staleMs) return true;
  // Em outra máquina (pasta de rede) não há como perguntar pelo processo: só a idade decide.
  return state.owner.host === hostname() && !pidAlive(state.owner.pid);
}

/**
 * Cria o arquivo de trava com `wx` (falha se já existe: é isso que dá a exclusão mútua). Depois de escrever, relê
 * para confirmar que o arquivo no caminho ainda é o nosso: se ficamos parados entre criar e escrever, outro
 * processo pode ter tomado a trava vazia por abandonada.
 */
async function tryCreate(path: string, owner: LockOwner): Promise<{ ok: true } | { ok: false; error: unknown }> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    // No Windows, um arquivo recém-apagado ainda aberto por alguém responde EPERM/EACCES em vez de EEXIST.
    if (isErrno(error, 'EEXIST') || isWindowsTransient(error)) return { ok: false, error };
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(owner));
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  await handle.close();
  const state = await readState(path);
  if (state.kind === 'owned' && state.owner.token === owner.token) return { ok: true };
  return { ok: false, error: undefined };
}

/**
 * Remove uma trava abandonada. Um segundo arquivo exclusivo (`.steal`) garante que só um processo por vez faz a
 * remoção, e a trava é conferida de novo lá dentro; sem isso, dois processos que vissem a mesma trava morta
 * poderiam apagar, um depois do outro, a trava morta e a trava nova que o primeiro acabou de criar.
 */
async function removeIfStale(path: string, staleMs: number): Promise<void> {
  const mutex = `${path}.steal`;
  try {
    await (await open(mutex, 'wx')).close();
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      try {
        if (Date.now() - (await stat(mutex)).mtimeMs > STEAL_MUTEX_STALE_MS) await unlink(mutex);
      } catch {
        // outro processo já limpou
      }
      return;
    }
    if (isWindowsTransient(error)) return;
    throw error;
  }
  try {
    if (isStale(await readState(path), staleMs)) await unlink(path);
  } catch (error) {
    if (!isErrno(error, 'ENOENT') && !isWindowsTransient(error)) throw error;
  } finally {
    await unlink(mutex).catch(() => {});
  }
}

async function unlinkOwn(path: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const state = await readState(path);
      if (state.kind === 'busy') {
        await sleep(10 * (attempt + 1));
        continue;
      }
      // Se a trava no caminho já não é a nossa (foi tomada por idade), ela pertence a outro: não se mexe.
      if (state.kind !== 'owned' || state.owner.token !== token) return;
      await unlink(path);
      return;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      if (!isWindowsTransient(error)) throw error;
      await sleep(10 * (attempt + 1));
    }
  }
}

/**
 * Adquire uma trava entre processos criando `path` de forma exclusiva, com PID, máquina e instante dentro.
 * Espera (com novas tentativas espaçadas) até `timeoutMs`. Toma a trava de quem morreu sem soltar: processo que
 * não existe mais nesta máquina, ou arquivo sem renovação há mais de `staleMs`.
 *
 * A trava é cooperativa e não é reentrante: adquirir duas vezes o mesmo caminho no mesmo processo faz a segunda
 * esperar pela primeira.
 */
export async function acquireLock(path: string, options: LockOptions = {}): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });

  let lastOwner: LockOwner | null = null;
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    const owner: LockOwner = {
      pid: process.pid,
      host: hostname(),
      at: Date.now(),
      token: randomBytes(12).toString('hex'),
    };
    const created = await tryCreate(path, owner);
    if (created.ok) return createHandle(path, owner.token, staleMs);
    lastError = created.error;

    const state = await readState(path);
    if (state.kind === 'owned') lastOwner = state.owner;
    const stale = isStale(state, staleMs);
    if (stale) await removeIfStale(path, staleMs);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LockTimeoutError(path, timeoutMs, lastOwner, lastError);
    // Trava que sumiu ou acabou de ser removida: tenta de novo quase na hora. Em uso: espera crescente com sorteio,
    // para os processos na fila não acordarem todos juntos.
    const free = state.kind === 'gone' || stale;
    const wait = free ? 1 : Math.min(50, 5 + attempt * 5) * (0.5 + Math.random());
    await sleep(Math.min(wait, remaining));
  }
}

function createHandle(path: string, token: string, staleMs: number): LockHandle {
  // Renova a data do arquivo para que uma operação longa (sync em rede lenta) não seja confundida com abandono.
  const heartbeat = setInterval(
    () => {
      void (async () => {
        try {
          const state = await readState(path);
          if (state.kind === 'busy') return;
          if (state.kind !== 'owned' || state.owner.token !== token) {
            clearInterval(heartbeat);
            return;
          }
          const now = new Date();
          await utimes(path, now, now);
        } catch {
          // a próxima batida tenta de novo
        }
      })();
    },
    Math.max(10, Math.min(staleMs / 4, 30_000)),
  );
  // Não segura o processo aberto: quem esquecer de soltar ainda consegue sair.
  heartbeat.unref();

  let released: Promise<void> | undefined;
  return {
    release() {
      if (!released) {
        clearInterval(heartbeat);
        released = unlinkOwn(path, token);
      }
      return released;
    },
  };
}

/** Executa `fn` com a trava em mãos e a solta no fim, mesmo se `fn` lançar. */
export async function withLock<T>(path: string, fn: () => T | Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = await acquireLock(path, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
