import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pasta temporária própria do teste; devolve também a função que a apaga. */
export async function makeTempDir(label: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `cabecao-${label}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

/**
 * Os scripts de apoio são JavaScript puro, mas importam o código TypeScript que está sendo testado. Do Node 22.18
 * em diante isso funciona sozinho; no 22.16 e 22.17 precisa da opção de remoção de tipos.
 */
const TYPE_FLAGS = process.features.typescript ? [] : ['--experimental-strip-types'];

export function childScript(name: string): string {
  return fileURLToPath(new URL(name, import.meta.url));
}

export function spawnChild(script: string, args: string[]): ChildProcess {
  return spawn(process.execPath, ['--no-warnings', ...TYPE_FLAGS, childScript(script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Espera o filho terminar, juntando o que ele escreveu. */
export function waitChild(child: ChildProcess): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export function runChild(script: string, args: string[]): Promise<ChildResult> {
  return waitChild(spawnChild(script, args));
}

/** Resolve quando o filho escrever `marker` na saída padrão; rejeita se ele terminar antes. */
export function waitForOutput(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const onData = (chunk: Buffer | string) => {
      seen += chunk.toString();
      if (seen.includes(marker)) {
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('close', () => reject(new Error(`o processo filho terminou sem escrever "${marker}": ${seen}`)));
  });
}

/**
 * PID de um processo que acabou de terminar e já foi colhido (o evento `close` só chega depois do `waitpid`): serve
 * de dono morto para uma trava, sem depender de um número "improvável" que pode existir em outra máquina.
 */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  if (pid === undefined) throw new Error('o processo filho não recebeu PID');
  return pid;
}
