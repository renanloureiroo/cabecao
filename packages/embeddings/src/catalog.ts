/**
 * Catálogo das sugestões testadas (docs/06-busca-e-grafo.md, "Sugestões testadas").
 *
 * Origem de cada dado, para ninguém precisar adivinhar:
 * - repositório, arquivo ONNX (com o `_data` externo), dimensões, agregação e prefixos: `spikes/11-embeddings-eval/
 *   lib/models.mjs` (conferidos no model card) e os arquivos de fato carregados, registrados em
 *   `spikes/11-embeddings-eval/out/emb/<chave>.json` (`onnxFiles`, `onnxMB`, `tokenizerMB`);
 * - normalização L2: `embed.mjs` do mesmo spike normaliza sempre (`normalize: true` / `.normalize(2, -1)`);
 * - limite de tokens: `embed.mjs` usa `max_length: 2048` para os modelos que devolvem `sentence_embedding` (Gemma);
 *   nos demais o pipeline trunca no `model_max_length` do `tokenizer_config.json` (por isso `maxTokens` fica vazio);
 * - MRR@10 e R@1 só de paráfrase no conjunto sintético: `spikes/11-embeddings-eval/RESULTS.md`, apêndice A;
 * - licença e gating: apêndice D do mesmo arquivo e docs/06.
 *
 * O que os spikes NÃO registram e por isso fica sem valor: a revisão (commit) de cada repositório no Hugging Face. Os
 * arquivos são baixados de `main`.
 */

/**
 * Como os vetores por token viram um vetor por texto.
 * - `mean`: média dos tokens válidos (máscara de atenção);
 * - `cls`: o primeiro token;
 * - `last_token`: o último token válido de cada linha (o preenchimento é sempre à direita);
 * - `graph`: o próprio grafo ONNX já devolve `sentence_embedding` (agregação e camadas densas dentro do modelo).
 */
export type Pooling = 'mean' | 'cls' | 'last_token' | 'graph';
export const POOLINGS: readonly Pooling[] = ['mean', 'cls', 'last_token', 'graph'];

/**
 * Moldes do texto embutido. `{text}` é o trecho (ou a pergunta) e `{title}` é o contexto `Título › Seção`.
 * `passage` vale para trecho sem título; `passageWithTitle`, para trecho com título.
 */
export interface PromptTemplates {
  query: string;
  passage: string;
  passageWithTitle: string;
}

export interface CatalogVariant {
  /** Arquivo ONNX dentro do repositório. */
  file: string;
  /** Arquivos de pesos externos que o ONNX referencia (mesma pasta). */
  externalData: readonly string[];
  /** Tamanho medido dos arquivos ONNX, em MB (10^6 bytes). */
  onnxMB: number;
  /** MRR@10 no conjunto sintético (vetor sozinho, trecho com `Título › Seção`). */
  syntheticMrr: number;
  /** R@1 só nas perguntas de paráfrase, em %. */
  paraphraseR1: number;
}

export interface CatalogModel {
  /** Nome usado no `.cabecao.json` e na CLI. */
  name: string;
  /** Repositório ONNX no Hugging Face. */
  repo: string;
  /** Modelo original de onde o ONNX foi convertido. */
  origin: string;
  license: string;
  /** Se o repositório ONNX exige login ou aceite de termos. */
  gated: false;
  /** Observação sobre a licença, para mostrar antes da escolha. */
  licenseNote?: string;
  dims: number;
  pooling: Pooling;
  normalize: boolean;
  prompts: PromptTemplates;
  /** Limite de tokens por texto; vazio = `model_max_length` do `tokenizer_config.json`. */
  maxTokens?: number;
  /** Receita atual: versão de tudo o que muda os vetores além dos arquivos do modelo (ver `config.ts`). */
  recipe: number;
  /** Tamanho medido do `tokenizer.json`, em MB. */
  tokenizerMB: number;
  /** A variante da tabela do doc 06 (a que se recomenda). */
  defaultVariant: string;
  variants: Readonly<Record<string, CatalogVariant>>;
  /** Para que serve, como no doc 06. */
  indicatedFor: string;
}

/** e5: `query: ` / `passage: `, com o título na primeira linha do trecho. */
const E5_PROMPTS: PromptTemplates = {
  query: 'query: {text}',
  passage: 'passage: {text}',
  passageWithTitle: 'passage: {title}\n{text}',
};

/** EmbeddingGemma: o título vai no campo próprio do prompt; sem título, `none` (como o model card manda). */
const GEMMA_PROMPTS: PromptTemplates = {
  query: 'task: search result | query: {text}',
  passage: 'title: none | text: {text}',
  passageWithTitle: 'title: {title} | text: {text}',
};

/** Sem prefixo; o título na primeira linha. */
const PLAIN_PROMPTS: PromptTemplates = {
  query: '{text}',
  passage: '{text}',
  passageWithTitle: '{title}\n{text}',
};

const onnx = (name: string, external: boolean) => ({
  file: `onnx/${name}`,
  externalData: external ? [`onnx/${name}_data`] : [],
});

export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    name: 'embeddinggemma-300m',
    repo: 'onnx-community/embeddinggemma-300m-ONNX',
    origin: 'google/embeddinggemma-300m',
    license: 'Gemma Terms of Use',
    licenseNote: 'não é uma licença de código aberto reconhecida; leia os termos antes de escolher',
    gated: false,
    dims: 768,
    pooling: 'graph',
    normalize: true,
    prompts: GEMMA_PROMPTS,
    maxTokens: 2048,
    recipe: 1,
    tokenizerMB: 20.3,
    defaultVariant: 'q4',
    variants: {
      q4: { ...onnx('model_q4.onnx', true), onnxMB: 197.2, syntheticMrr: 0.872, paraphraseR1: 66.7 },
      q8: { ...onnx('model_quantized.onnx', true), onnxMB: 309.5, syntheticMrr: 0.871, paraphraseR1: 64.6 },
      q4f16: { ...onnx('model_q4f16.onnx', true), onnxMB: 176.1, syntheticMrr: 0.864, paraphraseR1: 62.5 },
      fp16: { ...onnx('model_fp16.onnx', true), onnxMB: 618.1, syntheticMrr: 0.862, paraphraseR1: 60.4 },
    },
    indicatedFor: 'Melhor qualidade em português',
  },
  {
    name: 'bge-m3',
    repo: 'Xenova/bge-m3',
    origin: 'BAAI/bge-m3',
    license: 'MIT',
    gated: false,
    dims: 1024,
    pooling: 'cls',
    normalize: true,
    prompts: PLAIN_PROMPTS,
    recipe: 1,
    tokenizerMB: 17.1,
    defaultVariant: 'q8',
    variants: {
      q8: { ...onnx('model_quantized.onnx', false), onnxMB: 569.7, syntheticMrr: 0.836, paraphraseR1: 47.9 },
    },
    indicatedFor: 'Boa qualidade com licença aberta, se o tamanho não incomodar',
  },
  {
    name: 'embeddinggemma-2',
    repo: 'onnx-community/embeddinggemma-2-ONNX',
    origin: 'google/embeddinggemma-2',
    license: 'Apache-2.0',
    gated: false,
    dims: 768,
    pooling: 'graph',
    normalize: true,
    prompts: GEMMA_PROMPTS,
    maxTokens: 2048,
    recipe: 1,
    tokenizerMB: 32.2,
    defaultVariant: 'q4',
    variants: {
      q4: { ...onnx('model_q4.onnx', true), onnxMB: 174.5, syntheticMrr: 0.802, paraphraseR1: 39.6 },
      q8: { ...onnx('model_quantized.onnx', true), onnxMB: 314.2, syntheticMrr: 0.818, paraphraseR1: 41.7 },
      q4f16: { ...onnx('model_q4f16.onnx', true), onnxMB: 157.4, syntheticMrr: 0.798, paraphraseR1: 37.5 },
      fp16: { ...onnx('model_fp16.onnx', true), onnxMB: 542.5, syntheticMrr: 0.817, paraphraseR1: 41.7 },
    },
    indicatedFor: 'Licença aberta e modelo leve',
  },
  {
    name: 'multilingual-e5-base',
    repo: 'Xenova/multilingual-e5-base',
    origin: 'intfloat/multilingual-e5-base',
    license: 'MIT',
    gated: false,
    dims: 768,
    pooling: 'mean',
    normalize: true,
    prompts: E5_PROMPTS,
    recipe: 1,
    tokenizerMB: 17.1,
    defaultVariant: 'q8',
    variants: {
      q8: { ...onnx('model_quantized.onnx', false), onnxMB: 278.6, syntheticMrr: 0.763, paraphraseR1: 39.6 },
    },
    indicatedFor: 'Alternativa aberta de tamanho médio',
  },
  {
    name: 'multilingual-e5-small',
    repo: 'Xenova/multilingual-e5-small',
    origin: 'intfloat/multilingual-e5-small',
    license: 'MIT',
    gated: false,
    dims: 384,
    pooling: 'mean',
    normalize: true,
    prompts: E5_PROMPTS,
    recipe: 1,
    tokenizerMB: 17.1,
    defaultVariant: 'q8',
    variants: {
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: MRR medido no spike 11, não é ln 2.
      q8: { ...onnx('model_quantized.onnx', false), onnxMB: 118.3, syntheticMrr: 0.693, paraphraseR1: 16.7 },
      fp32: { ...onnx('model.onnx', false), onnxMB: 470.3, syntheticMrr: 0.703, paraphraseR1: 18.8 },
    },
    indicatedFor: 'Máquinas fracas; depende muito da busca por palavra-chave',
  },
];

/** Procura um modelo do catálogo pelo nome. */
export function findCatalogModel(name: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((model) => model.name === name);
}

export const CATALOG_MODEL_NAMES: readonly string[] = MODEL_CATALOG.map((model) => model.name);
