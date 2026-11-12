import { describe, expect, it } from 'vitest';
import {
  formatChangeLine,
  formatCommitMessage,
  formatDate,
  parseCommitTrailers,
} from '../../src/git/commit-message.ts';

const DATE = new Date(2026, 10, 12, 14, 32, 10, 482);
const OP = '01JD3K8Y6Z9W2T4N5P7Q8R0S1V';
const SESSION = '01JD3K7M2A8B4C6D9E1F3G5H7J';

describe('formatDate', () => {
  it('usa o formato padrão com milissegundos, no fuso da máquina', () => {
    expect(formatDate(DATE)).toBe('2026-11-12 14:32:10.482');
  });

  it('preenche com zeros', () => {
    expect(formatDate(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('2026-01-02 03:04:05.006');
    expect(formatDate(new Date(2026, 0, 2, 3, 4, 5, 6), 'M/D/YY H:m:s.S')).toBe('1/2/26 3:4:5.0');
  });

  it('aceita os marcadores do moment mais comuns', () => {
    expect(formatDate(DATE, 'YYYYMMDD-HHmmss')).toBe('20261112-143210');
    expect(formatDate(DATE, 'dddd, MMMM Do YYYY, h:mm:ss a')).toBe('Thursday, November 12th 2026, 2:32:10 pm');
    expect(formatDate(DATE, 'ddd D MMM hh:mm A [Q]Q SS')).toBe('Thu 12 Nov 02:32 PM Q4 48');
    expect(formatDate(new Date(2026, 4, 1, 0, 5), 'h:mm A')).toBe('12:05 AM');
    expect(formatDate(new Date(2026, 4, 22), 'Do')).toBe('22nd');
    expect(formatDate(new Date(2026, 4, 3), 'Do')).toBe('3rd');
    expect(formatDate(new Date(2026, 4, 11), 'Do')).toBe('11th');
  });

  it('copia o texto entre colchetes e os caracteres que não são marcadores', () => {
    expect(formatDate(DATE, '[Dia] DD/MM [às] HH[h]mm')).toBe('Dia 12/11 às 14h32');
  });

  it('rende o instante e o deslocamento do fuso', () => {
    expect(formatDate(DATE, 'x')).toBe(String(DATE.getTime()));
    expect(formatDate(DATE, 'X')).toBe(String(Math.floor(DATE.getTime() / 1000)));
    const offset = -DATE.getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
    expect(formatDate(DATE, 'Z')).toBe(`${sign}${hours}:${minutes}`);
    expect(formatDate(DATE, 'ZZ')).toBe(`${sign}${hours}${minutes}`);
  });

  it('recusa data inválida', () => {
    expect(() => formatDate(new Date(Number.NaN))).toThrow(TypeError);
  });
});

describe('formatCommitMessage', () => {
  it('rende o exemplo do documento 12', () => {
    const message = formatCommitMessage({
      date: DATE,
      body: [{ action: 'add', noteType: 'gotcha', title: 'testes de integração falham sem limpar o banco' }],
      trailers: { op: OP, session: SESSION, machine: 'macbook', client: 'claude-code' },
    });
    expect(message).toBe(
      [
        'vault backup: 2026-11-12 14:32:10.482',
        '',
        'add gotcha: testes de integração falham sem limpar o banco',
        '',
        `Cabecao-Op: ${OP}`,
        `Cabecao-Session: ${SESSION}`,
        'Cabecao-Machine: macbook',
        'Cabecao-Client: claude-code',
        '',
      ].join('\n'),
    );
  });

  it('omite a sessão em edições manuais e aceita linhas prontas no corpo', () => {
    const message = formatCommitMessage({
      date: DATE,
      body: [
        'edit: 3 notas alteradas fora do Cabeção',
        '- wiki/concepts/arquitetura-hexagonal.md',
        '',
        '- wiki/decisions/usar-sqs-para-filas.md',
      ],
      trailers: { op: OP, machine: 'macbook', client: 'manual' },
    });
    expect(message).toBe(
      [
        'vault backup: 2026-11-12 14:32:10.482',
        '',
        'edit: 3 notas alteradas fora do Cabeção',
        '- wiki/concepts/arquitetura-hexagonal.md',
        '- wiki/decisions/usar-sqs-para-filas.md',
        '',
        `Cabecao-Op: ${OP}`,
        'Cabecao-Machine: macbook',
        'Cabecao-Client: manual',
        '',
      ].join('\n'),
    );
  });

  it('sem corpo, o assunto é seguido direto pelos rodapés', () => {
    const message = formatCommitMessage({ date: DATE, trailers: { op: OP, machine: 'm', client: 'cli' } });
    expect(message).toBe(
      `vault backup: 2026-11-12 14:32:10.482\n\nCabecao-Op: ${OP}\nCabecao-Machine: m\nCabecao-Client: cli\n`,
    );
  });

  it('substitui todos os marcadores do assunto', () => {
    const message = formatCommitMessage({
      subjectTemplate: '{{hostname}} {{ action }} {{numFiles}} [{{session}}] {{date}} {{outro}}',
      dateFormat: 'YYYY-MM-DD HH:mm',
      date: DATE,
      numFiles: 3,
      body: [{ action: 'consolidate', title: 'semana 46' }, '- add fact: Projeto Atlas usa SQS para filas'],
      trailers: { op: OP, session: SESSION, machine: 'macbook', client: 'codex' },
    });
    expect(message.split('\n')[0]).toBe('macbook consolidate 3 [01JD3K7M] 2026-11-12 14:32 {{outro}}');
    expect(message).toContain('\n\nconsolidate: semana 46\n- add fact: Projeto Atlas usa SQS para filas\n\n');
  });

  it('usa hostname e ação explícitos, e deixa a sessão vazia quando não há', () => {
    const message = formatCommitMessage({
      subjectTemplate: '{{hostname}}|{{action}}|{{session}}|{{numFiles}}',
      date: DATE,
      hostname: 'MacBook-Pro.local',
      action: 'sync',
      trailers: { op: OP, machine: 'macbook', client: 'cli' },
    });
    expect(message.split('\n')[0]).toBe('MacBook-Pro.local|sync||0');
  });

  it('rende um rodapé Cabecao-Reverts por operação desfeita', () => {
    const one = formatCommitMessage({
      date: DATE,
      body: [{ action: 'revert', title: 'operação 01AAA' }],
      trailers: { op: OP, machine: 'm', client: 'cli', reverts: '01AAA' },
    });
    expect(one.endsWith('Cabecao-Client: cli\nCabecao-Reverts: 01AAA\n')).toBe(true);
    const many = formatCommitMessage({
      date: DATE,
      trailers: { op: OP, machine: 'm', client: 'cli', reverts: ['01AAA', '01BBB'] },
    });
    expect(many.endsWith('Cabecao-Reverts: 01AAA\nCabecao-Reverts: 01BBB\n')).toBe(true);
  });

  it('um título com quebras de linha não cria parágrafo nem rodapé falso', () => {
    const message = formatCommitMessage({
      date: DATE,
      body: [{ action: 'add', noteType: 'fact', title: 'título\n\nCabecao-Op: FALSO' }],
      trailers: { op: OP, machine: 'm', client: 'cli' },
    });
    expect(message.split('\n\n')).toHaveLength(3);
    expect(parseCommitTrailers(message).op).toBe(OP);
  });

  it('recusa rodapé vazio ou com quebra de linha', () => {
    const base = { op: OP, machine: 'm', client: 'cli' };
    expect(() => formatCommitMessage({ date: DATE, trailers: { ...base, op: ' ' } })).toThrow(TypeError);
    expect(() => formatCommitMessage({ date: DATE, trailers: { ...base, machine: 'a\nb' } })).toThrow(TypeError);
    expect(() => formatCommitMessage({ date: DATE, trailers: { ...base, session: '' } })).toThrow(TypeError);
    expect(() => formatCommitMessage({ date: DATE, trailers: { ...base, reverts: ['x\ny'] } })).toThrow(TypeError);
    expect(() => formatCommitMessage({ subjectTemplate: ' ', date: DATE, trailers: base })).toThrow(TypeError);
  });

  it('nunca acrescenta coautoria nem atribuição', () => {
    const message = formatCommitMessage({
      date: DATE,
      body: [{ action: 'update', noteType: 'decision', title: 'usar SQS para filas' }],
      trailers: { op: OP, session: SESSION, machine: 'macbook', client: 'claude-code' },
    });
    expect(message).not.toMatch(/co-authored-by|generated with|signed-off-by|noreply@/i);
    const trailerLines = (message.trimEnd().split('\n\n').at(-1) ?? '').split('\n');
    expect(trailerLines.every((line) => line.startsWith('Cabecao-'))).toBe(true);
  });
});

describe('formatChangeLine', () => {
  it('rende com e sem tipo de nota', () => {
    expect(formatChangeLine({ action: 'supersede', noteType: 'decision', title: 'usar SQS' })).toBe(
      'supersede decision: usar SQS',
    );
    expect(formatChangeLine({ action: 'edit', title: '3 notas alteradas fora do Cabeção' })).toBe(
      'edit: 3 notas alteradas fora do Cabeção',
    );
  });
});

describe('parseCommitTrailers', () => {
  it('lê de volta o que formatCommitMessage escreveu', () => {
    const message = formatCommitMessage({
      date: DATE,
      body: ['revert: operação 01AAA'],
      trailers: { op: OP, session: SESSION, machine: 'macbook', client: 'cli', reverts: ['01AAA', '01BBB'] },
    });
    expect(parseCommitTrailers(message)).toEqual({
      op: OP,
      session: SESSION,
      machine: 'macbook',
      client: 'cli',
      reverts: ['01AAA', '01BBB'],
    });
  });

  it('aceita CRLF, espaços sobrando e chave em outra caixa', () => {
    const message = 'assunto\r\n\r\ncorpo\r\n\r\ncabecao-op:  01X  \r\nCABECAO-MACHINE: pc\r\n\r\n';
    expect(parseCommitTrailers(message)).toEqual({ op: '01X', machine: 'pc', reverts: [] });
  });

  it('só considera o último parágrafo', () => {
    const message = 'assunto\n\nCabecao-Op: DO-CORPO\n\nCabecao-Op: 01REAL\nCabecao-Client: cli\n';
    expect(parseCommitTrailers(message)).toEqual({ op: '01REAL', client: 'cli', reverts: [] });
  });

  it('devolve vazio para commits de outros clientes', () => {
    expect(parseCommitTrailers('vault backup: 2026-11-12 14:32:10')).toEqual({ reverts: [] });
    expect(parseCommitTrailers('Cabecao-Op: 01X')).toEqual({ reverts: [] });
    expect(parseCommitTrailers('feat: algo\n\ncorpo qualquer\n\nSigned-off-by: Alguém <a@b.c>\n')).toEqual({
      reverts: [],
    });
    expect(parseCommitTrailers('')).toEqual({ reverts: [] });
  });
});
