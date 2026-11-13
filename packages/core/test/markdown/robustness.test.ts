// Entradas hostis ou estranhas: o parser não lança e não fica quadrático.
import { describe, expect, it } from 'vitest';
import { parseNote } from '../../src/markdown/index.ts';

describe('robustez', () => {
  it('não lança com entradas degeneradas', () => {
    const inputs = [
      '',
      '﻿',
      '\n',
      '\r\n\r\n',
      '---',
      '---\n',
      '---\n---',
      '---\n---\n---\n---\n',
      '[[',
      ']]',
      '![[',
      '[[]]',
      '```',
      '~~~\n```',
      '%%',
      '<!--',
      '#',
      '######',
      '===',
      '---\n: :\n---\n',
      '---\n\t\tx\n---\n',
      '\u0000\u0001[[a\u0000b]]',
      '\ud83d[[x]]\ude00',
      '> > > ```\n> > x',
      '-\n-\n-',
      '1.\n2)',
      '\\',
      '`',
      '](',
      '[](',
      '[]()',
      '![](a b)',
    ];
    for (const input of inputs) {
      expect(() => parseNote(input), JSON.stringify(input)).not.toThrow();
    }
  });

  it('não lança com combinações aleatórias de marcas (semente fixa)', () => {
    const pieces = ['[[', ']]', '|', '#', '`', '```', '~~~', '%%', '<!--', '-->', '\\', '\n', '\r\n', '    ', '\t'];
    pieces.push('- ', '> ', '---', '===', 'a', 'é', ' ', '![', '](', ')', '😀', '1. ', '$', '*', '_', '﻿');
    let seed = 20261112;
    const random = (): number => {
      // gerador congruente linear: o mesmo resultado em qualquer máquina
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 400; round++) {
      let src = '';
      const length = 1 + Math.floor(random() * 80);
      for (let k = 0; k < length; k++) src += pieces[Math.floor(random() * pieces.length)] ?? '';
      const note = parseNote(src, { targetTokens: 1 + Math.floor(random() * 40) });
      for (const link of note.links) {
        expect(link.line, JSON.stringify(src)).toBeGreaterThanOrEqual(1);
        expect(link.target.includes(']'), JSON.stringify(src)).toBe(false);
      }
      for (const chunk of note.chunks) expect(chunk.text.trim(), JSON.stringify(src)).not.toBe('');
      const lineCount = src.split('\n').length;
      for (const section of note.sections) {
        expect(section.startLine, JSON.stringify(src)).toBeLessThanOrEqual(section.endLine);
        expect(section.endLine, JSON.stringify(src)).toBeLessThanOrEqual(lineCount);
      }
    }
  });

  it('linhas enormes e repetitivas terminam rápido (sem regex quadrática)', () => {
    const n = 200_000;
    const hostile = [
      '['.repeat(n),
      `${'['.repeat(n)}](x)`,
      '[['.repeat(n / 2),
      ']('.repeat(n / 2),
      `[a](${'b'.repeat(n)}`,
      '](a'.repeat(n / 3),
      `# título${' '.repeat(n)}x`,
      `# título${' #'.repeat(n / 2)}x`,
      `---${' '.repeat(n)}x`,
      `${' '.repeat(n)}x`,
      `${'> '.repeat(n / 2)}x`,
      '`'.repeat(n),
      '` '.repeat(n / 2),
      '%% '.repeat(n / 3),
      '<!-- '.repeat(n / 5),
      '\\['.repeat(n / 2),
      `[[${'a|'.repeat(n / 2)}`,
      `${'*a'.repeat(n / 2)}`,
      `---\n${'a: [[\n'.repeat(1000)}---\n`,
      'palavra '.repeat(n / 8),
      'x'.repeat(n),
      `\`\`\`\n${'linha de código\n'.repeat(n / 16)}`,
    ];
    const started = performance.now();
    for (const src of hostile) parseNote(src);
    // folga enorme: com um caso quadrático, só ele levaria dezenas de segundos
    expect(performance.now() - started).toBeLessThan(4000);
  });

  it('nota grande: os trechos cobrem o texto todo e as linhas batem', () => {
    const parts: string[] = [];
    for (let s = 0; s < 40; s++) {
      parts.push(`## Seção ${s}`, '');
      for (let p = 0; p < 6; p++) {
        parts.push(
          `Parágrafo ${p} da seção ${s}, com um link para [[Nota ${s}-${p}]] e mais texto. `.repeat(6).trim(),
          '',
        );
      }
    }
    const src = `# Nota grande\n\n${parts.join('\n')}`;
    const note = parseNote(src);
    expect(note.headings).toHaveLength(41);
    expect(note.links).toHaveLength(40 * 6 * 6);
    const fileLines = src.split('\n');
    for (const chunk of note.chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(350);
      expect(chunk.contextPrefix).toBe(`Nota grande › ${chunk.headingPath[1]}`);
      // parágrafos inteiros: o texto do trecho é exatamente o que está entre as linhas dele
      expect(fileLines.slice(chunk.startLine - 1, chunk.endLine).join('\n')).toBe(chunk.text);
    }
    const paragraphsInChunks = note.chunks.flatMap((c) => c.text.split('\n\n'));
    expect(paragraphsInChunks).toHaveLength(40 * 6);
  });
});
