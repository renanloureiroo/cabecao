// Caminhos dentro do cérebro: toda leitura e escrita pedida de fora passa por aqui.
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isSafeRelativePath, normalizeNfc, toPosixPath } from '../util/index.ts';
import type { BrainConfig } from './config.ts';
import { LOG_MD } from './config.ts';
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

/** Pastas do cérebro que nenhuma leitura ou escrita de nota alcança, nem por link simbólico: git e banco local. */
const PRIVATE_DIRS: readonly string[] = ['.git', '.cabecao'];

export interface ResolveVaultPathOptions {
  /**
   * O caminho vai ser GRAVADO. Além do que vale para a leitura, recusa (`unsafe_path`) quando o próprio arquivo ou
   * qualquer pasta no meio do caminho é um link simbólico (ou junção, no Windows): a escrita atômica seguiria o
   * link, e um link versionado (que chega pelo sync) poderia levar a gravação para qualquer lugar do cérebro.
   */
  readonly write?: boolean;
}

/** Primeiro segmento de um caminho relativo (com `/` ou `\\`), em minúsculas. */
const firstSegment = (rel: string): string => (rel.split(/[\\/]/)[0] ?? '').toLowerCase();

/** Link simbólico no caminho, do primeiro segmento abaixo da raiz até o arquivo; `null` se não há nenhum. */
async function symlinkOnPath(root: string, relPath: string): Promise<string | null> {
  let current = root;
  const segments = toPosixPath(relPath)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i] ?? '');
    try {
      if ((await lstat(current)).isSymbolicLink()) return segments.slice(0, i + 1).join('/');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null; // daqui para a frente nada existe ainda
      throw error;
    }
  }
  return null;
}

/**
 * Converte um caminho relativo ao cérebro em caminho absoluto, recusando (`unsafe_path`) o que `isSafeRelativePath`
 * recusa, o que sai do cérebro por link simbólico (a conferência de texto não enxerga isso) e o que, depois de
 * seguir os links, cai dentro de `.git/` ou `.cabecao/` (gravar em `.git/config` é executar código). Com
 * `write: true`, recusa também qualquer link simbólico no caminho (ver `ResolveVaultPathOptions`).
 */
export async function resolveVaultPath(
  root: string,
  relPath: string,
  options: ResolveVaultPathOptions = {},
): Promise<string> {
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
  if (PRIVATE_DIRS.includes(firstSegment(inside))) {
    throw new VaultError(
      'unsafe_path',
      `caminho recusado: ${relPath} leva, por um link simbólico, a ${firstSegment(inside)}/, que não é do conteúdo do cérebro`,
      { path: relPath },
    );
  }
  if (options.write === true) {
    const link = await symlinkOnPath(root, relPath);
    if (link !== null) {
      throw new VaultError(
        'unsafe_path',
        `caminho recusado: ${link} é um link simbólico, e o Cabeção não grava através de links (${relPath})`,
        { path: relPath },
      );
    }
  }
  return absolute;
}

/** O alvo real de `relPath` (seguindo links) fica dentro de `.git/` ou `.cabecao/`. Para a listagem de notas. */
export function isPrivateTarget(realRoot: string, realTarget: string): boolean {
  return PRIVATE_DIRS.includes(firstSegment(relative(realRoot, realTarget)));
}

/**
 * Arquivos da raiz que são do cérebro (ou do repositório) e não notas: as instruções dos agentes (`AGENTS.md`,
 * `CLAUDE.md`), o catálogo e o diário (`index.md`, `log.md`) e os arquivos comuns de um repositório (`README.md`,
 * `LICENSE.md`...). Num vault adotado com `noteDirs: ["."]` eles ficam dentro das pastas de notas, mas um agente
 * nunca grava neles. Os que não são `.md` (`.cabecao.json`, `.gitignore`, `.gitattributes`) já são recusados como
 * caminho de nota.
 */
export const ROOT_CONTROL_FILE_RE =
  /^(?:readme|license|licence|copying|changelog|contributing|agents|claude|index|log)\.md$/i;

/**
 * Verdadeiro se `relPath` (canônico) é um arquivo de controle do cérebro: um dos de `ROOT_CONTROL_FILE_RE` na raiz,
 * `log.md` ou o catálogo (`config.indexMd`, onde quer que ele esteja). Sem diferenciar maiúsculas.
 */
export function isBrainControlFile(relPath: string, config?: Partial<Pick<BrainConfig, 'indexMd'>>): boolean {
  const path = normalizeNfc(toPosixPath(relPath)).replace(/^(?:\.\/)+/, '');
  const key = path.toLowerCase();
  if (key === LOG_MD) return true;
  if (config?.indexMd !== undefined && key === normalizeNfc(config.indexMd).toLowerCase()) return true;
  return !path.includes('/') && ROOT_CONTROL_FILE_RE.test(path);
}

export interface DiskCasePath {
  /** O caminho com a grafia de cada segmento que já existe no disco; os que ainda não existem ficam como vieram. */
  readonly path: string;
  /** Quantos segmentos, do começo, já existem no disco. */
  readonly existing: number;
}

const nameKey = (name: string): string => normalizeNfc(name).toLowerCase();

/**
 * Caminho com a grafia que está no disco. macOS e Windows não diferenciam maiúsculas: `wiki/entities/sqs.md` abre
 * `SQS.md`, mas o git só conhece `SQS.md`, e gravar e commitar com a grafia pedida falha (ou cria uma segunda
 * entrada). Para cada segmento: o nome exato, se existe; senão, o único que casa sem diferenciar maiúsculas nem a
 * forma Unicode (NFC/NFD). Nada é criado nem seguido; só `readdir`.
 */
export async function diskCasePath(root: string, relPath: string): Promise<DiskCasePath> {
  const segments = normalizeRelPath(relPath).split('/');
  const out: string[] = [];
  let dir = root;
  let existing = 0;
  for (const [i, segment] of segments.entries()) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        out.push(...segments.slice(i));
        break;
      }
      throw error;
    }
    let found: string | undefined = names.includes(segment) ? segment : undefined;
    if (found === undefined) {
      const matches = names.filter((name) => nameKey(name) === nameKey(segment));
      if (matches.length === 1) found = matches[0];
    }
    if (found === undefined) {
      out.push(...segments.slice(i));
      break;
    }
    out.push(found);
    existing++;
    dir = join(dir, found);
  }
  return { path: out.join('/'), existing };
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
