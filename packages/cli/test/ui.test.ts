// A cara do terminal: cor da marca, símbolo, lista de escolha, confirmação e progresso. O que importa garantir: sem
// terminal (ou com NO_COLOR) não sai nenhum código de escape, e sem as setas tudo continua funcionando pelo `prompt`.
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { answeredLine, banner, colorAllowed, confirm, mascot, paint, progress, renderSelect } from '../src/ui.ts';
import { disposeSandbox, machine, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(disposeSandbox);

const ESC = String.fromCharCode(27);
const bare = (text: string) => text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const width = (line: string) => [...bare(line)].length;

describe('cor', () => {
  it('só num terminal, sem NO_COLOR e sem TERM=dumb', () => {
    expect(colorAllowed(true, {})).toBe(true);
    expect(colorAllowed(false, {})).toBe(false);
    expect(colorAllowed(true, { NO_COLOR: '1' })).toBe(false);
    expect(colorAllowed(true, { NO_COLOR: '' })).toBe(true);
    expect(colorAllowed(true, { TERM: 'dumb' })).toBe(false);
  });

  it('o vermelho da marca em 24 bits quando o terminal declara, senão o mais próximo da paleta', () => {
    expect(paint(true, { COLORTERM: 'truecolor' }).brand('x')).toBe(`${ESC}[38;2;209;32;47mx${ESC}[0m`);
    expect(paint(true, {}).brand('x')).toBe(`${ESC}[38;5;160mx${ESC}[0m`);
    expect(paint(false).brand('x')).toBe('x');
  });
});

describe('símbolo', () => {
  it('seis linhas de doze colunas; sem cor, nenhum escape e o cursor em ▒', () => {
    const plain = mascot(paint(false));
    expect(plain).toHaveLength(6);
    expect(plain.every((line) => [...line].length === 12)).toBe(true);
    expect(plain.join('\n')).not.toContain(ESC);
    expect(plain[3]).toContain('▒▒▒▒');
    expect(mascot(paint(true)).map(width)).toEqual(plain.map(width));
    expect(banner(paint(false), 'Cabeção', 'frase')).toContain('Cabeção');
  });
});

describe('lista de escolha', () => {
  const options = [
    { label: 'Claude Code', hint: 'achei nesta máquina · usa o login da sua conta' },
    { label: 'Outro serviço compatível com a API da OpenAI', hint: 'você informa o endereço' },
  ];

  it('marca a opção ativa e nenhuma linha passa da largura do terminal', () => {
    const lines = renderSelect(paint(false), 'Quem gera as respostas?', options, 1, 40);
    expect(lines[0]).toBe('? Quem gera as respostas?');
    expect(lines[1]?.startsWith('    Claude Code')).toBe(true);
    expect(lines[2]?.startsWith('  ❯ Outro')).toBe(true);
    expect(Math.max(...lines.map(width))).toBeLessThan(40);
    expect(Math.max(...renderSelect(paint(true), 'Quem gera as respostas?', options, 0, 40).map(width))).toBeLessThan(
      40,
    );
  });

  it('respondida, vira uma linha', () => {
    expect(answeredLine(paint(false), 'Ativar?', 'Sim')).toBe('✓ Ativar? Sim');
    expect(answeredLine(paint(false), 'Ativar?', null)).toBe('✗ Ativar? cancelado');
  });
});

describe('confirmação', () => {
  it('com as setas: o padrão vem primeiro, e cancelar é não', async () => {
    const seen: string[][] = [];
    const picking = (index: number | null) => ({
      select: async (_question: string, list: readonly { label: string }[]) => {
        seen.push(list.map((option) => option.label));
        return index;
      },
    });
    expect(await confirm(picking(0), 'Ativar?')).toBe(false);
    expect(await confirm(picking(1), 'Ativar?')).toBe(true);
    expect(await confirm(picking(0), 'Religar?', true)).toBe(true);
    expect(await confirm(picking(null), 'Religar?', true)).toBe(false);
    expect(seen[0]).toEqual(['Não', 'Sim']);
    expect(seen[2]).toEqual(['Sim', 'Não']);
  });

  it('sem as setas: a pergunta de uma linha, com o padrão no Enter', async () => {
    const asked: string[] = [];
    const typing = (answer: string | null) => ({
      prompt: async (question: string) => {
        asked.push(question);
        return answer;
      },
    });
    expect(await confirm(typing('s'), 'Ativar?')).toBe(true);
    expect(await confirm(typing(''), 'Ativar?')).toBe(false);
    expect(await confirm(typing(''), 'Religar?', true)).toBe(true);
    expect(await confirm(typing(null), 'Religar?', true)).toBe(false);
    expect(await confirm({}, 'Ativar?')).toBe(false);
    expect(asked[0]).toBe('Ativar? [s/N] ');
    expect(asked[2]).toBe('Religar? [S/n] ');
  });
});

describe('progresso', () => {
  const capture = (style: boolean, json = false) => {
    const written: string[] = [];
    const steps = progress({
      stderr: { write: (chunk: string) => written.push(chunk) },
      style: { stdout: style, stderr: style },
      env: {},
      json,
    });
    return { steps, text: () => written.join('') };
  };

  it('fora do terminal: as linhas de sempre, sem escape; com --json, nada', () => {
    const plain = capture(false);
    plain.steps.start('Commit inicial', 'fazendo o commit inicial');
    plain.steps.start('Registrando nos agentes');
    plain.steps.done('Cursor');
    expect(plain.text()).toBe('cabecao: fazendo o commit inicial...\n');
    const json = capture(true, true);
    json.steps.start('Commit inicial', 'fazendo o commit inicial');
    json.steps.done();
    expect(json.text()).toBe('');
  });

  it('no terminal: cada passo fecha numa linha com ✓ e o resultado', () => {
    const live = capture(true);
    live.steps.start('Commit inicial', 'fazendo o commit inicial');
    live.steps.start('Montando o índice local');
    live.steps.done('12 notas');
    live.steps.start('Enviando ao remoto');
    live.steps.fail();
    const text = live.text();
    expect(text).toContain('✓');
    expect(text).toMatch(/Montando o índice local.*12 notas/);
    expect(text).toContain('✗');
    expect(text).not.toContain('cabecao: ');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('init', { timeout: TEST_TIMEOUT_MS }, () => {
  it('num terminal abre com o símbolo e a cor; fora dele, nenhum escape', async () => {
    const a = machine('ui-a');
    const styled = await a.cabecao(['init', '--dir', join(a.home, 'c'), '--no-clients'], {
      style: { stdout: true, stderr: true },
    });
    expect(styled.code).toBe(0);
    expect(bare(styled.stderr)).toContain('▄███████▄');
    expect(styled.stderr).toContain('Cabeção');
    expect(bare(styled.stderr)).toMatch(/✓ Montando o índice local {2}0 notas/);
    expect(styled.stdout).toContain(`${ESC}[1mPronto.${ESC}[0m`);

    const b = machine('ui-b');
    const plain = await b.cabecao(['init', '--dir', join(b.home, 'c'), '--no-clients']);
    expect(plain.stdout + plain.stderr).not.toContain(ESC);
    expect(plain.stderr).not.toContain('███');
    expect(plain.stderr).toContain('cabecao: montando o índice local...');

    const c = machine('ui-c');
    const json = await c.cabecao(['init', '--dir', join(c.home, 'c'), '--no-clients', '--json'], {
      style: { stdout: true, stderr: true },
    });
    expect(json.stdout + json.stderr).not.toContain(ESC);
  });
});
