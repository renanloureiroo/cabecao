// Instalação das skills do Cabeção nas pastas dos clientes (`install-skills`), a remoção (`install-skills --remove` e
// `uninstall`) e a leitura do estado (`doctor`). Cada arquivo gravado fica num REGISTRO na pasta de configuração da
// máquina (`skills.json`), com o hash do que foi gravado: assim o Cabeção sabe o que é dele, nunca sobrescreve uma
// skill que o usuário alterou (o arquivo não bate mais com o hash) e o `--remove` tira só o que ele pôs.
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@cabecao/core';
import { CliError } from '../errors.ts';
import { SKILLS } from './content.ts';
import type { SkillClientId, SkillScope } from './targets.ts';

export const REGISTRY_FILE = 'skills.json';
const REGISTRY_VERSION = 1;

/** Uma pasta de skills em que o Cabeção instalou: quem a usa e o hash de cada arquivo gravado. */
export interface RegistryInstall {
  dir: string;
  scope: SkillScope;
  clients: SkillClientId[];
  /** Versão do Cabeção que gravou por último. */
  version: string;
  /** `<skill>/<arquivo>` → sha256 do conteúdo gravado. */
  files: Record<string, string>;
}

export interface Registry {
  version: number;
  installs: RegistryInstall[];
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
}

export async function readRegistry(configDir: string): Promise<Registry> {
  const path = join(configDir, REGISTRY_FILE);
  const text = await readText(path);
  if (text === undefined) return { version: REGISTRY_VERSION, installs: [] };
  try {
    const value = JSON.parse(text) as Registry;
    if (!Array.isArray(value.installs)) throw new Error('sem a lista "installs"');
    return value;
  } catch (error) {
    throw new CliError(
      `o registro das skills (${path}) está ilegível: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'ESKILLSREGISTRY',
        hint: 'Apague o arquivo e rode "cabecao install-skills" de novo: as skills que você alterou não são tocadas.',
      },
    );
  }
}

export async function writeRegistry(configDir: string, registry: Registry): Promise<void> {
  const installs = registry.installs.filter((install) => Object.keys(install.files).length > 0);
  await writeFileAtomic(
    join(configDir, REGISTRY_FILE),
    `${JSON.stringify({ version: REGISTRY_VERSION, installs }, null, 2)}\n`,
  );
}

/** Os arquivos que o Cabeção grava numa pasta de skills: `<skill>/<arquivo>` → conteúdo. */
export function desiredFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const skill of SKILLS) for (const file of skill.files) files.set(`${skill.name}/${file.path}`, file.content);
  return files;
}

/** O que aconteceu com um arquivo. */
export type FileOutcome =
  /** gravado agora (não existia) */
  | 'installed'
  /** era do Cabeção, de uma versão anterior, e foi trocado */
  | 'updated'
  /** já estava igual */
  | 'unchanged'
  /** existe e não é o que o Cabeção gravou (você alterou, ou é uma skill sua com o mesmo nome): não foi tocado */
  | 'kept'
  /** removido (`--remove`, ou uma skill que saiu do Cabeção) */
  | 'removed'
  /** não existia */
  | 'absent';

export interface FileResult {
  path: string;
  outcome: FileOutcome;
}

export interface DirResult {
  dir: string;
  scope: SkillScope;
  clients: SkillClientId[];
  files: FileResult[];
  /** Na remoção: a pasta continua com as skills porque outros clientes ainda a usam. */
  sharedWith?: SkillClientId[];
}

function findInstall(registry: Registry, dir: string): RegistryInstall | undefined {
  return registry.installs.find((install) => install.dir === dir);
}

/**
 * Plano de uma instalação, sem gravar nada (é o `--print`). `outcome` de cada arquivo é o que a instalação faria.
 */
export async function planInstall(registry: Registry, dir: string): Promise<FileResult[]> {
  const recorded = findInstall(registry, dir)?.files ?? {};
  const results: FileResult[] = [];
  for (const [rel, content] of desiredFiles()) {
    const path = join(dir, ...rel.split('/'));
    const current = await readText(path);
    if (current === undefined) results.push({ path, outcome: 'installed' });
    else if (current === content) results.push({ path, outcome: 'unchanged' });
    else if (recorded[rel] !== undefined && sha256(current) === recorded[rel])
      results.push({ path, outcome: 'updated' });
    else results.push({ path, outcome: 'kept' });
  }
  // skills que o Cabeção gravou antes e não existem mais nesta versão
  const desired = desiredFiles();
  for (const [rel, hash] of Object.entries(recorded)) {
    if (desired.has(rel)) continue;
    const path = join(dir, ...rel.split('/'));
    const current = await readText(path);
    if (current === undefined) continue;
    results.push({ path, outcome: sha256(current) === hash ? 'removed' : 'kept' });
  }
  return results;
}

/** Tira a pasta da skill se ela ficou vazia (nunca a de um arquivo que ficou). */
async function removeEmptyDirs(dir: string, rels: readonly string[]): Promise<void> {
  const skills = new Set(rels.map((rel) => rel.split('/')[0] ?? ''));
  for (const skill of skills) {
    if (skill === '') continue;
    try {
      if ((await readdir(join(dir, skill))).length === 0) await rmdir(join(dir, skill));
    } catch {
      // já não existe, ou outro processo pôs algo lá
    }
  }
}

/** Instala (ou atualiza) as skills em `dir` e anota no registro. Idempotente. */
export async function installInto(
  registry: Registry,
  target: { dir: string; scope: SkillScope; clients: readonly SkillClientId[] },
  version: string,
): Promise<DirResult> {
  const plan = await planInstall(registry, target.dir);
  const desired = desiredFiles();
  const previous = findInstall(registry, target.dir);
  const files: Record<string, string> = { ...(previous?.files ?? {}) };
  const relOf = (path: string): string =>
    path
      .slice(target.dir.length + 1)
      .split(/[\\/]/)
      .join('/');
  for (const result of plan) {
    const rel = relOf(result.path);
    const content = desired.get(rel);
    if (result.outcome === 'installed' || result.outcome === 'updated') {
      if (content === undefined) continue;
      await writeFileAtomic(result.path, content);
      files[rel] = sha256(content);
    } else if (result.outcome === 'unchanged' && content !== undefined) {
      files[rel] = sha256(content);
    } else if (result.outcome === 'removed') {
      await rm(result.path, { force: true });
      delete files[rel];
    } else if (result.outcome === 'kept' && content === undefined) {
      // a skill saiu do Cabeção, mas o arquivo foi alterado: passa a ser do usuário
      delete files[rel];
    }
  }
  await removeEmptyDirs(
    target.dir,
    plan.filter((result) => result.outcome === 'removed').map((result) => relOf(result.path)),
  );
  const clients = [...new Set([...(previous?.clients ?? []), ...target.clients])].sort();
  const entry: RegistryInstall = { dir: target.dir, scope: target.scope, clients, version, files };
  registry.installs = [...registry.installs.filter((install) => install.dir !== target.dir), entry];
  return { dir: target.dir, scope: target.scope, clients, files: plan };
}

/**
 * Tira de `dir` os clientes `clients` (todos, sem a lista). Os arquivos só saem quando nenhum cliente registrado usa
 * mais a pasta, e só os que continuam iguais ao que o Cabeção gravou: o que você alterou fica.
 */
export async function removeFrom(
  registry: Registry,
  dir: string,
  clients: readonly SkillClientId[] | undefined,
): Promise<DirResult | null> {
  const install = findInstall(registry, dir);
  if (install === undefined) return null;
  const remaining = clients === undefined ? [] : install.clients.filter((client) => !clients.includes(client));
  const removedClients = clients === undefined ? install.clients : install.clients.filter((c) => clients.includes(c));
  if (remaining.length > 0) {
    install.clients = remaining;
    return { dir, scope: install.scope, clients: removedClients, files: [], sharedWith: remaining };
  }
  const files: FileResult[] = [];
  for (const [rel, hash] of Object.entries(install.files)) {
    const path = join(dir, ...rel.split('/'));
    const current = await readText(path);
    if (current === undefined) files.push({ path, outcome: 'absent' });
    else if (sha256(current) === hash) {
      await rm(path, { force: true });
      files.push({ path, outcome: 'removed' });
    } else files.push({ path, outcome: 'kept' });
  }
  await removeEmptyDirs(dir, Object.keys(install.files));
  registry.installs = registry.installs.filter((entry) => entry.dir !== dir);
  return { dir, scope: install.scope, clients: removedClients, files };
}

/** Estado de uma pasta registrada, para o `doctor` e para o `status`. */
export interface InstallState {
  dir: string;
  clients: SkillClientId[];
  /** Arquivos iguais aos desta versão. */
  current: number;
  /** Do Cabeção, mas de uma versão anterior (o `install-skills` atualiza). */
  outdated: number;
  /** Alterados por você (o Cabeção não mexe). */
  modified: number;
  /** Gravados antes e apagados depois. */
  missing: number;
}

export async function installStates(registry: Registry): Promise<InstallState[]> {
  const desired = desiredFiles();
  const states: InstallState[] = [];
  for (const install of registry.installs) {
    const state: InstallState = {
      dir: install.dir,
      clients: install.clients,
      current: 0,
      outdated: 0,
      modified: 0,
      missing: 0,
    };
    for (const rel of new Set([...desired.keys(), ...Object.keys(install.files)])) {
      const current = await readText(join(install.dir, ...rel.split('/')));
      const want = desired.get(rel);
      const recorded = install.files[rel];
      if (current === undefined) {
        if (recorded !== undefined || want !== undefined) state.missing += 1;
      } else if (want !== undefined && current === want) state.current += 1;
      else if (recorded !== undefined && sha256(current) === recorded) state.outdated += 1;
      else state.modified += 1;
    }
    states.push(state);
  }
  return states;
}
