// Projeto da sessão, a partir da pasta onde o Claude Code abriu: a raiz do repositório git que a contém (ou a própria
// pasta, fora de um repositório). O nome vira o escopo `project:<slug>` das notas, e é também a "tarefa" do briefing
// (a busca das memórias relevantes procura por ele).
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/** Quantas pastas acima a procura pelo `.git` sobe. */
const MAX_DEPTH = 40;

export interface Project {
  /** Nome da pasta do projeto, como está. */
  readonly name: string;
  /** Nome normalizado para o escopo (`project:<slug>`). */
  readonly slug: string;
  readonly root: string;
}

/** `Meu Projeto (v2)` → `meu-projeto-v2`; `Atlas` → `atlas`. Vazio quando não sobra nada. */
export function projectSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `child` é `parent` ou está dentro dela. */
function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Projeto da pasta `cwd`, ou `null` quando não há um que sirva de escopo: a pasta é o próprio cérebro (ou fica dentro
 * dele), é a pasta do usuário ou a raiz do disco, ou o nome não rende um slug.
 */
export async function projectOf(
  cwd: string,
  options: { brainRoot: string; home: string | null },
): Promise<Project | null> {
  const start = resolve(cwd);
  if (inside(start, resolve(options.brainRoot))) return null;
  let root = start;
  let dir = start;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (await exists(resolve(dir, '.git'))) {
      root = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (dirname(root) === root) return null;
  if (options.home !== null && resolve(options.home) === root) return null;
  const name = basename(root);
  const slug = projectSlug(name);
  return slug === '' ? null : { name, slug, root };
}
