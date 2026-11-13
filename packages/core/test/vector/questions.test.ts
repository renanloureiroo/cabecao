import { describe, expect, it } from 'vitest';
import { EvalQuestionsError, parseEvalQuestions } from '../../src/vector/index.ts';

function issuesOf(text: string): { line: number; message: string }[] {
  try {
    parseEvalQuestions(text, 'eval.jsonl');
  } catch (error) {
    expect(error).toBeInstanceOf(EvalQuestionsError);
    return [...(error as EvalQuestionsError).issues];
  }
  throw new Error('esperava EvalQuestionsError');
}

describe('parseEvalQuestions (JSON Lines escrito à mão)', () => {
  it('lê o exemplo documentado: comentários, linhas em branco, expected texto ou lista, kind e id opcionais', () => {
    const text = [
      '# Perguntas sobre o projeto Atlas.',
      '',
      '{"query": "como restauro o backup do banco?", "expected": "projects/atlas/backup.md", "kind": "paraphrase"}',
      '// outro comentário',
      '{"id": "erro-lock", "query": "ERR_SYNC_LOCK", "expected": ["01JC3M7Q8Z5X2V9K4T6N1B0RWE"], "kind": "exact"}',
      '   {"query": " por que trocamos o SQS? ", "expected": ["decisions/filas.md", "decisions/filas-v2.md"], "note": "duas notas valem"}',
    ].join('\n');
    expect(parseEvalQuestions(text)).toEqual([
      {
        id: 'L3',
        query: 'como restauro o backup do banco?',
        expected: ['projects/atlas/backup.md'],
        kind: 'paraphrase',
      },
      { id: 'erro-lock', query: 'ERR_SYNC_LOCK', expected: ['01JC3M7Q8Z5X2V9K4T6N1B0RWE'], kind: 'exact' },
      { id: 'L6', query: 'por que trocamos o SQS?', expected: ['decisions/filas.md', 'decisions/filas-v2.md'] },
    ]);
  });

  it('aceita BOM e quebras de linha do Windows', () => {
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}{"query": "a", "expected": "x"}\r\n{"query": "b", "expected": "y"}\r\n`;
    expect(parseEvalQuestions(text).map((q) => [q.id, q.query])).toEqual([
      ['L1', 'a'],
      ['L2', 'b'],
    ]);
  });

  it('junta todos os problemas do arquivo, com o número da linha', () => {
    const text = [
      '{"query": "ok", "expected": "a"}',
      '{"query": "quebrado", "expected": ',
      '{"query": "typo", "expect": "a"}',
      '["não é objeto"]',
      '{"query": "", "expected": []}',
      '{"id": "dup", "query": "a", "expected": "a"}',
      '{"id": "dup", "query": "b", "expected": "b"}',
      '{"query": "c", "expected": ["a", "a"], "kind": 3}',
    ].join('\n');
    const issues = issuesOf(text);
    const lines = (n: number) => issues.filter((i) => i.line === n).map((i) => i.message);
    expect(lines(1)).toEqual([]);
    expect(lines(2)[0]).toMatch(/JSON inválido/);
    expect(lines(3)).toEqual([
      expect.stringMatching(/campo desconhecido "expect"/),
      expect.stringMatching(/"expected" precisa/),
    ]);
    expect(lines(4)[0]).toMatch(/esperado um objeto/);
    expect(lines(5)).toEqual([expect.stringMatching(/"query"/), expect.stringMatching(/"expected"/)]);
    expect(lines(6)).toEqual([]);
    expect(lines(7)).toEqual([expect.stringMatching(/id "dup" repetido \(já usado na linha 6\)/)]);
    expect(lines(8)).toEqual([expect.stringMatching(/repete a mesma nota/), expect.stringMatching(/"kind"/)]);
  });

  it('a mensagem do erro cita o arquivo e as linhas', () => {
    expect(() => parseEvalQuestions('{"query": 1, "expected": "a"}', 'meu.jsonl')).toThrow(
      /perguntas inválidas em meu\.jsonl:\n {2}linha 1: "query"/,
    );
  });

  it('arquivo sem nenhuma pergunta é erro', () => {
    expect(issuesOf('# só comentário\n\n')).toEqual([{ line: 0, message: 'nenhuma pergunta no arquivo' }]);
    expect(issuesOf('')).toHaveLength(1);
  });
});
