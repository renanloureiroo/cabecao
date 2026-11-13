/**
 * Erros do runtime de embeddings. Cada um tem um `code` estável, para a CLI e o servidor decidirem o que dizer
 * sem depender do texto da mensagem.
 */
export class EmbeddingsError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingsError';
    this.code = code;
  }
}

/** O runtime (onnxruntime + tokenizador) não está instalado no diretório de cache. */
export class RuntimeNotInstalledError extends EmbeddingsError {
  readonly dir: string;

  constructor(dir: string, detail?: string) {
    super(
      'EMBEDDINGS_RUNTIME_MISSING',
      `runtime de embeddings não instalado${detail ? ` (${detail})` : ''}: rode \`cabecao embeddings on\``,
    );
    this.name = 'RuntimeNotInstalledError';
    this.dir = dir;
  }
}

/** Não achei o npm sem passar por um shell. */
export class NpmNotFoundError extends EmbeddingsError {
  constructor(tried: readonly string[]) {
    super(
      'EMBEDDINGS_NPM_NOT_FOUND',
      `não encontrei o npm para instalar o runtime de embeddings (procurei: ${tried.join(', ') || 'nada'}). ` +
        'Instale o Node.js com o npm, ou rode o comando por `npx cabecao`.',
    );
    this.name = 'NpmNotFoundError';
  }
}

/** O `npm install` do runtime terminou com erro. */
export class RuntimeInstallError extends EmbeddingsError {
  readonly exitCode: number | null;
  readonly output: string;

  constructor(message: string, exitCode: number | null, output: string, options?: { cause?: unknown }) {
    super('EMBEDDINGS_INSTALL_FAILED', message, options);
    this.name = 'RuntimeInstallError';
    this.exitCode = exitCode;
    this.output = output;
  }
}

/** Nem o runtime nativo nem o WebAssembly carregam nesta máquina; nada ficou instalado. */
export class RuntimeUnavailableError extends EmbeddingsError {
  readonly reasons: Readonly<Record<string, string>>;

  constructor(reasons: Readonly<Record<string, string>>) {
    const detail = Object.entries(reasons)
      .map(([backend, reason]) => `${backend}: ${reason}`)
      .join('; ');
    super(
      'EMBEDDINGS_RUNTIME_UNAVAILABLE',
      `o runtime de embeddings não carrega nesta máquina (${detail}). A busca por palavra-chave continua funcionando.`,
    );
    this.name = 'RuntimeUnavailableError';
    this.reasons = reasons;
  }
}

/** Sem rede (ou o servidor não respondeu) ao baixar um arquivo que não está no cache. */
export class EmbeddingsNetworkError extends EmbeddingsError {
  readonly url: string;

  constructor(url: string, detail: string, options?: { cause?: unknown }) {
    super(
      'EMBEDDINGS_OFFLINE',
      `não consegui baixar ${url} (${detail}). O modelo precisa de rede só no primeiro uso; tente de novo com conexão.`,
      options,
    );
    this.name = 'EmbeddingsNetworkError';
    this.url = url;
  }
}

/** O repositório ou o arquivo do modelo não existe (ou é privado / exige aceite de termos). */
export class ModelNotFoundError extends EmbeddingsError {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number) {
    const hint =
      status === 401 || status === 403
        ? 'o repositório é privado ou exige aceitar termos no Hugging Face, o que o Cabeção não suporta'
        : 'confira o repositório e o arquivo declarados';
    super('EMBEDDINGS_MODEL_NOT_FOUND', `arquivo do modelo não encontrado: ${url} (HTTP ${status}); ${hint}`);
    this.name = 'ModelNotFoundError';
    this.url = url;
    this.status = status;
  }
}

/** O modelo devolveu vetores com outro número de dimensões que o declarado. */
export class DimensionMismatchError extends EmbeddingsError {
  readonly expected: number;
  readonly actual: number;

  constructor(model: string, expected: number, actual: number) {
    super(
      'EMBEDDINGS_DIMS_MISMATCH',
      `o modelo ${model} devolveu vetores de ${actual} dimensões, mas a configuração declara ${expected}`,
    );
    this.name = 'DimensionMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** A sessão ONNX não abriu, ou o grafo não tem as entradas e saídas esperadas. */
export class ModelLoadError extends EmbeddingsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('EMBEDDINGS_MODEL_LOAD_FAILED', message, options);
    this.name = 'ModelLoadError';
  }
}

/** O campo `embedding` do `.cabecao.json` não é válido. */
export class EmbeddingConfigError extends EmbeddingsError {
  constructor(message: string, code = 'EMBEDDINGS_CONFIG_INVALID') {
    super(code, `configuração de embeddings inválida: ${message}`);
    this.name = 'EmbeddingConfigError';
  }
}

/** O nome do modelo não está no catálogo e a configuração não declara um modelo próprio. */
export class UnknownModelError extends EmbeddingConfigError {
  readonly model: string;

  constructor(model: string, known: readonly string[]) {
    super(
      `modelo desconhecido "${model}". Sugestões: ${known.join(', ')}; ou declare um modelo próprio com "repo", "file", "dims" e "pooling"`,
      'EMBEDDINGS_UNKNOWN_MODEL',
    );
    this.name = 'UnknownModelError';
    this.model = model;
  }
}

/** O cérebro usa uma receita que esta versão do Cabeção não sabe reproduzir. */
export class UnsupportedRecipeError extends EmbeddingConfigError {
  readonly recipe: number;
  readonly supported: number;

  constructor(model: string, recipe: number, supported: number) {
    const what =
      recipe > supported
        ? 'atualize o Cabeção nesta máquina'
        : `rode \`cabecao embeddings switch ${model}\` para recalcular com a receita ${supported}`;
    super(
      `o cérebro usa a receita ${recipe} do modelo ${model}, e esta versão só conhece a receita ${supported}: ${what}`,
      'EMBEDDINGS_RECIPE_UNSUPPORTED',
    );
    this.name = 'UnsupportedRecipeError';
    this.recipe = recipe;
    this.supported = supported;
  }
}
