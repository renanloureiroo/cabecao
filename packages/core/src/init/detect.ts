/**
 * O que há num repositório: vazio, cérebro, vault de notas ou outra coisa (docs/04-sincronizacao.md, tabela da
 * instalação só com a URL).
 *
 * A decisão é tomada só pela lista de arquivos versionados (e pelo `.cabecao.json`, quando existe), sem ler o
 * conteúdo das notas. Os limiares estão em {@link DETECTION_RULES} e são os documentados abaixo.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { runGit } from '../git/index.ts';
import { isSafeRelativePath, normalizeNfc } from '../util/index.ts';
import type { BrainConfig } from '../vault/index.ts';
import {
  BRAIN_CONFIG_FILE,
  DEFAULT_NOTE_DIRS,
  ROOT_CONTROL_FILE_RE,
  VaultError,
  validateBrainConfig,
} from '../vault/index.ts';
import { isRepoRoot } from './shared.ts';

export type RepoKind = 'empty' | 'brain' | 'markdown-vault' | 'other';

/** Contagens usadas na decisão. "Conteúdo" são os arquivos fora de pastas ocultas e fora dos arquivos iniciais. */
export interface TreeStats {
  /** O repositório tem pelo menos um commit (ou, fora do git, pelo menos um arquivo). */
  readonly hasCommits: boolean;
  /** Arquivos versionados, inclusive ocultos. */
  readonly files: number;
  /** Arquivos fora de pastas ocultas, sem contar README, LICENSE e afins da raiz. */
  readonly content: number;
  readonly markdown: number;
  /** Imagens, PDFs, áudio, vídeo, `.canvas`, `.base`, `.excalidraw`... */
  readonly attachments: number;
  /** Arquivos com extensão de código-fonte. */
  readonly code: number;
  /** Tem `.obsidian/`. */
  readonly obsidian: boolean;
  /** Marcadores de projeto de código encontrados (`package.json`, `src/`...). */
  readonly codeMarkers: readonly string[];
}

export interface RepoDetection {
  readonly kind: RepoKind;
  /** Por que essa classificação, em português, pronto para mostrar. */
  readonly reason: string;
  readonly stats: TreeStats;
  /** Arquivos versionados (com `/`, em NFC), ordenados. Vazio quando não há commits. */
  readonly paths: readonly string[];
  /** Configuração lida, quando `kind` é `brain`. */
  readonly config?: BrainConfig;
}

/**
 * Critério de classificação, na ordem em que as regras são aplicadas (a primeira que casa decide):
 *
 * 1. Sem commits, ou sem nenhum arquivo: `empty`.
 * 2. `.cabecao.json` na raiz: `brain` se for válido; `other` se não for (o motivo diz o que corrigir).
 * 3. Só arquivos iniciais na raiz (`README*`, `LICENSE*`, `LICENCE*`, `COPYING*`, `.gitignore`, `.gitattributes`),
 *    como o provedor cria ao marcar "adicionar README": `empty`. O cérebro é criado ao lado deles.
 * 4. Algum marcador de projeto de código ({@link CODE_MARKER_FILES} na raiz, ou uma pasta `src/` de primeiro nível
 *    com código-fonte): `other`.
 * 5. Pasta `.obsidian/`: `markdown-vault`.
 * 6. Nenhum `.md` no conteúdo: `other`.
 * 7. `.md` + anexos ≥ {@link VAULT_MIN_NOTE_SHARE} (80%) do conteúdo: `markdown-vault`. Abaixo disso: `other`.
 */
export const VAULT_MIN_NOTE_SHARE = 0.8;

/** Arquivos de raiz que denunciam um projeto de código (ou um site de documentação). */
export const CODE_MARKER_FILES: readonly string[] = [
  'package.json',
  'deno.json',
  'tsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Pipfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'build.sbt',
  'Makefile',
  'CMakeLists.txt',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'Package.swift',
  'pubspec.yaml',
  'Dockerfile',
  'docker-compose.yml',
  'mkdocs.yml',
  '_config.yml',
  'hugo.toml',
  'book.toml',
];
const CODE_MARKER_EXTENSIONS = ['.csproj', '.sln', '.fsproj', '.vcxproj', '.cabal'];

const MARKDOWN_EXT = /\.(md|markdown)$/i;
const ATTACHMENT_EXT =
  /\.(png|jpe?g|gif|svg|webp|avif|bmp|heic|tiff?|ico|pdf|canvas|base|excalidraw|mp3|m4a|wav|ogg|flac|webm|mp4|mov|mkv|csv|tsv|txt|docx?|xlsx?|pptx?|epub|drawio)$/i;
const CODE_EXT =
  /\.(m?[jt]sx?|c[jt]s|py|go|rs|java|kts?|c|h|cc|cpp|hpp|cs|fs|swift|rb|php|sh|bash|zsh|ps1|lua|scala|clj|exs?|erl|hs|ml|vue|svelte|dart|r|jl|sql|html?|css|scss|less)$/i;
/** Arquivos que o provedor cria sozinho num repositório novo. Só contam na raiz. */
const STARTER_FILE = /^(readme|license|licence|copying)(\.[A-Za-z0-9]+)?$/i;
const STARTER_HIDDEN = new Set(['.gitignore', '.gitattributes']);

export const DETECTION_RULES = {
  vaultMinNoteShare: VAULT_MIN_NOTE_SHARE,
  codeMarkerFiles: CODE_MARKER_FILES,
  codeMarkerExtensions: CODE_MARKER_EXTENSIONS,
} as const;

const isHidden = (path: string): boolean => path.split('/').some((segment) => segment.startsWith('.'));
const isRootStarter = (path: string): boolean =>
  !path.includes('/') && (STARTER_FILE.test(path) || STARTER_HIDDEN.has(path));

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function computeStats(paths: readonly string[], hasCommits: boolean): TreeStats {
  const content = paths.filter((path) => !isHidden(path) && !isRootStarter(path));
  const markers = CODE_MARKER_FILES.filter((name) => paths.includes(name));
  for (const path of paths) {
    if (!path.includes('/') && CODE_MARKER_EXTENSIONS.some((ext) => path.endsWith(ext))) markers.push(path);
  }
  if (content.some((path) => path.startsWith('src/') && CODE_EXT.test(path))) markers.push('src/');
  return {
    hasCommits,
    files: paths.length,
    content: content.length,
    markdown: content.filter((path) => MARKDOWN_EXT.test(path)).length,
    attachments: content.filter((path) => ATTACHMENT_EXT.test(path)).length,
    code: content.filter((path) => CODE_EXT.test(path)).length,
    obsidian: paths.some((path) => path.startsWith('.obsidian/')),
    codeMarkers: markers,
  };
}

/**
 * Classifica uma lista de arquivos versionados (caminhos relativos com `/`). Função pura.
 *
 * @param brainConfigText conteúdo do `.cabecao.json` da raiz, quando ele está na lista.
 */
export function classifyTree(
  paths: readonly string[],
  options: { hasCommits?: boolean; brainConfigText?: string | null } = {},
): RepoDetection {
  const sorted = [...new Set(paths.map((path) => normalizeNfc(path)))].sort();
  const hasCommits = options.hasCommits ?? sorted.length > 0;
  const stats = computeStats(sorted, hasCommits);
  const result = (kind: RepoKind, reason: string, config?: BrainConfig): RepoDetection => ({
    kind,
    reason,
    stats,
    paths: sorted,
    ...(config === undefined ? {} : { config }),
  });

  if (!hasCommits) return result('empty', 'o repositório ainda não tem nenhum commit');
  if (sorted.length === 0) return result('empty', 'o repositório não tem nenhum arquivo');

  if (sorted.includes(BRAIN_CONFIG_FILE)) {
    try {
      const text = options.brainConfigText ?? '';
      const config = validateBrainConfig(JSON.parse(text.replace(/^﻿/, '')), BRAIN_CONFIG_FILE);
      return result('brain', `tem um ${BRAIN_CONFIG_FILE} válido: já é um cérebro do Cabeção`, config);
    } catch (error) {
      const detail = error instanceof VaultError ? error.message : `${BRAIN_CONFIG_FILE}: o conteúdo não é JSON válido`;
      return result('other', `tem um ${BRAIN_CONFIG_FILE}, mas ele não pode ser usado (${detail})`);
    }
  }

  if (sorted.every(isRootStarter)) {
    return result(
      'empty',
      `só tem os arquivos iniciais do provedor (${sorted.join(', ')}); o cérebro é criado ao lado deles`,
    );
  }

  if (stats.codeMarkers.length > 0) {
    return result('other', `parece um projeto de código: tem ${stats.codeMarkers.join(', ')}`);
  }
  if (stats.obsidian) return result('markdown-vault', 'tem a pasta .obsidian/: é um vault do Obsidian');
  if (stats.markdown === 0) {
    return result('other', `nenhum dos ${stats.content} arquivos de conteúdo é Markdown (.md)`);
  }
  const share = (stats.markdown + stats.attachments) / stats.content;
  if (share >= VAULT_MIN_NOTE_SHARE) {
    return result(
      'markdown-vault',
      `${percent(share)} dos arquivos são notas Markdown ou anexos (${stats.markdown} .md, ${stats.attachments} anexos)`,
    );
  }
  return result(
    'other',
    `só ${percent(share)} dos arquivos são notas Markdown ou anexos (o mínimo para um vault é ${percent(VAULT_MIN_NOTE_SHARE)}); ${stats.code} são código`,
  );
}

/** Arquivos de uma pasta que não é repositório git, como se fossem versionados (sem `.git/`). */
async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    out.push(rel);
  }
  return out;
}

export interface DetectOptions {
  /** Commit (ou referência) a examinar. Padrão: `HEAD`. Só vale para repositórios git. */
  readonly ref?: string;
}

/**
 * Classifica o repositório na pasta `dir` pelo conteúdo do commit `ref` (padrão `HEAD`), sem depender da pasta de
 * trabalho: funciona num clone feito com `--no-checkout`. Uma pasta que não é a raiz de um repositório git é
 * classificada pelos arquivos que há nela.
 */
export async function detectRepoKind(dir: string, options: DetectOptions = {}): Promise<RepoDetection> {
  if (!(await isRepoRoot(dir))) {
    const paths = await walkFiles(dir);
    const configText = paths.includes(BRAIN_CONFIG_FILE) ? await readFile(join(dir, BRAIN_CONFIG_FILE), 'utf8') : null;
    return classifyTree(paths, { hasCommits: paths.length > 0, brainConfigText: configText });
  }
  const ref = options.ref ?? 'HEAD';
  if (ref.startsWith('-')) throw new TypeError(`Referência inválida: "${ref}".`);
  const commit = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: dir,
    allowFailure: true,
  });
  if (commit.exitCode !== 0) return classifyTree([], { hasCommits: false });
  const sha = commit.stdout.trim();
  const { stdout } = await runGit(['ls-tree', '-r', '-z', '--name-only', sha], { cwd: dir });
  const paths = stdout.split('\0').filter((path) => path !== '');
  let configText: string | null = null;
  if (paths.includes(BRAIN_CONFIG_FILE)) {
    configText = (await runGit(['cat-file', '-p', `${sha}:${BRAIN_CONFIG_FILE}`], { cwd: dir })).stdout;
  }
  return classifyTree(paths, { hasCommits: true, brainConfigText: configText });
}

/**
 * Arquivos da raiz de um vault que não são notas do usuário. É a mesma lista que o vault usa para recusar a escrita
 * de agente nesses arquivos quando `noteDirs` é `["."]`.
 */
const ROOT_NON_NOTES = ROOT_CONTROL_FILE_RE;

export interface VaultLayout {
  /** Pastas de notas para o `.cabecao.json`: as padrão do Cabeção e as que já têm `.md`. */
  readonly noteDirs: string[];
  /** Notas soltas na raiz que levaram a usar `"."` (a raiz inteira) como pasta de notas. */
  readonly rootNotes: string[];
}

/**
 * Pastas de notas de um vault adotado, sem mover nada:
 *
 * - as pastas de primeiro nível (não ocultas) que têm pelo menos um `.md` em qualquer profundidade;
 * - mais `wiki`, `memory` e `raw`, onde o Cabeção grava as notas novas (as pastas só são criadas quando a primeira
 *   nota chega);
 * - se houver notas soltas na raiz (fora README, AGENTS, CLAUDE, index, log e afins), a raiz inteira (`"."`), que
 *   já cobre tudo.
 */
export function vaultLayout(paths: readonly string[]): VaultLayout {
  const notes = paths.map((path) => normalizeNfc(path)).filter((path) => MARKDOWN_EXT.test(path) && !isHidden(path));
  const rootNotes = notes.filter((path) => !path.includes('/') && !ROOT_NON_NOTES.test(path)).sort();
  if (rootNotes.length > 0) return { noteDirs: ['.'], rootNotes };
  const existing = new Set<string>();
  for (const path of notes) {
    const top = path.split('/')[0];
    if (top !== undefined && path.includes('/') && isSafeRelativePath(top)) existing.add(top);
  }
  // uma pasta que já existe com outra caixa (`Wiki`) toma o lugar da padrão (`wiki`): no Linux são pastas diferentes,
  // e no macOS e no Windows as duas grafias listariam os mesmos arquivos duas vezes
  const noteDirs = [...DEFAULT_NOTE_DIRS];
  const extra: string[] = [];
  for (const dir of [...existing].sort()) {
    const i = noteDirs.findIndex((base) => base.toLowerCase() === dir.toLowerCase());
    if (i === -1) extra.push(dir);
    else if (noteDirs[i] !== dir && DEFAULT_NOTE_DIRS.includes(noteDirs[i] ?? '')) noteDirs[i] = dir;
    else if (noteDirs[i] !== dir) extra.push(dir);
  }
  return { noteDirs: [...noteDirs, ...extra], rootNotes: [] };
}
