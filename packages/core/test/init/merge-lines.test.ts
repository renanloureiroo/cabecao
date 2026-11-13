import { describe, expect, it } from 'vitest';
import { mergeGitattributes, mergeGitignore } from '../../src/init/index.ts';

const REQUIRED_IGNORE = ['.cabecao/', '.cabecao-*.tmp'];
const REQUIRED_ATTRIBUTES = ['log.md merge=union'];

describe('mergeGitignore', () => {
  it('arquivo vazio recebe o comentário e as linhas', () => {
    const result = mergeGitignore('', REQUIRED_IGNORE);
    expect(result.added).toEqual(REQUIRED_IGNORE);
    expect(result.content).toBe('# Cabeção\n.cabecao/\n.cabecao-*.tmp\n');
  });

  it('preserva o que havia, byte a byte, e só acrescenta no fim', () => {
    const before = 'node_modules/\n.trash/\n';
    const result = mergeGitignore(before, REQUIRED_IGNORE);
    expect(result.content.startsWith(before)).toBe(true);
    expect(result.content).toBe(`${before}\n# Cabeção\n.cabecao/\n.cabecao-*.tmp\n`);
  });

  it('arquivo sem quebra no fim ganha a quebra antes do acréscimo', () => {
    const result = mergeGitignore('.trash/', REQUIRED_IGNORE);
    expect(result.content).toBe('.trash/\n\n# Cabeção\n.cabecao/\n.cabecao-*.tmp\n');
  });

  it('mantém CRLF quando o arquivo usa CRLF', () => {
    const before = '.trash/\r\n';
    const result = mergeGitignore(before, REQUIRED_IGNORE);
    expect(result.content).toBe('.trash/\r\n\r\n# Cabeção\r\n.cabecao/\r\n.cabecao-*.tmp\r\n');
  });

  it('não repete o que já está lá, em qualquer grafia equivalente', () => {
    for (const variant of ['.cabecao', '/.cabecao', '/.cabecao/', '.cabecao/**', '  .cabecao/  ']) {
      const result = mergeGitignore(`${variant}\n.cabecao-*.tmp\n`, REQUIRED_IGNORE);
      expect(result.added, variant).toEqual([]);
      expect(result.content).toBe(`${variant}\n.cabecao-*.tmp\n`);
    }
  });

  it('comentário e negação não contam como presentes', () => {
    expect(mergeGitignore('# .cabecao/\n', ['.cabecao/']).added).toEqual(['.cabecao/']);
    expect(mergeGitignore('!.cabecao/\n', ['.cabecao/']).added).toEqual(['.cabecao/']);
  });

  it('é idempotente', () => {
    const once = mergeGitignore('a\n', REQUIRED_IGNORE).content;
    const twice = mergeGitignore(once, REQUIRED_IGNORE);
    expect(twice.added).toEqual([]);
    expect(twice.content).toBe(once);
  });
});

describe('mergeGitattributes', () => {
  it('acrescenta quando falta', () => {
    const result = mergeGitattributes('*.png binary\n', REQUIRED_ATTRIBUTES);
    expect(result.added).toEqual(REQUIRED_ATTRIBUTES);
    expect(result.content).toBe('*.png binary\n\n# Cabeção\nlog.md merge=union\n');
  });

  it('reconhece a linha já presente, com ou sem / e com outros atributos', () => {
    for (const line of ['log.md merge=union', '/log.md merge=union', 'log.md   text merge=union']) {
      expect(mergeGitattributes(`${line}\n`, REQUIRED_ATTRIBUTES).added, line).toEqual([]);
    }
  });

  it('uma declaração diferente do mesmo atributo não conta; o acréscimo no fim vence', () => {
    const result = mergeGitattributes('log.md merge=binary\n', REQUIRED_ATTRIBUTES);
    expect(result.added).toEqual(REQUIRED_ATTRIBUTES);
    // a última declaração é a que vale para o git
    expect(mergeGitattributes('log.md merge=union\nlog.md merge=binary\n', REQUIRED_ATTRIBUTES).added).toEqual(
      REQUIRED_ATTRIBUTES,
    );
    expect(mergeGitattributes('log.md merge=binary\nlog.md merge=union\n', REQUIRED_ATTRIBUTES).added).toEqual([]);
  });
});
