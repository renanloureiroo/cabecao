// O processo do agente: sem shell, com tempo limite e encerramento da ÁRVORE de processos (o agente, o servidor MCP que
// ele sobe e o que mais ele iniciar) nos três sistemas. No macOS e no Linux o agente vira líder de um grupo de processos
// (`detached`) e o grupo inteiro recebe o sinal; no Windows, `taskkill /T /F` derruba a árvore a partir do pid.
import type { ChildProcess } from 'node:child_process';
import type { Env } from '../types.ts';

export interface AgentProcessOptions {
  readonly cwd: string;
  readonly env: Env;
  readonly stdin: string | null;
  readonly timeoutMs: number;
  readonly platform: NodeJS.Platform;
  /** Quanto esperar entre o pedido educado (SIGTERM) e o forçado (SIGKILL). */
  readonly graceMs?: number;
}

export interface AgentProcessResult {
  /** Código de saída, ou `null` quando o processo morreu por sinal ou nem chegou a rodar. */
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** O usuário interrompeu (Ctrl+C) ou o `cabecao` recebeu SIGTERM. */
  readonly interrupted: boolean;
  /** O programa não pôde ser iniciado (não existe, sem permissão). */
  readonly spawnError: string | null;
  readonly durationMs: number;
}

/** Quanto de cada saída fica guardado (o fim, que é onde está o resultado). */
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_GRACE_MS = 5000;

function keepTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
}

function isAlive(pid: number, group: boolean): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Manda o sinal para a árvore do processo. Nunca lança: o processo pode já ter saído. */
async function signalTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
  options: Pick<AgentProcessOptions, 'platform' | 'env'>,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (options.platform === 'win32') {
    // `taskkill /T` precisa do pai vivo para achar os filhos; depois que ele sai, só sobra matar o que restou dele
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

/**
 * Roda o agente e espera ele sair. Ao fim (saída normal, tempo limite ou interrupção), o que sobrou do grupo de
 * processos recebe SIGTERM e, passada a tolerância, SIGKILL: nenhum filho fica para trás. O SIGTERM primeiro dá ao
 * servidor MCP a chance de terminar a escrita em andamento e fechar o banco.
 */
export async function runAgentProcess(
  file: string,
  args: readonly string[],
  options: AgentProcessOptions,
): Promise<AgentProcessResult> {
  const { spawn } = await import('node:child_process');
  const started = Date.now();
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const posix = options.platform !== 'win32';
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let interrupted = false;

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
    return {
      code: null,
      signal: null,
      stdout,
      stderr,
      timedOut,
      interrupted,
      spawnError: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout = keepTail(stdout, chunk);
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = keepTail(stderr, chunk);
  });
  child.stdin?.on('error', () => {
    // o agente fechou a entrada antes de ler tudo: o resultado dele diz o que houve
  });
  if (options.stdin !== null) child.stdin?.end(options.stdin);
  else child.stdin?.end();

  const closed = new Promise((resolve) => child.on('close', resolve));
  let spawnError: string | null = null;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', (error) => {
      spawnError = error.message;
      resolve({ code: null, signal: null });
    });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  let killTimer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    void signalTree(child, 'SIGTERM', options);
    killTimer ??= setTimeout(() => void signalTree(child, 'SIGKILL', options), grace);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onSignal = (): void => {
    interrupted = true;
    stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let exit: { code: number | null; signal: string | null };
  try {
    exit = await exited;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  // o agente saiu: o que sobrou do grupo (um servidor MCP que não fechou) recebe SIGTERM, depois SIGKILL
  const pid = child.pid;
  if (posix && pid !== undefined && isAlive(pid, true)) {
    await signalTree(child, 'SIGTERM', options);
    const deadline = Date.now() + grace;
    while (isAlive(pid, true) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (isAlive(pid, true)) await signalTree(child, 'SIGKILL', options);
  }
  // espera as saídas esvaziarem, sem ficar preso a um neto que herdou o pipe
  let waitTimer: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise((resolve) => (waitTimer = setTimeout(resolve, 2000)))]);
  clearTimeout(waitTimer);
  child.stdout?.destroy();
  child.stderr?.destroy();

  return {
    code: exit.code,
    signal: exit.signal,
    stdout,
    stderr,
    timedOut,
    interrupted,
    spawnError,
    durationMs: Date.now() - started,
  };
}
