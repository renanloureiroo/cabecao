import { closeSync, openSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemExec } from './exec.ts';
import { execute } from './router.ts';
import type { CliIo, CommandSpec, ControllingTerminal, Exec, StdinLimits } from './types.ts';

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
      // como biblioteca (testes), a configuração do provedor de respostas nunca é a real da máquina: sem uma pasta
      // pedida, uma que não existe (nada configurado)
      llmConfigDir: join(tmpdir(), `cabecao-run-sem-llm-${process.pid}`),
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

/** Caminhos do terminal controlador: no POSIX, `/dev/tty`; no Windows, os dois lados do console. */
function terminalPaths(platform: NodeJS.Platform): { input: string; output: string } {
  return platform === 'win32'
    ? { input: '\\\\.\\CONIN$', output: '\\\\.\\CONOUT$' }
    : { input: '/dev/tty', output: '/dev/tty' };
}

/**
 * O processo tem um terminal controlador? Abre e fecha o terminal (no POSIX, `/dev/tty` falha com `ENXIO` quando não
 * há; é assim que roda o Bash do Claude Code, um cron ou um serviço). Custa uma chamada de sistema.
 */
function hasControllingTerminal(platform: NodeJS.Platform): boolean {
  const { input } = terminalPaths(platform);
  try {
    closeSync(openSync(input, 'r+'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pergunta sem eco (uma chave de API), direto no terminal controlador, em modo cru, caractere a caractere: Enter
 * termina, Backspace apaga, Ctrl+C ou Ctrl+D cancelam (devolve `null`). Nada do que é digitado aparece na tela.
 */
async function terminalSecret(platform: NodeJS.Platform, question: string): Promise<string | null> {
  const { input: inPath, output: outPath } = terminalPaths(platform);
  const tty = await import('node:tty');
  let input: InstanceType<typeof tty.ReadStream> | undefined;
  let output: InstanceType<typeof tty.WriteStream> | undefined;
  try {
    input = new tty.ReadStream(openSync(inPath, 'r'));
    output = new tty.WriteStream(openSync(outPath, 'w'));
  } catch {
    input?.destroy();
    return null;
  }
  const read = input;
  const write = output;
  write.write(question);
  return new Promise((resolve) => {
    let value = '';
    const finish = (result: string | null): void => {
      read.off('data', onData);
      read.setRawMode(false);
      write.write('\n');
      read.destroy();
      write.destroy();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          finish(value.trim());
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          finish(null);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    read.setRawMode(true);
    read.on('data', onData);
  });
}

/** Ctrl+C vira cancelamento enquanto o comando quiser (o `ask` encerra o provedor e sai). */
function watchInterrupt(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort(new Error('interrompido'));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

/**
 * Pergunta direto no terminal controlador, uma linha, sem passar pelo stdin (que pode ser um pipe com o conteúdo de
 * uma nota, ou um agente). `node:readline` e `node:tty` só são carregados quando um comando pergunta algo.
 */
function controllingTerminal(platform: NodeJS.Platform): ControllingTerminal {
  return {
    promptSecret: (question) => terminalSecret(platform, question),
    async prompt(question) {
      const { input: inPath, output: outPath } = terminalPaths(platform);
      const [{ createInterface }, tty] = await Promise.all([import('node:readline/promises'), import('node:tty')]);
      let input: InstanceType<typeof tty.ReadStream> | undefined;
      let output: InstanceType<typeof tty.WriteStream> | undefined;
      try {
        input = new tty.ReadStream(openSync(inPath, 'r'));
        output = new tty.WriteStream(openSync(outPath, 'w'));
      } catch {
        input?.destroy();
        return null;
      }
      const rl = createInterface({ input, output, terminal: true });
      try {
        return (await rl.question(question)).trim();
      } catch {
        return null;
      } finally {
        rl.close();
        input.destroy();
        output.destroy();
      }
    },
  };
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
    columns: process.stdout.isTTY === true ? process.stdout.columns : undefined,
    platform: process.platform,
    homedir: safeHomedir(),
    execPath: process.execPath,
    binPath: process.argv[1],
    exec: systemExec,
    readStdin: processStdin,
    exit: flushAndExit,
    watchInterrupt,
    ...(hasControllingTerminal(process.platform) ? { terminal: controllingTerminal(process.platform) } : {}),
  });
}
