import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildContextPrefix,
  buildEmbedText,
  computeChunkKey,
  DEFAULT_CHUNK_TOKENS,
  estimateTokens,
  formatHeadingPath,
  parseNote,
} from '../../src/markdown/index.ts';

const sentence = (i: number): string => `Esta é a frase número ${i} do parágrafo de teste sobre filas de mensagens.`;
const paragraph = (from: number, count: number): string =>
  Array.from({ length: count }, (_, k) => sentence(from + k)).join(' ');

describe('estimativa de tokens', () => {
  it('é um token a cada 4 unidades UTF-16, arredondando para cima', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(1400))).toBe(350);
  });
});

describe('prefixo de contexto e chave', () => {
  it('junta título e caminho de seção com " › "', () => {
    expect(formatHeadingPath(['A', 'B'])).toBe('A › B');
    expect(buildContextPrefix('Nota', ['Contexto', 'Custo'])).toBe('Nota › Contexto › Custo');
    expect(buildContextPrefix('Nota', [])).toBe('Nota');
    expect(buildContextPrefix(null, ['Contexto'])).toBe('Contexto');
    expect(buildContextPrefix(null, [])).toBe('');
  });

  it('não repete o título quando ele já é o primeiro título do caminho', () => {
    expect(buildContextPrefix('Usar SQS para filas', ['Usar SQS para filas', 'Contexto'])).toBe(
      'Usar SQS para filas › Contexto',
    );
    expect(buildContextPrefix('usar sqs para filas ', ['Usar SQS para filas'])).toBe('Usar SQS para filas');
    expect(buildContextPrefix('Outro', ['Usar SQS para filas'])).toBe('Outro › Usar SQS para filas');
  });

  it('o texto embutido é o prefixo numa linha e o trecho em seguida', () => {
    expect(buildEmbedText('Nota › Seção', 'texto')).toBe('Nota › Seção\ntexto');
    expect(buildEmbedText('', 'texto')).toBe('texto');
  });

  it('a chave é o SHA-256 do texto embutido truncado em 16 bytes, em hex', () => {
    // vetor de teste conhecido: SHA-256("abc") começa com ba7816bf 8f01cfea 414140de 5dae2223
    expect(computeChunkKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223');
    const text = 'Título › Seção\nação e coração';
    expect(computeChunkKey(text)).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 32),
    );
    expect(computeChunkKey(text)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('trechos', () => {
  const note = parseNote(
    [
      '---',
      'title: Usar SQS para filas',
      'tags: [infra]',
      '---',
      '# Usar SQS para filas', // 5
      '',
      'O Atlas migrou para o [[SQS]].', // 7
      '',
      '## Contexto', // 9
      '',
      'O cluster pedia 6 horas por mês.', // 11
      '',
      '- item um', // 13
      '- item dois', // 14
      '',
      '## Vazia', // 16
      '',
      '## Consequência', // 18
      '',
      '```js', // 20
      'const a = 1;',
      '',
      'const b = 2;',
      '```', // 24
      '',
    ].join('\n'),
  );

  it('um trecho por seção com texto, com ordem, caminho, prefixo, linhas e chave', () => {
    expect(note.chunks.map((c) => [c.ord, c.headingPath, c.contextPrefix, c.startLine, c.endLine])).toEqual([
      [0, ['Usar SQS para filas'], 'Usar SQS para filas', 7, 7],
      [1, ['Usar SQS para filas', 'Contexto'], 'Usar SQS para filas › Contexto', 11, 14],
      [2, ['Usar SQS para filas', 'Consequência'], 'Usar SQS para filas › Consequência', 20, 24],
    ]);
    expect(note.chunks[0]?.text).toBe('O Atlas migrou para o [[SQS]].');
    expect(note.chunks[1]?.text).toBe('O cluster pedia 6 horas por mês.\n\n- item um\n- item dois');
    // a linha em branco dentro da cerca fica: o bloco de código é um bloco só
    expect(note.chunks[2]?.text).toBe('```js\nconst a = 1;\n\nconst b = 2;\n```');
    for (const chunk of note.chunks) {
      expect(chunk.embedText).toBe(`${chunk.contextPrefix}\n${chunk.text}`);
      expect(chunk.chunkKey).toBe(computeChunkKey(chunk.embedText));
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    }
  });

  it('nota sem título nem seção: o texto embutido é só o trecho', () => {
    const fact = parseNote('---\ntype: fact\n---\nO Atlas usa SQS.\n');
    expect(fact.chunks).toHaveLength(1);
    expect(fact.chunks[0]).toMatchObject({
      contextPrefix: '',
      text: 'O Atlas usa SQS.',
      embedText: 'O Atlas usa SQS.',
      headingPath: [],
      startLine: 4,
      endLine: 4,
    });
  });

  it('fallbackTitle entra no prefixo', () => {
    const chunk = parseNote('texto', { fallbackTitle: 'Nome do arquivo' }).chunks[0];
    expect(chunk?.embedText).toBe('Nome do arquivo\ntexto');
  });

  it('nota vazia ou só com títulos não tem trechos', () => {
    expect(parseNote('').chunks).toEqual([]);
    expect(parseNote('\n\n  \n').chunks).toEqual([]);
    expect(parseNote('# A\n\n## B\n').chunks).toEqual([]);
  });

  it('junta parágrafos até o alvo e abre outro trecho quando passaria', () => {
    // cada parágrafo tem cerca de 150 tokens: cabem dois em 350, o terceiro abre outro trecho
    const paragraphs = [paragraph(0, 8), paragraph(10, 8), paragraph(20, 8), paragraph(30, 8), paragraph(40, 8)];
    const tokens = estimateTokens(paragraphs[0] ?? '');
    expect(tokens).toBeGreaterThan(120);
    expect(tokens).toBeLessThan(175);
    const long = parseNote(`# Nota\n\n## Seção\n\n${paragraphs.join('\n\n')}\n`);
    expect(long.chunks.map((c) => c.text)).toEqual([
      `${paragraphs[0]}\n\n${paragraphs[1]}`,
      `${paragraphs[2]}\n\n${paragraphs[3]}`,
      paragraphs[4],
    ]);
    expect(long.chunks.map((c) => c.ord)).toEqual([0, 1, 2]);
    expect(long.chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [5, 7],
      [9, 11],
      [13, 13],
    ]);
    for (const chunk of long.chunks) {
      expect(chunk.headingPath).toEqual(['Nota', 'Seção']);
      expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_TOKENS);
    }
  });

  it('um título sempre fecha o trecho, mesmo com pouco texto', () => {
    const short = parseNote('# A\n\num\n\n## B\n\ndois\n\n## C\n\ntrês\n');
    expect(short.chunks.map((c) => [c.text, c.contextPrefix])).toEqual([
      ['um', 'A'],
      ['dois', 'A › B'],
      ['três', 'A › C'],
    ]);
  });

  it('targetTokens muda o tamanho dos trechos', () => {
    const src = `${paragraph(0, 4)}\n\n${paragraph(10, 4)}\n\n${paragraph(20, 4)}\n`;
    expect(parseNote(src).chunks).toHaveLength(1);
    expect(parseNote(src, { targetTokens: 100 }).chunks).toHaveLength(3);
  });

  it('parágrafo gigante é quebrado em fim de frase, sem perder texto', () => {
    const giant = paragraph(0, 120);
    const chunks = parseNote(`# T\n\n${giant}\n`).chunks;
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_TOKENS);
      expect(chunk.text.endsWith('.')).toBe(true);
      expect(chunk.text.startsWith('Esta é a frase')).toBe(true);
      expect([chunk.startLine, chunk.endLine]).toEqual([3, 3]);
    }
    expect(chunks.map((c) => c.text).join(' ')).toBe(giant);
  });

  it('bloco de código gigante é quebrado em quebra de linha e mantém a indentação', () => {
    const codeLines = Array.from({ length: 300 }, (_, i) => `    const valor${i} = calcula(${i});`);
    const src = `# T\n\n\`\`\`ts\n${codeLines.join('\n')}\n\`\`\`\n`;
    const chunks = parseNote(src).chunks;
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_TOKENS);
    expect(chunks.map((c) => c.text).join('\n')).toBe(`\`\`\`ts\n${codeLines.join('\n')}\n\`\`\``);
    // as linhas de cada pedaço batem com o arquivo
    const fileLines = src.split('\n');
    for (const chunk of chunks) {
      expect(
        fileLines
          .slice(chunk.startLine - 1, chunk.endLine)
          .join('\n')
          .trimEnd(),
      ).toBe(chunk.text);
    }
  });

  it('texto sem espaço nem pontuação é cortado no limite, sem partir um emoji', () => {
    const chunks = parseNote(`${'😀'.repeat(2000)}\n`).chunks;
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_TOKENS);
      // nenhum substituto solto: o texto continua sendo UTF-16 bem formado
      expect(Buffer.from(chunk.text, 'utf8').toString('utf8')).toBe(chunk.text);
    }
    expect(chunks.map((c) => c.text).join('')).toBe('😀'.repeat(2000));
  });

  it('nenhum trecho passa de 1,5 vez o alvo, qualquer que seja a mistura de blocos', () => {
    const blocks = [paragraph(0, 3), paragraph(5, 25), 'curto', paragraph(40, 18), 'x'.repeat(3000), paragraph(60, 2)];
    for (const target of [50, 120, 350]) {
      const chunks = parseNote(blocks.join('\n\n'), { targetTokens: target }).chunks;
      for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(target * 1.5);
      expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
    }
  });
});

describe('o que recalcula um embedding (doc 03)', () => {
  const body = '# Título\n\nprimeiro parágrafo\n\n## Seção\n\nsegundo parágrafo\n';
  const keys = (src: string): string[] => parseNote(src).chunks.map((c) => c.chunkKey);
  const base = keys(`---\ntitle: Nota\ntags: [a]\n---\n${body}`);

  it('mudar frontmatter (tags, datas, relações) não muda as chaves', () => {
    expect(keys(`---\ntitle: Nota\ntags: [a, b]\nupdated: 2026-11-12\nuses: ["[[SQS]]"]\n---\n${body}`)).toEqual(base);
  });

  it('trocar LF por CRLF ou acrescentar BOM não muda as chaves', () => {
    const crlf = `---\ntitle: Nota\ntags: [a]\n---\n${body}`.replaceAll('\n', '\r\n');
    expect(keys(crlf)).toEqual(base);
    expect(keys(`﻿${crlf}`)).toEqual(base);
  });

  it('editar um parágrafo muda só o trecho afetado', () => {
    const edited = keys(`---\ntitle: Nota\ntags: [a]\n---\n${body.replace('segundo', 'terceiro')}`);
    expect(edited[0]).toBe(base[0]);
    expect(edited[1]).not.toBe(base[1]);
  });

  it('mudar o título da nota muda todos os trechos', () => {
    const renamed = keys(`---\ntitle: Outra\ntags: [a]\n---\n${body}`);
    expect(renamed).toHaveLength(base.length);
    renamed.forEach((key, i) => {
      expect(key).not.toBe(base[i]);
    });
  });

  it('mudar o título de uma seção muda só os trechos dela', () => {
    const edited = keys(`---\ntitle: Nota\ntags: [a]\n---\n${body.replace('## Seção', '## Outra seção')}`);
    expect(edited[0]).toBe(base[0]);
    expect(edited[1]).not.toBe(base[1]);
  });
});
