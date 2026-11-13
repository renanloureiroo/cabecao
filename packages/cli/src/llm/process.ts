// Processo de um agente instalado que só GERA texto (o provedor "agente" do `ask`): sem shell, com tempo limite,
// cancelamento e encerramento da ÁRVORE de processos nos três sistemas (no macOS e no Linux o agente vira líder de um
// grupo, `detached`, e o grupo inteiro recebe o sinal; no Windows, `taskkill /T /F` a partir do pid).
//
// É uma versão enxuta do `consolidate-run/process.ts` do PR `feat/consolidate-com-agente` (que ainda não está na `main`
// quando este módulo foi escrito): mesma estratégia, mas cancelada por `AbortSignal` em vez de sinais do processo, sem
// servidor MCP para esperar e com teto de saída menor. Quando os dois PRs estiverem juntos, os dois devem virar um só.
import type { ChildProcess } from 'node:child_process';
import type { Env } from '../types.ts';

export interface ToolessRunOptions {
  readonly cwd: string;
  readonly env: Env;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly platform: NodeJS.Platform;
  readonly signal?: AbortSignal;
  /** Tolerância entre o SIGTERM e o SIGKILL. */
  readonly graceMs?: number;
}

export interface ToolessRunResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnError: string | null;
  /** A saída passou do teto e foi cortada (o processo foi encerrado). */
  readonly overflow: boolean;
  readonly durationMs: number;
}

/** Teto de cada saída. A resposta do `ask` cabe em poucos KiB; mais que isto é defeito ou abuso. */
export const TOOLESS_OUTPUT_LIMIT = 2 * 1024 * 1024;
const DEFAULT_GRACE_MS = 3000;

async function signalTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
  options: ToolessRunOptions,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (options.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    const root = options.env.SystemRoot ?? options.env.SYSTEMROOT ?? 'C:\\Windows';
    await new Promise<void>((resolve) => {
      const killer = spawn(`${root}\\System32\\taskkill.exe`, ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // o grupo já não existe
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runToolless(
  file: string,
  args: readonly string[],
  options: ToolessRunOptions,
): Promise<ToolessRunResult> {
  const { spawn } = await import('node:child_process');
  const started = Date.now();
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const posix = options.platform !== 'win32';
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let overflow = false;
  const result = (extra: Partial<ToolessRunResult>): ToolessRunResult => ({
    code: null,
    signal: null,
    stdout,
    stderr,
    timedOut,
    cancelled,
    spawnError: null,
    overflow,
    durationMs: Date.now() - started,
    ...extra,
  });
  if (options.signal?.aborted === true) return result({ cancelled: true });

  let child: ChildProcess;
  try {
    child = spawn(file, [...args], {
      cwd: options.cwd,
      env: { ...options.env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: posix,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    return result({ spawnError: error instanceof Error ? error.message : String(error) });
  }

  let killTimer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    void signalTree(child, 'SIGTERM', options);
    killTimer ??= setTimeout(() => void signalTree(child, 'SIGKILL', options), grace);
  };
  const append = (current: string, chunk: string): string => {
    if (current.length + chunk.length > TOOLESS_OUTPUT_LIMIT) {
      overflow = true;
      stop();
      return current;
    }
    return current + chunk;
  };
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = append(stderr, chunk);
  });
  child.stdin?.on('error', () => {
    // o agente fechou a entrada antes de ler tudo: o resultado dele diz o que houve
  });
  child.stdin?.end(options.stdin);

  const closed = new Promise((resolve) => child.on('close', resolve));
  let spawnError: string | null = null;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', (error) => {
      spawnError = error.message;
      resolve({ code: null, signal: null });
    });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = (): void => {
    cancelled = true;
    stop();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let exit: { code: number | null; signal: string | null };
  try {
    exit = await exited;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
  // o agente saiu: o que sobrou do grupo recebe SIGTERM e, passada a tolerância, SIGKILL
  const pid = child.pid;
  if (posix && pid !== undefined && groupAlive(pid)) {
    await signalTree(child, 'SIGTERM', options);
    const deadline = Date.now() + grace;
    while (groupAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (groupAlive(pid)) await signalTree(child, 'SIGKILL', options);
  }
  let waitTimer: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise((resolve) => (waitTimer = setTimeout(resolve, 2000)))]);
  clearTimeout(waitTimer);
  child.stdout?.destroy();
  child.stderr?.destroy();
  return result({ code: exit.code, signal: exit.signal, spawnError });
}
