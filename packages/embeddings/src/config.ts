import { CATALOG_MODEL_NAMES, findCatalogModel, POOLINGS, type Pooling, type PromptTemplates } from './catalog.ts';
import { EmbeddingConfigError, UnknownModelError, UnsupportedRecipeError } from './errors.ts';

/**
 * Tudo o que é preciso para baixar e rodar um modelo e reproduzir os mesmos vetores em outra máquina.
 *
 * ## Receita (`recipe`)
 *
 * Os arquivos do modelo não bastam para definir um vetor: o texto que entra (prefixos de pergunta e de trecho, onde
 * vai o título), o corte em tokens, a agregação e a normalização também mudam o resultado. A receita é um número
 * inteiro que versiona esse conjunto. Os vetores ficam em `embeddings/<modelo>-<variante>-r<receita>/` na branch de
 * índice, e qualquer mudança em um desses itens exige uma receita nova: os vetores antigos deixam de valer e
 * `cabecao embeddings switch` recalcula tudo numa pasta nova.
 *
 * Receita 1 (a de todos os modelos do catálogo hoje):
 * - moldes de `prompts` aplicados ao texto (pergunta, trecho sem título, trecho com `Título › Seção`);
 * - tokenização com os tokens especiais do próprio tokenizador; texto mais longo que `maxTokens` (ou que o
 *   `model_max_length` do `tokenizer_config.json`, se `maxTokens` estiver vazio) é cortado no fim, mantendo os tokens
 *   especiais do começo e do fim;
 * - preenchimento à direita com o token de preenchimento do tokenizador;
 * - agregação `pooling` sobre a saída do grafo e, se `normalize`, normalização L2.
 *
 * Num modelo próprio quem cuida da receita é o dono do cérebro: ao mudar prefixos, agregação ou normalização,
 * ele aumenta o número no `.cabecao.json`.
 */
export interface ModelSpec {
  /** Nome do modelo (do catálogo ou dado pelo usuário ao modelo próprio). */
  model: string;
  variant: string;
  recipe: number;
  /** Repositório no Hugging Face (`dono/nome`). */
  repo: string;
  /** Revisão (branch, tag ou commit) de onde os arquivos são baixados. */
  revision: string;
  /** Arquivo ONNX dentro do repositório. */
  file: string;
  /** Pesos externos referenciados pelo ONNX, na mesma pasta. */
  externalData: readonly string[];
  dims: number;
  pooling: Pooling;
  normalize: boolean;
  prompts: PromptTemplates;
  /** Limite de tokens por texto; vazio = `model_max_length` do tokenizador. */
  maxTokens?: number;
  /** `true` para um modelo declarado no `.cabecao.json` e fora do catálogo (nunca medido). */
  custom: boolean;
}

/** Forma curta gravada no `.cabecao.json` para um modelo do catálogo. */
export interface CatalogEmbeddingConfig {
  model: string;
  variant: string;
  dims: number;
  recipe: number;
  /**
   * Revisão (commit) do repositório no Hugging Face de onde os arquivos vêm. O catálogo não fixa revisão (os arquivos
   * saem de `main`); a CLI grava aqui o commit resolvido na primeira escolha do modelo, para todas as máquinas
   * baixarem os MESMOS arquivos. Ausente: `main`.
   */
  revision?: string;
}

/**
 * Declaração completa de um modelo próprio no `.cabecao.json`. Os prefixos são o jeito simples (o título entra na
 * primeira linha do trecho); `prompts` substitui os prefixos por moldes completos com `{text}` e `{title}`.
 */
export interface CustomEmbeddingConfig {
  model: string;
  repo: string;
  file: string;
  dims: number;
  pooling: Pooling;
  variant?: string;
  recipe?: number;
  revision?: string;
  externalData?: string[];
  normalize?: boolean;
  queryPrefix?: string;
  passagePrefix?: string;
  prompts?: PromptTemplates;
  maxTokens?: number;
}

export type EmbeddingConfig = CatalogEmbeddingConfig | CustomEmbeddingConfig;

export const DEFAULT_REVISION = 'main';
const DEFAULT_CUSTOM_VARIANT = 'default';
const MAX_DIMS = 8192;
const MAX_TOKENS = 32_768;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * Configuração para gravar no `.cabecao.json` ao escolher um modelo do catálogo. Sem `revision`: quem chama resolve o
 * commit com `resolveModelRevision` e o acrescenta antes de gravar.
 */
export function catalogConfig(name: string, variant?: string): CatalogEmbeddingConfig {
  const model = findCatalogModel(name);
  if (!model) throw new UnknownModelError(name, CATALOG_MODEL_NAMES);
  const chosen = variant ?? model.defaultVariant;
  if (!model.variants[chosen]) {
    throw new EmbeddingConfigError(
      `o modelo ${name} não tem a variante "${chosen}" (há: ${Object.keys(model.variants).join(', ')})`,
    );
  }
  return { model: name, variant: chosen, dims: model.dims, recipe: model.recipe };
}

/**
 * Converte o campo `embedding` do `.cabecao.json` (ainda não validado) num `ModelSpec`. Com `repo`, é a declaração de
 * um modelo próprio; sem `repo`, o nome tem de estar no catálogo, e `variant`, `dims` e `recipe`, se presentes, têm
 * de bater com ele.
 */
export function resolveEmbeddingConfig(config: unknown): ModelSpec {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new EmbeddingConfigError('"embedding" deve ser um objeto');
  }
  const raw = config as Record<string, unknown>;
  const model = requireString(raw, 'model');
  if (raw.repo !== undefined) return resolveCustom(raw, model);

  const entry = findCatalogModel(model);
  if (!entry) throw new UnknownModelError(model, CATALOG_MODEL_NAMES);
  const variantName = optionalString(raw, 'variant') ?? entry.defaultVariant;
  const variant = entry.variants[variantName];
  if (!variant) {
    throw new EmbeddingConfigError(
      `o modelo ${model} não tem a variante "${variantName}" (há: ${Object.keys(entry.variants).join(', ')})`,
    );
  }
  const dims = optionalInteger(raw, 'dims', 1, MAX_DIMS);
  if (dims !== undefined && dims !== entry.dims) {
    throw new EmbeddingConfigError(`"dims" é ${dims}, mas o modelo ${model} tem ${entry.dims} dimensões`);
  }
  const recipe = optionalInteger(raw, 'recipe', 1, Number.MAX_SAFE_INTEGER) ?? entry.recipe;
  if (recipe !== entry.recipe) throw new UnsupportedRecipeError(model, recipe, entry.recipe);
  const revision = optionalString(raw, 'revision') ?? DEFAULT_REVISION;
  checkRevision(revision);

  return {
    model,
    variant: variantName,
    recipe,
    repo: entry.repo,
    revision,
    file: variant.file,
    externalData: variant.externalData,
    dims: entry.dims,
    pooling: entry.pooling,
    normalize: entry.normalize,
    prompts: entry.prompts,
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    custom: false,
  };
}

function resolveCustom(raw: Record<string, unknown>, model: string): ModelSpec {
  if (findCatalogModel(model)) {
    throw new EmbeddingConfigError(
      `"${model}" é o nome de um modelo do catálogo; dê outro nome ao modelo próprio, ou tire "repo" para usar o do catálogo`,
    );
  }
  if (!NAME_RE.test(model)) {
    throw new EmbeddingConfigError(
      `"model" deve ter de 1 a 64 caracteres entre letras minúsculas, dígitos, ".", "_" e "-" (veio "${model}")`,
    );
  }
  const repo = requireString(raw, 'repo');
  if (!REPO_RE.test(repo)) throw new EmbeddingConfigError(`"repo" deve ser "dono/nome" (veio "${repo}")`);
  const file = requireString(raw, 'file');
  checkRepoPath(file, 'file');
  if (!file.endsWith('.onnx'))
    throw new EmbeddingConfigError(`"file" deve apontar para um arquivo .onnx (veio "${file}")`);

  const dims = optionalInteger(raw, 'dims', 1, MAX_DIMS);
  if (dims === undefined) throw new EmbeddingConfigError('"dims" é obrigatório num modelo próprio');
  const pooling = requireString(raw, 'pooling');
  if (!(POOLINGS as readonly string[]).includes(pooling)) {
    throw new EmbeddingConfigError(`"pooling" deve ser um de ${POOLINGS.join(', ')} (veio "${pooling}")`);
  }

  const variant = optionalString(raw, 'variant') ?? DEFAULT_CUSTOM_VARIANT;
  if (!NAME_RE.test(variant)) throw new EmbeddingConfigError(`"variant" inválida: "${variant}"`);
  const revision = optionalString(raw, 'revision') ?? DEFAULT_REVISION;
  checkRevision(revision);
  const recipe = optionalInteger(raw, 'recipe', 1, Number.MAX_SAFE_INTEGER) ?? 1;
  const maxTokens = optionalInteger(raw, 'maxTokens', 8, MAX_TOKENS);

  let externalData: string[] = [];
  if (raw.externalData !== undefined) {
    if (!Array.isArray(raw.externalData) || !raw.externalData.every((item) => typeof item === 'string')) {
      throw new EmbeddingConfigError('"externalData" deve ser uma lista de caminhos');
    }
    externalData = raw.externalData as string[];
    for (const item of externalData) {
      checkRepoPath(item, 'externalData');
      if (dirnameOf(item) !== dirnameOf(file)) {
        throw new EmbeddingConfigError(`"externalData" deve ficar na mesma pasta de "file" (veio "${item}")`);
      }
    }
  }

  let normalize = true;
  if (raw.normalize !== undefined) {
    if (typeof raw.normalize !== 'boolean') throw new EmbeddingConfigError('"normalize" deve ser true ou false');
    normalize = raw.normalize;
  }

  let prompts: PromptTemplates;
  if (raw.prompts !== undefined) {
    if (raw.queryPrefix !== undefined || raw.passagePrefix !== undefined) {
      throw new EmbeddingConfigError('use "prompts" ou os prefixos ("queryPrefix", "passagePrefix"), não os dois');
    }
    prompts = parsePrompts(raw.prompts);
  } else {
    const queryPrefix = optionalString(raw, 'queryPrefix', true) ?? '';
    const passagePrefix = optionalString(raw, 'passagePrefix', true) ?? '';
    prompts = {
      query: `${escapeTemplate(queryPrefix)}{text}`,
      passage: `${escapeTemplate(passagePrefix)}{text}`,
      passageWithTitle: `${escapeTemplate(passagePrefix)}{title}\n{text}`,
    };
  }

  return {
    model,
    variant,
    recipe,
    repo,
    revision,
    file,
    externalData,
    dims,
    pooling: pooling as Pooling,
    normalize,
    prompts,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    custom: true,
  };
}

function checkRevision(revision: string): void {
  if (!REVISION_RE.test(revision) || revision.includes('..')) {
    throw new EmbeddingConfigError(`"revision" inválida: "${revision}"`);
  }
}

/** Commit do git (40 dígitos hexadecimais, minúsculos): a forma de `revision` que fixa os arquivos. */
export function isCommitRevision(revision: string): boolean {
  return /^[0-9a-f]{40}$/.test(revision);
}

function parsePrompts(value: unknown): PromptTemplates {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EmbeddingConfigError('"prompts" deve ser um objeto com "query", "passage" e "passageWithTitle"');
  }
  const raw = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of ['query', 'passage', 'passageWithTitle'] as const) {
    const template = raw[key];
    if (typeof template !== 'string' || !template.includes('{text}')) {
      throw new EmbeddingConfigError(`"prompts.${key}" deve ser um texto com {text}`);
    }
    result[key] = template;
  }
  if (!result.passageWithTitle?.includes('{title}')) {
    throw new EmbeddingConfigError('"prompts.passageWithTitle" deve conter {title}');
  }
  return result as unknown as PromptTemplates;
}

/** Um prefixo vira parte de um molde: chaves literais não podem ser confundidas com `{text}` ou `{title}`. */
function escapeTemplate(prefix: string): string {
  return prefix.replaceAll('{', '{{').replaceAll('}', '}}');
}

function checkRepoPath(path: string, field: string): void {
  const bad =
    path.length === 0 ||
    path.length > 256 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..');
  if (bad)
    throw new EmbeddingConfigError(`"${field}" deve ser um caminho relativo dentro do repositório (veio "${path}")`);
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new EmbeddingConfigError(`"${key}" deve ser um texto não vazio`);
  }
  return value;
}

function optionalString(raw: Record<string, unknown>, key: string, allowEmpty = false): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new EmbeddingConfigError(`"${key}" deve ser um texto${allowEmpty ? '' : ' não vazio'}`);
  }
  return value;
}

function optionalInteger(raw: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new EmbeddingConfigError(`"${key}" deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

/** Nome da pasta dos vetores na branch de índice: `<modelo>-<variante>-r<receita>`. */
export function specKey(spec: Pick<ModelSpec, 'model' | 'variant' | 'recipe'>): string {
  return `${spec.model}-${spec.variant}-r${spec.recipe}`;
}
