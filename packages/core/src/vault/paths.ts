// Caminhos dentro do cérebro: toda leitura e escrita pedida de fora passa por aqui.
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isSafeRelativePath, normalizeNfc, toPosixPath } from '../util/index.ts';
import type { BrainConfig } from './config.ts';
import { VaultError } from './errors.ts';

/** Caminho relativo em formato canônico: `/` como separador, NFC, sem `./` nem barras repetidas. */
export function normalizeRelPath(relPath: string): string {
  return normalizeNfc(toPosixPath(relPath))
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

async function realpathOfNearestExisting(path: string): Promise<string> {
  for (let current = path; ; current = dirname(current)) {
    try {
      return await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(current) === current) throw error;
    }
  }
}

/**
 * Converte um caminho relativo ao cérebro em caminho absoluto, recusando (`unsafe_path`) o que `isSafeRelativePath`
 * recusa e também o que sai do cérebro por link simbólico (a conferência de texto não enxerga isso).
 */
export async function resolveVaultPath(root: string, relPath: string): Promise<string> {
  if (!isSafeRelativePath(relPath)) {
    throw new VaultError('unsafe_path', `caminho recusado: ${JSON.stringify(relPath)} não fica dentro do cérebro`, {
      path: String(relPath),
    });
  }
  const absolute = join(root, ...toPosixPath(relPath).split('/'));
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    // a raiz ainda não existe: não há link para seguir
    return absolute;
  }
  const inside = relative(realRoot, await realpathOfNearestExisting(absolute));
  if (inside === '..' || inside.startsWith(`..${'/'}`) || inside.startsWith('..\\') || isAbsolute(inside)) {
    throw new VaultError('unsafe_path', `caminho recusado: ${relPath} sai do cérebro por um link simbólico`, {
      path: relPath,
    });
  }
  return absolute;
}

/**
 * Confere um caminho de NOTA para escrita e o devolve em formato canônico. Além da segurança, exige `.md` e recusa
 * pastas e arquivos ocultos (`.cabecao/`, `.obsidian/`...): ali não mora nota.
 */
export function assertNotePath(relPath: string): string {
  if (!isSafeRelativePath(relPath)) {
    throw new VaultError('unsafe_path', `caminho recusado: ${JSON.stringify(relPath)} não fica dentro do cérebro`, {
      path: String(relPath),
    });
  }
  const path = normalizeRelPath(relPath);
  if (!/\.md$/i.test(path) || path.split('/').some((segment) => segment.startsWith('.'))) {
    throw new VaultError(
      'invalid_note_path',
      `caminho de nota inválido: ${path} (precisa terminar em .md e não passar por pasta oculta)`,
      { path },
    );
  }
  return path;
}

/** Verdadeiro se `relPath` (canônico) fica dentro de alguma das `noteDirs`. */
export function isInNoteDirs(relPath: string, config: Pick<BrainConfig, 'noteDirs'>): boolean {
  const key = relPath.toLowerCase();
  return config.noteDirs.some((dir) => dir === '.' || key.startsWith(`${dir.toLowerCase()}/`));
}
