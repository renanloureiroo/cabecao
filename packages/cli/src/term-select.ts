// A lista de escolha com as setas, desenhada direto no terminal controlador (nunca no stdin nem no stdout, que podem
// estar redirecionados). Só é carregada quando um comando pergunta algo.
import { openSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { ReadStream, WriteStream } from 'node:tty';
import type { Env, SelectOption } from './types.ts';
import { answeredLine, paint, renderSelect } from './ui.ts';

const ESC = '\u001b';

interface Key {
  name?: string;
  ctrl?: boolean;
}

/**
 * Setas (ou `k`/`j`) movem, um número pula para a opção, Enter confirma, Esc ou Ctrl+C cancelam (devolve `null`). Ao
 * terminar, a lista é apagada e fica uma linha com a pergunta e a resposta.
 */
export async function terminalSelect(
  paths: { input: string; output: string },
  env: Env,
  question: string,
  options: readonly SelectOption[],
  initial = 0,
): Promise<number | null> {
  if (options.length === 0) return null;
  let input: ReadStream | undefined;
  let output: WriteStream | undefined;
  try {
    input = new ReadStream(openSync(paths.input, 'r'));
    output = new WriteStream(openSync(paths.output, 'w'));
  } catch {
    input?.destroy();
    return null;
  }
  const read = input;
  const write = output;
  const p = paint((env.NO_COLOR ?? '') === '', env);
  let active = Math.min(Math.max(0, initial), options.length - 1);
  let drawn = 0;
  const draw = (): void => {
    const lines = renderSelect(p, question, options, active, write.columns || 80);
    write.write(`${drawn > 0 ? `${ESC}[${drawn}A${ESC}[0J` : ''}${lines.join('\n')}\n`);
    drawn = lines.length;
  };
  return new Promise((resolve) => {
    const finish = (picked: number | null): void => {
      read.off('keypress', onKey);
      read.setRawMode(false);
      const answer = picked === null ? null : (options[picked]?.label ?? '');
      write.write(
        `${ESC}[${drawn}A${ESC}[0J${answeredLine(p, question, answer, write.columns || 80)}\n${ESC}[?25h`,
        () => {
          read.destroy();
          write.destroy();
          resolve(picked);
        },
      );
    };
    const onKey = (text: string | undefined, key: Key | undefined): void => {
      if (key?.name === 'return' || key?.name === 'enter') {
        finish(active);
        return;
      }
      if (key?.name === 'escape' || (key?.ctrl === true && (key.name === 'c' || key.name === 'd'))) {
        finish(null);
        return;
      }
      if (key?.name === 'up' || key?.name === 'k') active = (active - 1 + options.length) % options.length;
      else if (key?.name === 'down' || key?.name === 'j' || key?.name === 'tab') active = (active + 1) % options.length;
      else if (text !== undefined && /^[1-9]$/.test(text) && Number(text) <= options.length) active = Number(text) - 1;
      else return;
      draw();
    };
    emitKeypressEvents(read);
    read.setRawMode(true);
    read.on('keypress', onKey);
    read.resume();
    write.write(`${ESC}[?25l`);
    draw();
  });
}
