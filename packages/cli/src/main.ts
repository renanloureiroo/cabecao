import { homedir } from 'node:os';
import { systemExec } from './exec.ts';
import { execute } from './router.ts';
import type { CliIo, CommandSpec, Exec, StdinLimits } from './types.ts';

export { VERSION } from './version.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** O que `run` deixa trocar: tudo do processo, menos os argumentos e as saídas, mais o registro de comandos. */
export interface RunOptions extends Partial<Omit<CliIo, 'argv' | 'stdout' | 'stderr'>> {
  commands?: readonly CommandSpec[];
}

const noExec: Exec = async (file) => {
  throw new Error(`nenhum executor de comandos foi injetado (tentou rodar ${file})`);
};

/**
 * Executa a CLI sem tocar no processo: recebe os argumentos e devolve o que seria escrito e o código de saída.
 * Sem `options`, o ambiente é vazio e nenhum programa externo roda: um teste só enxerga o que injetar.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<CliResult> {
  const { commands, ...io } = options;
  const out: string[] = [];
  const err: string[] = [];
  const code = await execute(
    {
      env: {},
      cwd: process.cwd(),
      platform: process.platform,
      execPath: process.execPath,
      exec: noExec,
      ...io,
      argv,
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
    commands,
  );
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    // sem pasta do usuário conhecida: quem precisar dela acusa o erro com mensagem própria
    return undefined;
  }
}

/** Pergunta no terminal, uma linha. O `node:readline` só é carregado quando um comando pergunta algo. */
async function terminalPrompt(question: string): Promise<string | null> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** Entrada padrão do processo, lida só por quem pede (modos de hook). O leitor é carregado só quando usado. */
async function processStdin(limits: StdinLimits): Promise<string | null> {
  if (process.stdin.isTTY === true) return null;
  const { readLimited } = await import('./stdin.ts');
  return readLimited(process.stdin, limits);
}

/** Sai depois que o que já foi escrito em stdout e stderr chegou ao destino (num pipe do macOS a escrita é assíncrona). */
function flushAndExit(code: number): void {
  process.exitCode = code;
  process.stderr.write('', () => process.stdout.write('', () => process.exit(code)));
}

/** Entrada usada pelo bin: liga a CLI ao processo de verdade. Nunca rejeita: o bin só trata falha de carga. */
export async function main(argv: readonly string[]): Promise<void> {
  let cwd: string;
  try {
    cwd = process.cwd();
  } catch {
    // Acontece quando a pasta atual foi apagada com o terminal ainda dentro dela.
    process.stderr.write('cabecao: a pasta atual não existe mais; entre em outra pasta e rode de novo.\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await execute({
    argv,
    env: process.env,
    cwd,
    stdout: process.stdout,
    stderr: process.stderr,
    platform: process.platform,
    homedir: safeHomedir(),
    execPath: process.execPath,
    binPath: process.argv[1],
    exec: systemExec,
    readStdin: processStdin,
    exit: flushAndExit,
    ...(process.stdin.isTTY === true && process.stderr.isTTY === true ? { prompt: terminalPrompt } : {}),
  });
}
