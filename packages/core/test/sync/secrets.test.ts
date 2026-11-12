// Scanner de segredos do sync aos pedaços (M4): janelas com sobreposição, linha e coluna absolutas, marcador
// `cabecao:allow-secret` na fronteira, binário decidido por extensão E conteúdo.
import { describe, expect, it } from 'vitest';
import { FileScanner, isClearlyBinary, scanFile } from '../../src/sync/secrets.ts';

// montada por partes para nenhum scanner acusar este arquivo de teste
const KEY = `${'AKIA'}Z7QX4M2PLKJH8NVB`;
const WINDOW = 1 << 20;
const OVERLAP = 64 * 1024;

/** Texto de linhas de 100 caracteres (99 + `\n`), com `put` trocando linhas inteiras. */
function lines(count: number, put: Record<number, string>): string {
  const filler = `${'é'.repeat(9)}${'a'.repeat(90)}`; // 99 caracteres, com acento (2 bytes em UTF-8)
  return Array.from({ length: count }, (_, i) => put[i] ?? filler).join('\n');
}

/** Entrega o texto em pedaços de tamanho estranho, cortando caracteres de 2 bytes no meio. */
function scanChunked(path: string, text: string, chunk = 65_537): { line: number; column: number }[] {
  const data = Buffer.from(text, 'utf8');
  const scanner = new FileScanner(path, 'pending');
  for (let i = 0; i < data.length; i += chunk) scanner.push(data.subarray(i, i + chunk));
  return scanner.end().map((hit) => ({ line: hit.line, column: hit.column }));
}

describe('scanner do sync em janelas', () => {
  it('acha cada segredo uma vez, com linha e coluna absolutas, inclusive cortado entre janelas', () => {
    // primeira fronteira: começo da linha que contém o índice WINDOW - OVERLAP; o corte da janela é em WINDOW
    const boundaryLine = Math.floor((WINDOW - OVERLAP) / 100);
    const cutLine = Math.floor(WINDOW / 100);
    const cutColumn = WINDOW - cutLine * 100; // o segredo começa logo antes do corte e termina depois dele
    const put: Record<number, string> = {
      3: `chave ${KEY}`,
      [boundaryLine - 1]: `antes ${KEY}`,
      [boundaryLine]: `${KEY} na fronteira`,
      [cutLine]: `${'b'.repeat(cutColumn - 5)} ${KEY} fim`,
      30000: `bem depois ${KEY}`,
    };
    const hits = scanChunked('raw/log.md', lines(31_000, put));
    expect(hits).toEqual([
      { line: 4, column: 7 },
      { line: boundaryLine, column: 7 },
      { line: boundaryLine + 1, column: 1 },
      { line: cutLine + 1, column: cutColumn - 3 },
      { line: 30_001, column: 12 },
    ]);
  });

  it('o marcador na linha anterior vale mesmo quando o segredo cai no começo de uma janela', () => {
    const boundaryLine = Math.floor((WINDOW - OVERLAP) / 100);
    const put: Record<number, string> = {
      [boundaryLine - 1]: '<!-- cabecao:allow-secret -->',
      [boundaryLine]: `${KEY} liberado`,
    };
    expect(scanChunked('raw/log.md', lines(15_000, put))).toEqual([]);
  });

  it('linha única de vários MB (JSON minificado): coluna absoluta certa', () => {
    const before = 'x'.repeat(WINDOW - 10);
    const text = `${before} ${KEY} ${'y'.repeat(2 * WINDOW)}`;
    expect(scanChunked('dashboards/dados.json', text)).toEqual([{ line: 1, column: before.length + 2 }]);
  });

  it('em memória e aos pedaços dão o mesmo resultado', () => {
    const text = lines(25_000, { 10: `a ${KEY}`, 12000: `b ${KEY}`, 24999: `c ${KEY}` });
    const whole = scanFile('raw/x.md', Buffer.from(text), 'pending').map((h) => ({ line: h.line, column: h.column }));
    expect(scanChunked('raw/x.md', text, 4096)).toEqual(whole);
    expect(whole).toHaveLength(3);
  });
});

describe('isClearlyBinary: extensão conhecida E conteúdo', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  it('binário só com as duas coisas', () => {
    expect(isClearlyBinary('raw/a.png', png)).toBe(true);
    expect(isClearlyBinary('raw/a.PDF', Buffer.from('%PDF-1.7\n'))).toBe(true);
    expect(isClearlyBinary('raw/a.conflict-pc-20261112-143210.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isClearlyBinary('raw/a.zip', Buffer.from('texto\0com nulo'))).toBe(true);
  });
  it('byte nulo num .md, extensão desconhecida ou .png que é texto: não é binário (é escaneado)', () => {
    expect(isClearlyBinary('raw/a.md', Buffer.from('\0abc'))).toBe(false);
    expect(isClearlyBinary('raw/a.bin', Buffer.from('\0abc'))).toBe(false);
    expect(isClearlyBinary('raw/sem-extensao', png)).toBe(false);
    expect(isClearlyBinary('raw/a.png', Buffer.from('não sou imagem'))).toBe(false);
  });
  it('binário não é escaneado; o mesmo conteúdo num .md é', () => {
    const data = Buffer.concat([png, Buffer.from(` ${KEY}\n`)]);
    expect(scanFile('raw/a.png', data, 'pending')).toEqual([]);
    expect(scanFile('raw/a.md', data, 'pending')).toHaveLength(1);
  });
});
