import { describe, expect, it } from 'vitest';
import type { JsonObjectNode, JsonValue } from '../src/install-client/jsonc.ts';
import { deepEqual, JsoncError, parseJsonc, removeEntry, setEntry, toValue } from '../src/install-client/jsonc.ts';

function objectRoot(text: string): JsonObjectNode {
  const root = parseJsonc(text);
  if (root.type !== 'object') throw new Error('raiz não é objeto');
  return root;
}

function set(text: string, section: string, name: string, value: JsonValue): string {
  return setEntry(text, objectRoot(text), section, name, value);
}

function remove(text: string, section: string, name: string): string {
  return removeEntry(text, objectRoot(text), section, name);
}

const ENTRY = { command: 'node', args: ['/x/cabecao.mjs', 'mcp'] };

describe('parseJsonc', () => {
  it('lê JSON comum igual ao JSON.parse', () => {
    const text = '{"a": [1, -2.5e3, true, false, null, "x\\"y\\u00e9"], "b": {"c": {}}, "d": []}';
    expect(toValue(parseJsonc(text))).toEqual(JSON.parse(text));
  });

  it('aceita comentários, vírgula final e BOM', () => {
    const text = '﻿// topo\n{\n  /* bloco */ "a": 1, // fim de linha\n  "b": [1, 2,],\n}\n';
    expect(toValue(parseJsonc(text))).toEqual({ a: 1, b: [1, 2] });
  });

  it('não confunde // dentro de texto com comentário', () => {
    expect(toValue(parseJsonc('{"url": "https://exemplo.com/a"}'))).toEqual({ url: 'https://exemplo.com/a' });
  });

  it.each([
    ['{"a": 1', 'o arquivo termina'],
    ['{"a" 1}', 'esperava ":"'],
    ['{a: 1}', 'esperava uma chave'],
    ['{"a": 1} x', 'conteúdo depois do fim'],
    ['{"a": "sem fim}', 'sem aspas de fechamento'],
    ['{"a": /* x }', 'comentário sem fim'],
    ['{"a": tru}', 'valor inesperado'],
    ['', 'o arquivo termina'],
  ])('recusa %j com linha e coluna', (text, problem) => {
    expect(() => parseJsonc(text)).toThrow(JsoncError);
    expect(() => parseJsonc(text)).toThrow(problem);
    expect(() => parseJsonc(text)).toThrow(/linha \d+, coluna \d+/);
  });

  it('a linha do erro é a certa', () => {
    try {
      parseJsonc('{\n  "a": 1,\n  "b": ?\n}');
      expect.unreachable();
    } catch (error) {
      expect((error as JsoncError).line).toBe(3);
    }
  });
});

describe('deepEqual', () => {
  it('ignora a ordem das chaves, mas não a dos arrays', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('setEntry', () => {
  it('acrescenta a entrada sem mexer em comentários, outras chaves e formatação', () => {
    const text = [
      '// configuração minha',
      '{',
      '  "theme": "dark", // tema',
      '  "mcpServers": {',
      '    /* o meu servidor */',
      '    "outro": { "command": "x" }',
      '  }',
      '}',
      '',
    ].join('\n');
    const edited = set(text, 'mcpServers', 'cabecao', ENTRY);
    expect(edited.startsWith('// configuração minha\n{\n  "theme": "dark", // tema\n')).toBe(true);
    expect(edited).toContain('/* o meu servidor */\n    "outro": { "command": "x" },\n    "cabecao": {\n');
    expect(edited).toContain('      "command": "node",');
    expect(toValue(parseJsonc(edited))).toEqual({
      theme: 'dark',
      mcpServers: { outro: { command: 'x' }, cabecao: ENTRY },
    });
  });

  it('cria a seção quando falta', () => {
    const edited = set('{\n  "a": 1\n}\n', 'mcpServers', 'cabecao', ENTRY);
    expect(toValue(parseJsonc(edited))).toEqual({ a: 1, mcpServers: { cabecao: ENTRY } });
    expect(edited.startsWith('{\n  "a": 1,\n  "mcpServers": {\n    "cabecao": {')).toBe(true);
  });

  it('preenche objeto vazio, inclusive na raiz', () => {
    expect(toValue(parseJsonc(set('{}', 'mcpServers', 'cabecao', ENTRY)))).toEqual({ mcpServers: { cabecao: ENTRY } });
    const nested = set('{\n  "mcpServers": {}\n}\n', 'mcpServers', 'cabecao', ENTRY);
    expect(toValue(parseJsonc(nested))).toEqual({ mcpServers: { cabecao: ENTRY } });
    expect(nested).toContain('  "mcpServers": {\n    "cabecao": {');
  });

  it('objeto que só tem comentários continua com eles', () => {
    const text = '{\n  "mcpServers": {\n    // nada aqui ainda\n  }\n}\n';
    const edited = set(text, 'mcpServers', 'cabecao', ENTRY);
    expect(edited).toContain('// nada aqui ainda');
    expect(toValue(parseJsonc(edited))).toEqual({ mcpServers: { cabecao: ENTRY } });
  });

  it('mantém o estilo de vírgula final e o comentário da última linha', () => {
    const trailing = set('{\n  "mcpServers": {\n    "a": 1,\n  },\n}\n', 'mcpServers', 'cabecao', 2);
    expect(trailing).toBe('{\n  "mcpServers": {\n    "a": 1,\n    "cabecao": 2,\n  },\n}\n');
    const comment = set('{\n  "mcpServers": {\n    "a": 1 // nota\n  }\n}\n', 'mcpServers', 'cabecao', 2);
    expect(comment).toBe('{\n  "mcpServers": {\n    "a": 1, // nota\n    "cabecao": 2\n  }\n}\n');
  });

  it('segue a indentação do arquivo (tab) e o fim de linha CRLF', () => {
    const text = '{\r\n\t"mcpServers": {\r\n\t\t"a": 1\r\n\t}\r\n}\r\n';
    const edited = set(text, 'mcpServers', 'cabecao', { x: [1] });
    expect(edited).toBe(
      '{\r\n\t"mcpServers": {\r\n\t\t"a": 1,\r\n\t\t"cabecao": {\r\n\t\t\t"x": [\r\n\t\t\t\t1\r\n\t\t\t]\r\n\t\t}\r\n\t}\r\n}\r\n',
    );
  });

  it('objeto numa linha só continua numa linha só', () => {
    const edited = set('{"mcpServers": {"a": 1}}', 'mcpServers', 'cabecao', ENTRY);
    expect(edited.includes('\n')).toBe(false);
    expect(toValue(parseJsonc(edited))).toEqual({ mcpServers: { a: 1, cabecao: ENTRY } });
  });

  it('troca só o valor de uma entrada existente', () => {
    const text = '{\n  "mcpServers": {\n    "cabecao": {"command": "velho"}, // meu\n    "b": 2\n  }\n}\n';
    const edited = set(text, 'mcpServers', 'cabecao', ENTRY);
    expect(edited).toContain('}, // meu\n    "b": 2\n');
    expect(toValue(parseJsonc(edited))).toEqual({ mcpServers: { cabecao: ENTRY, b: 2 } });
  });

  it('ida e volta: tirar depois de pôr devolve o texto original', () => {
    const originals = [
      '{\n  "a": 1,\n  "mcpServers": {\n    "outro": {}\n  }\n}\n',
      '{\n  "mcpServers": {\n    "outro": {}, // c\n  },\n}\n',
      '{"mcpServers": {"outro": 1}}',
    ];
    for (const original of originals) {
      expect(remove(set(original, 'mcpServers', 'cabecao', ENTRY), 'mcpServers', 'cabecao')).toBe(original);
    }
  });

  it('recusa seção que não é objeto', () => {
    expect(() => set('{"mcpServers": []}', 'mcpServers', 'cabecao', 1)).toThrow('não é um objeto');
  });
});

describe('removeEntry', () => {
  it('tira a entrada do meio, da ponta e a única', () => {
    const middle = '{\n  "s": {\n    "a": 1,\n    "cabecao": 2,\n    "b": 3\n  }\n}\n';
    expect(remove(middle, 's', 'cabecao')).toBe('{\n  "s": {\n    "a": 1,\n    "b": 3\n  }\n}\n');
    const last = '{\n  "s": {\n    "a": 1,\n    "cabecao": {\n      "x": 1\n    }\n  }\n}\n';
    expect(remove(last, 's', 'cabecao')).toBe('{\n  "s": {\n    "a": 1\n  }\n}\n');
    const only = '{\n  "s": {\n    "cabecao": 2\n  }\n}\n';
    expect(toValue(parseJsonc(remove(only, 's', 'cabecao')))).toEqual({ s: {} });
  });

  it('mantém os comentários dos vizinhos', () => {
    const text = '{\n  "s": {\n    // primeiro\n    "a": 1,\n    "cabecao": 2\n  } // fim\n}\n';
    const edited = remove(text, 's', 'cabecao');
    expect(edited).toBe('{\n  "s": {\n    // primeiro\n    "a": 1\n  } // fim\n}\n');
  });

  it('tira todas as repetições da chave', () => {
    const edited = remove('{"s": {"cabecao": 1, "a": 2, "cabecao": 3}}', 's', 'cabecao');
    expect(toValue(parseJsonc(edited))).toEqual({ s: { a: 2 } });
  });

  it('sem a entrada ou sem a seção, devolve o texto igual', () => {
    expect(remove('{"s": {"a": 1}}', 's', 'cabecao')).toBe('{"s": {"a": 1}}');
    expect(remove('{"x": 1}', 's', 'cabecao')).toBe('{"x": 1}');
  });
});

describe('removeEntry numa linha só', () => {
  it('não deixa espaço nem vírgula sobrando', () => {
    expect(remove('{"s": {"a": 1, "cabecao": 2, "b": 3}}', 's', 'cabecao')).toBe('{"s": {"a": 1, "b": 3}}');
    expect(remove('{"s": {"cabecao": 2, "b": 3}}', 's', 'cabecao')).toBe('{"s": {"b": 3}}');
    expect(remove('{"s": {"a": 1, "cabecao": 2}}', 's', 'cabecao')).toBe('{"s": {"a": 1}}');
    expect(remove('{"s": {"cabecao": 2}}', 's', 'cabecao')).toBe('{"s": {}}');
  });
});
