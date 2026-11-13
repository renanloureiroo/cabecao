import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.ts';
import { configDir } from './dirs.ts';
import { isErrno } from './errors.ts';

/** Configuração desta máquina (não é versionada nem sincronizada). */
export interface MachineConfig {
  /** Nome da máquina, definido no `init`. Entra em nomes de arquivo de conflito e em commits. */
  machine: string;
  /** Caminho absoluto do cérebro usado quando nenhum é informado. */
  defaultBrain?: string;
}

/** O `config.json` existe mas não dá para usar (JSON quebrado, campo faltando ou inválido). */
export class ConfigError extends Error {
  readonly code = 'ECONFIG';
  readonly path: string;

  constructor(path: string, problem: string, cause?: unknown) {
    super(
      `configuração inválida em ${path}: ${problem}. Corrija o arquivo ou apague-o e rode "cabecao init".`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ConfigError';
    this.path = path;
  }
}

export const CONFIG_FILE_NAME = 'config.json';
const MACHINE_NAME_MAX = 32;
const MACHINE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MACHINE_NAME_FALLBACK = 'maquina';

export function configFilePath(dir: string = configDir()): string {
  return join(dir, CONFIG_FILE_NAME);
}

/** Nome de máquina aceito: minúsculas ASCII, dígitos e hífen, de 1 a 32 caracteres, sem hífen nas pontas. */
export function isValidMachineName(name: unknown): name is string {
  return typeof name === 'string' && MACHINE_NAME_PATTERN.test(name);
}

/**
 * Reduz um texto qualquer a um nome de máquina válido: tira acentos, passa para minúsculas, troca o resto por
 * hífen. O nome vai parar em nomes de arquivo (`nota.conflict-<máquina>-<data>.md`), por isso o alfabeto estreito
 * e as minúsculas (macOS e Windows não distinguem caixa).
 */
export function sanitizeMachineName(name: string): string {
  const clean = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MACHINE_NAME_MAX)
    .replace(/^-+|-+$/g, '');
  return clean === '' ? MACHINE_NAME_FALLBACK : clean;
}

/** Nome padrão: o hostname sem o domínio (`mac-do-renan.local` vira `mac-do-renan`), saneado. */
export function defaultMachineName(host: string = hostname()): string {
  return sanitizeMachineName(host.split('.')[0] ?? '');
}

function validate(path: string, value: unknown): MachineConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, 'o conteúdo deveria ser um objeto JSON');
  }
  const { machine, defaultBrain } = value as Record<string, unknown>;
  if (!isValidMachineName(machine)) {
    throw new ConfigError(
      path,
      `"machine" deveria ser um nome com letras minúsculas, dígitos e hífen (até ${MACHINE_NAME_MAX} caracteres)`,
    );
  }
  if (defaultBrain === undefined) return { machine };
  if (typeof defaultBrain !== 'string' || defaultBrain === '') {
    throw new ConfigError(path, '"defaultBrain" deveria ser o caminho de uma pasta');
  }
  return { machine, defaultBrain };
}

/**
 * Lê `<dir>/config.json`. Devolve `null` se o arquivo não existe (máquina ainda sem `init`) e lança `ConfigError`
 * se existe mas está corrompido. Chaves desconhecidas são ignoradas.
 */
export async function readMachineConfig(dir: string = configDir()): Promise<MachineConfig | null> {
  const path = configFilePath(dir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  let value: unknown;
  try {
    // Editores no Windows costumam gravar com BOM, que o JSON.parse não aceita.
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(path, 'o conteúdo não é JSON válido', error);
  }
  return validate(path, value);
}

/** Valida e grava `<dir>/config.json` de forma atômica, criando a pasta se faltar. */
export async function writeMachineConfig(config: MachineConfig, dir: string = configDir()): Promise<void> {
  const path = configFilePath(dir);
  const valid = validate(path, config);
  await writeFileAtomic(path, `${JSON.stringify(valid, null, 2)}\n`);
}
