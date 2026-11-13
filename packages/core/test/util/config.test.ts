import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  configFilePath,
  defaultMachineName,
  isValidMachineName,
  readMachineConfig,
  sanitizeMachineName,
  writeMachineConfig,
} from '../../src/util/index.ts';
import { makeTempDir } from './helpers.ts';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const temp = await makeTempDir('config');
  cleanup = temp.cleanup;
  // Pasta que ainda não existe: gravar tem de criá-la.
  dir = join(temp.dir, 'config', 'cabecao');
});
afterEach(async () => {
  await cleanup();
});

async function writeRaw(text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(configFilePath(dir), text);
}

describe('configuração da máquina', () => {
  it('devolve null quando ainda não há configuração', async () => {
    expect(await readMachineConfig(dir)).toBeNull();
  });

  it('grava e lê de volta', async () => {
    await writeMachineConfig({ machine: 'mac-do-renan', defaultBrain: '/Users/renan/cabecao' }, dir);
    expect(await readMachineConfig(dir)).toEqual({ machine: 'mac-do-renan', defaultBrain: '/Users/renan/cabecao' });
    expect(await readdir(dir)).toEqual(['config.json']);
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({
      machine: 'mac-do-renan',
      defaultBrain: '/Users/renan/cabecao',
    });

    await writeMachineConfig({ machine: 'outro' }, dir);
    expect(await readMachineConfig(dir)).toEqual({ machine: 'outro' });
  });

  it('usa CABECAO_CONFIG_DIR quando a pasta não é informada', async () => {
    const saved = process.env.CABECAO_CONFIG_DIR;
    process.env.CABECAO_CONFIG_DIR = dir;
    try {
      await writeMachineConfig({ machine: 'pela-variavel' });
      expect(await readMachineConfig()).toEqual({ machine: 'pela-variavel' });
      expect(await readdir(dir)).toEqual(['config.json']);
    } finally {
      if (saved === undefined) delete process.env.CABECAO_CONFIG_DIR;
      else process.env.CABECAO_CONFIG_DIR = saved;
    }
  });

  it('aceita BOM e ignora chaves desconhecidas', async () => {
    await writeRaw('\uFEFF{"machine":"pc","futuro":true}');
    expect(await readMachineConfig(dir)).toEqual({ machine: 'pc' });
  });

  it('arquivo corrompido vira ConfigError com o caminho e o motivo', async () => {
    const cases: [string, RegExp][] = [
      ['{"machine": "cortado', /não é JSON válido/],
      ['', /não é JSON válido/],
      ['[]', /objeto JSON/],
      ['"texto"', /objeto JSON/],
      ['null', /objeto JSON/],
      ['{}', /"machine"/],
      ['{"machine": 42}', /"machine"/],
      ['{"machine": ""}', /"machine"/],
      ['{"machine": "Meu Mac"}', /"machine"/],
      ['{"machine": "pc", "defaultBrain": 7}', /"defaultBrain"/],
      ['{"machine": "pc", "defaultBrain": ""}', /"defaultBrain"/],
    ];
    for (const [text, problem] of cases) {
      await writeRaw(text);
      const error = await readMachineConfig(dir).catch((e: unknown) => e);
      expect(error, text).toBeInstanceOf(ConfigError);
      expect(error, text).toMatchObject({ code: 'ECONFIG', path: configFilePath(dir) });
      expect((error as ConfigError).message, text).toMatch(problem);
      expect((error as ConfigError).message, text).toContain(configFilePath(dir));
    }
  });

  it('recusa gravar configuração inválida e não cria arquivo', async () => {
    await expect(writeMachineConfig({ machine: 'Nome Inválido' }, dir)).rejects.toThrow(ConfigError);
    await expect(writeMachineConfig({ machine: 'pc', defaultBrain: '' }, dir)).rejects.toThrow(ConfigError);
    expect(await readMachineConfig(dir)).toBeNull();
  });
});

describe('nome da máquina', () => {
  it('padrão: hostname sem domínio, saneado', () => {
    expect(defaultMachineName('MacBook-Pro-do-Renan.local')).toBe('macbook-pro-do-renan');
    expect(defaultMachineName('servidor.empresa.com.br')).toBe('servidor');
    expect(defaultMachineName('DESKTOP-A1B2C3')).toBe('desktop-a1b2c3');
    expect(defaultMachineName('')).toBe('maquina');
    expect(isValidMachineName(defaultMachineName())).toBe(true);
  });

  it('saneia acentos, espaços, símbolos e tamanho', () => {
    expect(sanitizeMachineName('Máquina do João')).toBe('maquina-do-joao');
    expect(sanitizeMachineName('  __PC/da\\Ana:01__  ')).toBe('pc-da-ana-01');
    expect(sanitizeMachineName('日本語')).toBe('maquina');
    expect(sanitizeMachineName('---')).toBe('maquina');
    const long = sanitizeMachineName(`${'a'.repeat(31)}-${'b'.repeat(40)}`);
    expect(long).toBe('a'.repeat(31));
    for (const name of ['Máquina do João', 'x', 'a'.repeat(100), 'a.b.c', '..', 'CON']) {
      expect(isValidMachineName(sanitizeMachineName(name)), name).toBe(true);
    }
  });

  it('isValidMachineName', () => {
    for (const ok of ['a', 'pc', 'mac-do-renan', '0', 'a'.repeat(32)]) expect(isValidMachineName(ok), ok).toBe(true);
    for (const bad of ['', '-a', 'a-', 'A', 'a b', 'a/b', 'a.b', 'ç', 'a'.repeat(33), 7, null, undefined]) {
      expect(isValidMachineName(bad), String(bad)).toBe(false);
    }
  });
});
