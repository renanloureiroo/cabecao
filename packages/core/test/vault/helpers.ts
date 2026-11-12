// Apoio dos testes do vault: cópias temporárias do cérebro de exemplo. Nada aqui escreve em `fixtures/`.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_VAULT = fileURLToPath(new URL('../../../../fixtures/vault', import.meta.url));

export interface TempVault {
  readonly root: string;
  readonly cleanup: () => Promise<void>;
}

/** Pasta temporária vazia. */
export async function makeTempDir(label: string): Promise<TempVault> {
  const root = await mkdtemp(join(tmpdir(), `cabecao-vault-${label}-`));
  return { root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

/** Cópia do cérebro de exemplo numa pasta temporária. */
export async function copyFixture(label: string): Promise<TempVault> {
  const temp = await makeTempDir(label);
  await cp(FIXTURE_VAULT, temp.root, { recursive: true });
  return temp;
}

/** Caminhos relativos (com `/`) de todos os `.md` do cérebro de exemplo nas pastas de notas. */
export async function fixtureNotePaths(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) out.push(relative(FIXTURE_VAULT, full).split(sep).join('/'));
    }
  };
  for (const dir of ['wiki', 'memory', 'raw']) await walk(join(FIXTURE_VAULT, dir));
  return out.map((path) => path.normalize('NFC')).sort();
}

export async function readText(root: string, relPath: string): Promise<string> {
  return readFile(join(root, ...relPath.split('/')), 'utf8');
}

export async function writeText(root: string, relPath: string, text: string): Promise<void> {
  const path = join(root, ...relPath.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

export async function exists(root: string, relPath: string): Promise<boolean> {
  try {
    await stat(join(root, ...relPath.split('/')));
    return true;
  } catch {
    return false;
  }
}

/**
 * Cria um link simbólico (no Windows, junção para pastas, que não exige privilégio; `target` deve ser absoluto).
 * Devolve `false` se o sistema não deixar (link de arquivo no Windows sem modo de desenvolvedor).
 */
export async function trySymlink(target: string, path: string, type: 'dir' | 'file'): Promise<boolean> {
  try {
    await symlink(target, path, type === 'dir' ? 'junction' : 'file');
    return true;
  } catch {
    return false;
  }
}

/** Troca LF por CRLF, como faria um checkout com `core.autocrlf` no Windows. */
export const toCrlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');
