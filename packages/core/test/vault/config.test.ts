import { afterEach, describe, expect, it } from 'vitest';
import {
  BRAIN_CONFIG_FILE,
  defaultBrainConfig,
  readBrainConfig,
  SUPPORTED_SCHEMA_VERSION,
  VaultError,
  validateBrainConfig,
  writeBrainConfig,
} from '../../src/vault/index.ts';
import type { TempVault } from './helpers.ts';
import { copyFixture, makeTempDir, readText, writeText } from './helpers.ts';

let temp: TempVault | undefined;
afterEach(async () => {
  await temp?.cleanup();
  temp = undefined;
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultError) return error.code;
    throw error;
  }
  throw new Error('deveria ter lançado');
}

describe('readBrainConfig', () => {
  it('lê o .cabecao.json do cérebro de exemplo', async () => {
    temp = await copyFixture('config');
    const config = await readBrainConfig(temp.root);
    expect(config).toEqual({
      schemaVersion: 1,
      noteDirs: ['wiki', 'memory', 'raw'],
      indexMd: 'index.md',
      relations: [],
      unknown: {},
    });
  });

  it('dá erro claro quando a pasta não é um cérebro', async () => {
    temp = await makeTempDir('config');
    await expect(readBrainConfig(temp.root)).rejects.toThrow(/não é um cérebro/);
    expect(await codeOf(readBrainConfig(temp.root))).toBe('config_not_found');
  });

  it('dá erro claro para JSON inválido', async () => {
    temp = await makeTempDir('config');
    await writeText(temp.root, BRAIN_CONFIG_FILE, '{ "schemaVersion": 1, ');
    expect(await codeOf(readBrainConfig(temp.root))).toBe('config_invalid_json');
    await expect(readBrainConfig(temp.root)).rejects.toThrow(/não é JSON válido/);
  });

  it('recusa schemaVersion mais novo que o suportado, pedindo para atualizar', async () => {
    temp = await makeTempDir('config');
    const newer = SUPPORTED_SCHEMA_VERSION + 1;
    // mesmo com o resto num formato que esta versão não entende, o erro é o da versão
    await writeText(temp.root, BRAIN_CONFIG_FILE, JSON.stringify({ schemaVersion: newer, noteDirs: { x: 1 } }));
    expect(await codeOf(readBrainConfig(temp.root))).toBe('config_schema_too_new');
    await expect(readBrainConfig(temp.root)).rejects.toThrow(/Atualize o Cabeção/);
  });

  it('aceita BOM e CRLF (arquivo editado no Windows)', async () => {
    temp = await makeTempDir('config');
    await writeText(
      temp.root,
      BRAIN_CONFIG_FILE,
      '\uFEFF{\r\n  "schemaVersion": 1,\r\n  "noteDirs": ["wiki"],\r\n  "indexMd": "index.md"\r\n}\r\n',
    );
    expect((await readBrainConfig(temp.root)).noteDirs).toEqual(['wiki']);
  });
});

describe('validateBrainConfig', () => {
  const base = { schemaVersion: 1, noteDirs: ['wiki'], indexMd: 'index.md' };

  it('junta todos os problemas numa mensagem só', () => {
    try {
      validateBrainConfig({ schemaVersion: 0, noteDirs: [], indexMd: 'index.txt', relations: ['Mentor'] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      const message = (error as VaultError).message;
      expect((error as VaultError).code).toBe('config_invalid');
      expect(message).toMatch(/schemaVersion/);
      expect(message).toMatch(/noteDirs/);
      expect(message).toMatch(/indexMd/);
      expect(message).toMatch(/relations/);
    }
  });

  it('recusa raiz que não é objeto', () => {
    expect(() => validateBrainConfig([1, 2])).toThrow(/objeto JSON/);
  });

  it('normaliza noteDirs e recusa as perigosas ou ocultas', () => {
    expect(validateBrainConfig({ ...base, noteDirs: ['./wiki/', 'memory\\facts', 'wiki', '.'] }).noteDirs).toEqual([
      'wiki',
      'memory/facts',
      '.',
    ]);
    for (const bad of ['../fora', '/abs', 'C:\\x', '.git', '.cabecao', 'a/.obsidian', 42]) {
      expect(() => validateBrainConfig({ ...base, noteDirs: [bad] }), String(bad)).toThrow(/noteDirs/);
    }
  });

  it('confere embedding e commit, mantendo as chaves que não conhece dentro deles', () => {
    const embedding = { model: 'embeddinggemma-300m', variant: 'q4', dims: 768, recipe: 1, extra: true };
    const commit = { message: 'vault backup: {{date}}', dateFormat: 'YYYY-MM-DD HH:mm:ss.SSS' };
    const config = validateBrainConfig({ ...base, embedding, commit });
    expect(config.embedding).toEqual(embedding);
    expect(config.commit).toEqual(commit);
    expect(() =>
      validateBrainConfig({ ...base, embedding: { model: 'x', variant: 'q4', dims: 0, recipe: 1 } }),
    ).toThrow(/embedding/);
    expect(() => validateBrainConfig({ ...base, commit: { message: '' } })).toThrow(/commit/);
    expect(validateBrainConfig({ ...base, commit: { message: 'x' } }).commit).toEqual({ message: 'x' });
  });

  it('aceita relações extras válidas e recusa nomes de campos do esquema', () => {
    expect(validateBrainConfig({ ...base, relations: ['mentored_by', 'uses', 'mentored_by'] }).relations).toEqual([
      'mentored_by',
      'uses',
    ]);
    expect(() => validateBrainConfig({ ...base, relations: ['title'] })).toThrow(/campo do frontmatter/);
    expect(() => validateBrainConfig({ ...base, relations: ['com espaço'] })).toThrow(/nome inválido/);
    expect(() => validateBrainConfig({ ...base, relations: 'uses' })).toThrow(/lista/);
  });
});

describe('writeBrainConfig', () => {
  it('preserva as chaves desconhecidas e grava JSON estável terminado em LF', async () => {
    temp = await makeTempDir('config');
    const original = {
      futureKey: { a: 1 },
      schemaVersion: 1,
      noteDirs: ['wiki', 'memory'],
      indexMd: 'index.md',
      commit: { message: 'vault backup: {{date}}', dateFormat: 'YYYY-MM-DD', color: 'blue' },
      relations: ['mentored_by'],
      zz: [1, 2],
    };
    await writeText(temp.root, BRAIN_CONFIG_FILE, JSON.stringify(original));
    const config = await readBrainConfig(temp.root);
    expect(config.unknown).toEqual({ futureKey: { a: 1 }, zz: [1, 2] });

    await writeBrainConfig(temp.root, { ...config, noteDirs: [...config.noteDirs, 'raw'] });
    const text = await readText(temp.root, BRAIN_CONFIG_FILE);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(JSON.parse(text)).toEqual({ ...original, noteDirs: ['wiki', 'memory', 'raw'] });
    // conhecidas primeiro, na ordem do doc 03; depois as desconhecidas
    expect(Object.keys(JSON.parse(text))).toEqual([
      'schemaVersion',
      'noteDirs',
      'indexMd',
      'commit',
      'relations',
      'futureKey',
      'zz',
    ]);

    // regravar o que foi lido não muda nenhum byte
    await writeBrainConfig(temp.root, await readBrainConfig(temp.root));
    expect(await readText(temp.root, BRAIN_CONFIG_FILE)).toBe(text);
  });

  it('não grava uma configuração inválida', async () => {
    temp = await makeTempDir('config');
    await expect(writeBrainConfig(temp.root, { ...defaultBrainConfig(), noteDirs: [] })).rejects.toThrow(/noteDirs/);
    await expect(readText(temp.root, BRAIN_CONFIG_FILE)).rejects.toThrow();
  });

  it('uma chave "desconhecida" com nome conhecido não sobrescreve a de verdade', async () => {
    temp = await makeTempDir('config');
    await writeBrainConfig(temp.root, { ...defaultBrainConfig(), unknown: { schemaVersion: 99, other: 1 } });
    const written = JSON.parse(await readText(temp.root, BRAIN_CONFIG_FILE));
    expect(written.schemaVersion).toBe(1);
    expect(written.other).toBe(1);
  });
});
