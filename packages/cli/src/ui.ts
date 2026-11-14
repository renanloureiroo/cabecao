// A cara do Cabeção no terminal: a cor da marca, o símbolo desenhado em meio-blocos, a lista de escolha e o progresso
// dos passos. Tudo aqui é enfeite sobre texto que funciona sem ele: sem terminal, com `NO_COLOR` ou com `TERM=dumb`
// (e sempre com `--json`, num pipe ou para um agente), sai texto puro, sem nenhum código de escape.
import type { CommandContext, Env, OutputStyle, SelectOption } from './types.ts';

const ESC = '\u001b';

/** A saída aceita cor? Segue o clig.dev: é um terminal, `NO_COLOR` vazio ou ausente, e `TERM` diferente de `dumb`. */
export function colorAllowed(isTty: boolean, env: Env): boolean {
  return isTty && (env.NO_COLOR ?? '') === '' && env.TERM !== 'dumb';
}

export function outputStyle(tty: { stdout: boolean; stderr: boolean }, env: Env): OutputStyle {
  return { stdout: colorAllowed(tty.stdout, env), stderr: colorAllowed(tty.stderr, env) };
}

export interface Paint {
  readonly on: boolean;
  /** O vermelho da marca (#d1202f). */
  brand(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
}

const same = (text: string): string => text;
const PLAIN: Paint = { on: false, brand: same, bold: same, dim: same, ok: same, warn: same };

/** Os estilos, ligados ou não. Sem cor de 24 bits declarada (`COLORTERM`), o vermelho da marca vira o 160 da paleta. */
export function paint(on: boolean, env: Env = {}): Paint {
  if (!on) return PLAIN;
  const sgr =
    (code: string) =>
    (text: string): string =>
      text === '' ? '' : `${ESC}[${code}m${text}${ESC}[0m`;
  const truecolor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '');
  return {
    on: true,
    brand: sgr(truecolor ? '38;2;209;32;47' : '38;5;160'),
    bold: sgr('1'),
    dim: sgr('2'),
    ok: sgr('32'),
    warn: sgr('33'),
  };
}

// O símbolo da marca (`assets/marca/simbolo-*.svg`), célula a célula: `#` é a tinta, `o` é o cursor.
const MARK = [
  '  #######   ',
  ' #########  ',
  '###     ### ',
  '##        ##',
  '##        ##',
  '##          ',
  '##  oooo ###',
  '### oooo##  ',
  ' ########   ',
  '  ####      ',
  '  ####      ',
  '            ',
] as const;

/** O símbolo em seis linhas de texto (duas linhas da grade por linha, com meio-bloco). Sem cor, o cursor sai em `▒`. */
export function mascot(p: Paint): string[] {
  const lines: string[] = [];
  for (let y = 0; y < MARK.length; y += 2) {
    const top = MARK[y] ?? '';
    const bottom = MARK[y + 1] ?? '';
    // trechos seguidos da mesma tinta saem num só código de cor
    let line = '';
    let run = '';
    const flush = (): void => {
      line += p.brand(run);
      run = '';
    };
    for (let x = 0; x < top.length; x++) {
      const up = top[x] !== ' ';
      const down = bottom[x] !== ' ';
      const cursor = top[x] === 'o' || bottom[x] === 'o';
      const block = up && down ? '█' : up ? '▀' : down ? '▄' : ' ';
      if (block !== ' ' && !cursor) {
        run += block;
        continue;
      }
      flush();
      line += block === ' ' ? ' ' : p.on ? block : '▒';
    }
    flush();
    lines.push(line);
  }
  return lines;
}

/** O símbolo com o nome e uma frase ao lado: a abertura do `init`. */
export function banner(p: Paint, title: string, tagline: string): string {
  const side = ['', p.bold(title), p.dim(tagline)];
  return mascot(p)
    .map((line, i) => `  ${line}   ${side[i] ?? ''}`.trimEnd())
    .join('\n');
}

const clip = (text: string, width: number): string =>
  width <= 0 ? '' : [...text].length <= width ? text : `${[...text].slice(0, Math.max(0, width - 1)).join('')}…`;

/**
 * As linhas da lista de escolha. Nenhuma passa de `columns` (uma linha que quebra desalinha o redesenho): a dica é
 * cortada primeiro, depois o nome.
 */
export function renderSelect(
  p: Paint,
  question: string,
  options: readonly SelectOption[],
  active: number,
  columns = 80,
): string[] {
  const room = Math.max(20, columns - 1);
  const width = Math.min(Math.max(...options.map((option) => [...option.label].length)), room - 4);
  const lines = [`${p.brand('?')} ${p.bold(clip(question, room - 2))}`];
  options.forEach((option, i) => {
    const label = clip(option.label, width).padEnd(width);
    const hint = clip(option.hint ?? '', room - 4 - width - 2);
    const tail = hint === '' ? '' : `  ${p.dim(hint)}`;
    lines.push(i === active ? `  ${p.brand('❯')} ${p.bold(label)}${tail}` : `    ${label}${tail}`);
  });
  lines.push(p.dim(clip('  ↑↓ escolhe · Enter confirma · Esc cancela', room)));
  return lines;
}

/** A pergunta já respondida, numa linha só: o histórico do terminal fica curto. */
export function answeredLine(p: Paint, question: string, answer: string | null, columns = 80): string {
  const room = Math.max(20, columns - 1);
  return answer === null
    ? `${p.dim('✗')} ${clip(question, room - 12)} ${p.dim('cancelado')}`
    : `${p.ok('✓')} ${clip(`${question} ${answer}`, room - 2)}`;
}

type Asker = Pick<CommandContext, 'prompt' | 'select'>;

/**
 * Sim ou não. Com as setas quando o terminal permite (o padrão já vem marcado); senão, a pergunta de uma linha com
 * `[S/n]` ou `[s/N]`. Sem resposta (cancelou, ou não há como perguntar), é não.
 */
export async function confirm(ctx: Asker, question: string, byDefault = false): Promise<boolean> {
  if (ctx.select !== undefined) {
    const options = byDefault ? ['Sim', 'Não'] : ['Não', 'Sim'];
    const picked = await ctx.select(
      question,
      options.map((label) => ({ label })),
    );
    return picked !== null && options[picked] === 'Sim';
  }
  if (ctx.prompt === undefined) return false;
  const answer = await ctx.prompt(`${question} ${byDefault ? '[S/n]' : '[s/N]'} `);
  if (answer === null) return false;
  const text = answer.trim().toLowerCase();
  return text === '' ? byDefault : ['s', 'sim', 'y', 'yes'].includes(text);
}

export interface Progress {
  /** Começa um passo. `plain` é a linha de quando não há animação (sem ela, o passo não aparece no texto puro). */
  start(label: string, plain?: string): void;
  /** Fecha o passo em andamento com `✓` e, ao lado, o resultado. */
  done(detail?: string): void;
  /** Fecha o passo em andamento com `✗`. */
  fail(): void;
}

/**
 * Progresso dos passos de um comando, no stderr. Num terminal, uma linha por passo: enquanto roda, pisca o cursor do
 * símbolo; ao terminar, vira `✓` com o resultado. Fora dele, as linhas `cabecao: ...` de sempre. Com `--json`, nada.
 */
export function progress(ctx: Pick<CommandContext, 'stderr' | 'style' | 'env' | 'json'>): Progress {
  const live = ctx.style?.stderr === true;
  const p = paint(live, ctx.env);
  let current: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  const draw = (): void => {
    ctx.stderr.write(`\r  ${frame++ % 2 === 0 ? '▄' : ' '} ${current}${p.dim('…')}`);
  };
  const close = (symbol: string, detail?: string): void => {
    if (current === null) return;
    clearInterval(timer);
    ctx.stderr.write(
      `\r${ESC}[2K  ${symbol} ${current}${detail === undefined || detail === '' ? '' : p.dim(`  ${detail}`)}\n`,
    );
    current = null;
  };
  return {
    start(label, plain) {
      if (ctx.json) return;
      if (!live) {
        if (plain !== undefined) ctx.stderr.write(`cabecao: ${plain}...\n`);
        return;
      }
      close(p.ok('✓'));
      current = label;
      frame = 0;
      draw();
      timer = setInterval(draw, 400);
      timer.unref();
    },
    done: (detail) => close(p.ok('✓'), detail),
    fail: () => close(p.brand('✗')),
  };
}
