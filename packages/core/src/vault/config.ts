// `.cabecao.json`: o único arquivo de configuração versionado do cérebro (docs/03-modelo-de-dados.md).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeRelativePath, normalizeNfc, toPosixPath, writeFileAtomic } from '../util/index.ts';
import { VaultError } from './errors.ts';
import { serializeWrites } from './queue.ts';

export const BRAIN_CONFIG_FILE = '.cabecao.json';
/** Versão do esquema que este código lê e grava. Um cérebro com versão maior pede um Cabeção mais novo. */
export const SUPPORTED_SCHEMA_VERSION = 1;
export const DEFAULT_NOTE_DIRS: readonly string[] = ['wiki', 'memory', 'raw'];
export const DEFAULT_INDEX_MD = 'index.md';
/**
 * O que fazer com um `.cabecao.json` inválido (JSON quebrado ou campo errado). Mostrado por `status`, `doctor`, pelas
 * tools do MCP e pela CLI.
 */
export const INVALID_CONFIG_HINT =
  'Corrija o .cabecao.json do cérebro (é JSON; "git log -p -- .cabecao.json" mostra as versões anteriores, inclusive a última que funcionava) ou desfaça a mudança que o quebrou. O "cabecao sync" continua rodando com a última configuração válida do histórico, então uma correção feita em outra máquina chega por ele.';
/** Diário append-only, sempre na raiz do cérebro. */
export const LOG_MD = 'log.md';

/** Modelo de embeddings escolhido pelo usuário; vale para todas as máquinas do cérebro. */
export interface EmbeddingConfig {
  readonly model: string;
  readonly variant: string;
  readonly dims: number;
  readonly recipe: number;
  /** Chaves que este código não conhece são mantidas. */
  readonly [key: string]: unknown;
}

/** Modelo do assunto dos commits (docs/12-commits.md). Os padrões ficam em `git/commit-message.ts`. */
export interface CommitConfig {
  readonly message?: string;
  readonly dateFormat?: string;
  readonly [key: string]: unknown;
}

export interface BrainConfig {
  readonly schemaVersion: number;
  /** Pastas (relativas à raiz, com `/`) onde ficam as notas. `"."` é a raiz inteira, para adotar um vault existente. */
  readonly noteDirs: readonly string[];
  /** Caminho do catálogo gerado. */
  readonly indexMd: string;
  readonly embedding?: EmbeddingConfig;
  readonly commit?: CommitConfig;
  /** Relações tipadas acrescentadas pelo usuário, além das fixas. Chave `relations` do arquivo. */
  readonly relations: readonly string[];
  /** Chaves de primeiro nível que este código não conhece; voltam para o arquivo na regravação. */
  readonly unknown: Readonly<Record<string, unknown>>;
}

const KNOWN_KEYS = new Set(['schemaVersion', 'noteDirs', 'indexMd', 'embedding', 'commit', 'relations']);
/** Nome de relação: identificador em minúsculas, como as chaves do frontmatter. */
export const RELATION_NAME_RE = /^[a-z][a-z0-9_]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Confere e normaliza o conteúdo de um `.cabecao.json` já lido. Lança `VaultError` (`config_invalid` ou
 * `config_schema_too_new`) com TODOS os problemas na mensagem. `path` só entra na mensagem.
 */
export function validateBrainConfig(value: unknown, path: string = BRAIN_CONFIG_FILE): BrainConfig {
  if (!isRecord(value)) {
    throw new VaultError('config_invalid', `${path}: o conteúdo deveria ser um objeto JSON`, { path });
  }
  const problems: string[] = [];

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    problems.push('"schemaVersion" deveria ser um número inteiro a partir de 1');
  } else if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new VaultError(
      'config_schema_too_new',
      `${path}: este cérebro usa o esquema ${schemaVersion}, e este Cabeção só entende até o ${SUPPORTED_SCHEMA_VERSION}. Atualize o Cabeção nesta máquina.`,
      { path },
    );
  }

  const noteDirs: string[] = [];
  if (!Array.isArray(value.noteDirs) || value.noteDirs.length === 0) {
    problems.push('"noteDirs" deveria ser uma lista com pelo menos uma pasta');
  } else {
    for (const dir of value.noteDirs as unknown[]) {
      const normalized = typeof dir === 'string' ? normalizeDir(dir) : null;
      if (normalized === null) {
        problems.push(`"noteDirs" tem uma pasta inválida (${JSON.stringify(dir)}): use caminhos relativos ao cérebro`);
      } else if (!noteDirs.includes(normalized)) {
        noteDirs.push(normalized);
      }
    }
  }

  let indexMd = DEFAULT_INDEX_MD;
  // forma canônica (`/`, NFC, sem `./`, `/./` nem barras repetidas): é com ela que todo o código compara caminhos, e
  // `wiki//Home.md` precisa ser o mesmo arquivo que `wiki/Home.md` para o catálogo continuar protegido
  const canonicalIndex = typeof value.indexMd === 'string' ? canonicalRelPath(value.indexMd) : '';
  if (typeof value.indexMd !== 'string' || !isSafeRelativePath(value.indexMd) || !/\.md$/i.test(canonicalIndex)) {
    problems.push('"indexMd" deveria ser o caminho relativo de um arquivo .md');
  } else {
    indexMd = canonicalIndex;
  }

  let embedding: EmbeddingConfig | undefined;
  if (value.embedding !== undefined) {
    const e = value.embedding;
    const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
    if (
      !isRecord(e) ||
      typeof e.model !== 'string' ||
      e.model === '' ||
      typeof e.variant !== 'string' ||
      !positive(e.dims) ||
      !positive(e.recipe)
    ) {
      problems.push('"embedding" deveria ter "model" e "variant" (textos), "dims" e "recipe" (inteiros positivos)');
    } else {
      embedding = e as EmbeddingConfig;
    }
  }

  let commit: CommitConfig | undefined;
  if (value.commit !== undefined) {
    const c = value.commit;
    const optionalText = (v: unknown): boolean => v === undefined || (typeof v === 'string' && v.trim() !== '');
    if (!isRecord(c) || !optionalText(c.message) || !optionalText(c.dateFormat)) {
      problems.push('"commit" deveria ter "message" e "dateFormat" como textos não vazios');
    } else {
      commit = c as CommitConfig;
    }
  }

  const relations: string[] = [];
  if (value.relations !== undefined) {
    if (!Array.isArray(value.relations)) {
      problems.push('"relations" deveria ser uma lista de nomes de relação');
    } else {
      for (const name of value.relations as unknown[]) {
        if (typeof name !== 'string' || !RELATION_NAME_RE.test(name)) {
          problems.push(
            `"relations" tem um nome inválido (${JSON.stringify(name)}): use minúsculas, dígitos e "_", como "mentored_by"`,
          );
        } else if (RESERVED_FIELD_NAMES.has(name)) {
          problems.push(`"relations" não pode usar "${name}": é um campo do frontmatter com outro significado`);
        } else if (!relations.includes(name)) {
          relations.push(name);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new VaultError('config_invalid', `${path}: ${problems.join('; ')}`, { path });
  }

  const unknown: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (!KNOWN_KEYS.has(key)) unknown[key] = item;

  return {
    schemaVersion: schemaVersion as number,
    noteDirs,
    indexMd,
    ...(embedding === undefined ? {} : { embedding }),
    ...(commit === undefined ? {} : { commit }),
    relations,
    unknown,
  };
}

/** Campos do frontmatter que não são relações; um nome de relação extra não pode coincidir com eles. */
const RESERVED_FIELD_NAMES = new Set([
  'id',
  'type',
  'title',
  'subject',
  'predicate',
  'object',
  'scope',
  'tags',
  'aliases',
  'sources',
  'trust',
  'origin',
  'created',
  'updated',
  'confirmed',
  'valid_from',
  'valid_until',
  'expires_at',
  'relations',
]);

/** Caminho relativo em forma canônica: `/`, NFC, sem segmentos vazios nem `.` (o mesmo que `normalizeRelPath`). */
function canonicalRelPath(path: string): string {
  return normalizeNfc(toPosixPath(path))
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** Pasta de notas em formato canônico (`/`, NFC, sem `./` nem barra final), ou `null` se for inválida. */
function normalizeDir(dir: string): string | null {
  const posix = normalizeNfc(toPosixPath(dir.trim()));
  if (posix === '.' || posix === './') return '.';
  if (!isSafeRelativePath(posix)) return null;
  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.');
  // `.cabecao/` é local e fora do git; `.obsidian/` é do Obsidian. Nenhuma pasta oculta guarda notas.
  if (segments.some((segment) => segment.startsWith('.'))) return null;
  return segments.join('/');
}

/** Configuração de um cérebro novo. */
export function defaultBrainConfig(): BrainConfig {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    noteDirs: [...DEFAULT_NOTE_DIRS],
    indexMd: DEFAULT_INDEX_MD,
    relations: [],
    unknown: {},
  };
}

export function brainConfigPath(root: string): string {
  return join(root, BRAIN_CONFIG_FILE);
}

/**
 * Lê e valida `<root>/.cabecao.json`. Lança `VaultError` com `config_not_found` (a pasta não é um cérebro),
 * `config_invalid_json`, `config_invalid` ou `config_schema_too_new`.
 */
export async function readBrainConfig(root: string): Promise<BrainConfig> {
  const path = brainConfigPath(root);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' || (cause as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new VaultError(
        'config_not_found',
        `não achei ${BRAIN_CONFIG_FILE} em ${root}: a pasta não é um cérebro do Cabeção. Rode "cabecao init".`,
        { path, cause },
      );
    }
    throw cause;
  }
  return parseBrainConfig(text, path);
}

/**
 * Lê e valida o TEXTO de um `.cabecao.json` (do disco ou de um commit). Lança `VaultError` com `config_invalid_json`,
 * `config_invalid` ou `config_schema_too_new`. `path` só entra na mensagem.
 */
export function parseBrainConfig(text: string, path: string = BRAIN_CONFIG_FILE): BrainConfig {
  let value: unknown;
  try {
    // Editores no Windows costumam gravar com BOM, que o JSON.parse não aceita.
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new VaultError('config_invalid_json', `${path}: o conteúdo não é JSON válido (${detail})`, { path, cause });
  }
  return validateBrainConfig(value, path);
}

/** `config_invalid_json` ou `config_invalid`: o arquivo existe, mas não vale (não inclui o esquema mais novo). */
export function isInvalidConfigError(error: unknown): error is VaultError {
  return error instanceof VaultError && (error.code === 'config_invalid_json' || error.code === 'config_invalid');
}

/** O objeto que vai para o arquivo: chaves conhecidas na ordem do doc 03, depois as desconhecidas. */
export function brainConfigToJson(config: BrainConfig): Record<string, unknown> {
  return {
    schemaVersion: config.schemaVersion,
    noteDirs: [...config.noteDirs],
    indexMd: config.indexMd,
    ...(config.embedding === undefined ? {} : { embedding: config.embedding }),
    ...(config.commit === undefined ? {} : { commit: config.commit }),
    ...(config.relations.length === 0 ? {} : { relations: [...config.relations] }),
    ...config.unknown,
  };
}

/** Valida e grava `<root>/.cabecao.json` de forma atômica (JSON com 2 espaços, terminado em LF). */
export async function writeBrainConfig(root: string, config: BrainConfig): Promise<void> {
  return serializeWrites(root, async () => {
    const path = brainConfigPath(root);
    // as chaves conhecidas mandam: uma chave "desconhecida" com nome conhecido não as sobrescreve
    const unknown = Object.fromEntries(Object.entries(config.unknown).filter(([key]) => !KNOWN_KEYS.has(key)));
    const valid = validateBrainConfig(brainConfigToJson({ ...config, unknown }), path);
    await writeFileAtomic(path, `${JSON.stringify(brainConfigToJson(valid), null, 2)}\n`);
  });
}
