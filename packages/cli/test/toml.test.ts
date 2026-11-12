import { describe, expect, it } from 'vitest';
import {
  hasTomlTable,
  removeTomlTable,
  setTomlTable,
  TomlError,
  TomlUnsupportedError,
  tomlTable,
  tomlValue,
} from '../src/install-client/toml.ts';

const PATH = ['mcp_servers', 'cabecao'] as const;
const ENTRIES = { command: 'node', args: ['/x/cabecao.mjs', 'mcp', '--brain', 'C:\\Users\\Zé\\cérebro'] };

const RICH = [
  '# configuração do Codex',
  'model = "gpt-5" # o modelo',
  'notify = ["a", "b",',
  '  "c"]',
  'texto = """',
  '[mcp_servers.cabecao]',
  'isto é texto, não tabela',
  '"""',
  "literal = 'C:\\pasta'",
  'data = 1979-05-27T07:32:00Z',
  'hora = 1979-05-27 07:32:00.5-03:00',
  'numeros = [-inf, nan, 0x1F, 1_000, 6.6e-2, true]',
  'inline = { a = 1, b = [1, 2] }',
  '',
  '[mcp_servers.outro]',
  'command = "npx"',
  'args = ["-y", "outro"]',
  '',
  '[mcp_servers.outro.env]',
  'CHAVE = "segredo"',
  '',
  '[[perfis]]',
  'nome = "a"',
  '',
].join('\n');

describe('tomlValue', () => {
  it('escreve texto e listas com escapes válidos em TOML', () => {
    expect(tomlValue('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlValue(['x', 'y'])).toBe('["x", "y"]');
    expect(tomlValue('\u007f')).toBe('"\\u007F"');
  });
});

describe('hasTomlTable', () => {
  it('acha a tabela pelo cabeçalho e ignora o que está dentro de textos', () => {
    expect(hasTomlTable(RICH, PATH)).toBe(false);
    expect(hasTomlTable(RICH, ['mcp_servers', 'outro'])).toBe(true);
    expect(hasTomlTable('[ mcp_servers . "cabecao" ] # com espaços e aspas\nx = 1\n', PATH)).toBe(true);
  });

  it('subtabela sozinha conta como registro existente', () => {
    expect(hasTomlTable('[mcp_servers.cabecao.env]\nA = "1"\n', PATH)).toBe(true);
  });

  it.each([
    ['[mcp_servers.cabecao\n', 'cabeçalho de tabela sem fechamento'],
    ['x = "sem fim\n', 'texto sem aspas de fechamento'],
    ['x = [1, 2\n', 'array sem fechamento'],
    ['x = """\nnunca fecha\n', 'texto de várias linhas sem fechamento'],
    ['x 1\n', 'esperava "="'],
    ['x = 1 y\n', 'esperava o fim da linha'],
  ])('recusa TOML quebrado: %j', (text, problem) => {
    expect(() => hasTomlTable(text, PATH)).toThrow(TomlError);
    expect(() => hasTomlTable(text, PATH)).toThrow(problem);
  });

  it.each([
    ['mcp_servers = { cabecao = { command = "x" } }\n'],
    ['mcp_servers.cabecao.command = "x"\n'],
    ['[mcp_servers]\ncabecao = { command = "x" }\n'],
    ['[mcp_servers]\ncabecao.command = "x"\n'],
    ['[[mcp_servers.cabecao]]\ncommand = "x"\n'],
    ['[mcp_servers.cabecao]\ncommand = "x"\n[mcp_servers.cabecao]\nargs = []\n'],
  ])('recusa formas que não edita com segurança: %j', (text) => {
    expect(() => hasTomlTable(text, PATH)).toThrow(TomlUnsupportedError);
  });
});

describe('setTomlTable', () => {
  it('arquivo vazio vira só a tabela nova', () => {
    expect(setTomlTable('', PATH, ENTRIES)).toBe(tomlTable(PATH, ENTRIES));
    expect(tomlTable(PATH, { command: 'npx', args: ['-y'] })).toBe(
      '[mcp_servers.cabecao]\ncommand = "npx"\nargs = ["-y"]\n',
    );
  });

  it('acrescenta no fim sem mexer em nenhum byte do resto', () => {
    const edited = setTomlTable(RICH, PATH, ENTRIES);
    expect(edited.startsWith(RICH)).toBe(true);
    expect(edited.slice(RICH.length)).toBe(`\n${tomlTable(PATH, ENTRIES)}`);
    expect(hasTomlTable(edited, PATH)).toBe(true);
  });

  it('arquivo sem quebra de linha no fim ganha a separação', () => {
    expect(setTomlTable('a = 1', PATH, { command: 'x' })).toBe('a = 1\n\n[mcp_servers.cabecao]\ncommand = "x"\n');
  });

  it('é idempotente', () => {
    const once = setTomlTable(RICH, PATH, ENTRIES);
    expect(setTomlTable(once, PATH, ENTRIES)).toBe(once);
  });

  it('numa tabela existente troca só command e args e preserva o resto', () => {
    const text = [
      '[mcp_servers.cabecao]',
      'command = "npx" # antigo',
      'startup_timeout_sec = 20',
      'args = [',
      '  "-y",',
      '  "cabecao",',
      ']',
      '',
      '[mcp_servers.cabecao.env]',
      'X = "1"',
      '',
    ].join('\n');
    const edited = setTomlTable(text, PATH, { command: 'node', args: ['b.mjs'] });
    expect(edited).toBe(
      [
        '[mcp_servers.cabecao]',
        'command = "node" # antigo',
        'startup_timeout_sec = 20',
        'args = ["b.mjs"]',
        '',
        '[mcp_servers.cabecao.env]',
        'X = "1"',
        '',
      ].join('\n'),
    );
  });

  it('chave que falta entra logo depois do cabeçalho, inclusive sem quebra de linha final', () => {
    expect(setTomlTable('[mcp_servers.cabecao]\nx = 1\n', PATH, { command: 'n' })).toBe(
      '[mcp_servers.cabecao]\ncommand = "n"\nx = 1\n',
    );
    expect(setTomlTable('[mcp_servers.cabecao]', PATH, { command: 'n' })).toBe(
      '[mcp_servers.cabecao]\ncommand = "n"\n',
    );
  });

  it('mantém CRLF', () => {
    const edited = setTomlTable('a = 1\r\n', PATH, { command: 'x' });
    expect(edited).toBe('a = 1\r\n\r\n[mcp_servers.cabecao]\r\ncommand = "x"\r\n');
  });
});

describe('removeTomlTable', () => {
  it('ida e volta: tirar depois de pôr devolve o texto original', () => {
    for (const original of [RICH, 'a = 1\n', '[x]\ny = 2\n\n[z]\nw = 3\n', '']) {
      expect(removeTomlTable(setTomlTable(original, PATH, ENTRIES), PATH)).toBe(original);
    }
  });

  it('tira a tabela e as subtabelas, deixando as vizinhas e os comentários delas', () => {
    const text = [
      'a = 1',
      '',
      '[mcp_servers.cabecao]',
      'command = "x"',
      '',
      '[mcp_servers.cabecao.env]',
      'X = "1"',
      '',
      '# comentário da próxima',
      '[mcp_servers.outro]',
      'command = "y"',
      '',
    ].join('\n');
    expect(removeTomlTable(text, PATH)).toBe(
      ['a = 1', '', '# comentário da próxima', '[mcp_servers.outro]', 'command = "y"', ''].join('\n'),
    );
  });

  it('sem a tabela, devolve o texto igual', () => {
    expect(removeTomlTable(RICH, PATH)).toBe(RICH);
  });
});
