import { describe, expect, it } from 'vitest';
import {
  CATALOG_MODEL_NAMES,
  catalogConfig,
  EmbeddingConfigError,
  findCatalogModel,
  MODEL_CATALOG,
  resolveEmbeddingConfig,
  specKey,
  UnknownModelError,
  UnsupportedRecipeError,
} from '../src/index.ts';

describe('catálogo', () => {
  it('tem as cinco sugestões do doc 06, na ordem da tabela', () => {
    expect(CATALOG_MODEL_NAMES).toEqual([
      'embeddinggemma-300m',
      'bge-m3',
      'embeddinggemma-2',
      'multilingual-e5-base',
      'multilingual-e5-small',
    ]);
  });

  it('a variante padrão de cada modelo bate com o tamanho, o MRR e as paráfrases da tabela do doc 06', () => {
    const table: Record<string, [number, number, number, string]> = {
      'embeddinggemma-300m': [197, 0.872, 67, 'Gemma Terms of Use'],
      'bge-m3': [570, 0.836, 48, 'MIT'],
      'embeddinggemma-2': [175, 0.802, 40, 'Apache-2.0'],
      'multilingual-e5-base': [279, 0.763, 40, 'MIT'],
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: MRR medido no spike 11, não é ln 2.
      'multilingual-e5-small': [118, 0.693, 17, 'MIT'],
    };
    for (const model of MODEL_CATALOG) {
      const [size, mrr, paraphrase, license] = table[model.name] ?? [];
      const variant = model.variants[model.defaultVariant];
      expect(variant, model.name).toBeDefined();
      expect(Math.round(variant?.onnxMB ?? 0)).toBe(size);
      expect(variant?.syntheticMrr).toBe(mrr);
      expect(Math.round(variant?.paraphraseR1 ?? 0)).toBe(paraphrase);
      expect(model.license).toBe(license);
    }
  });

  it('tem tudo o que é preciso para rodar cada variante', () => {
    for (const model of MODEL_CATALOG) {
      expect(model.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(model.dims).toBeGreaterThan(0);
      expect(model.normalize).toBe(true);
      expect(model.recipe).toBe(1);
      expect(model.prompts.query).toContain('{text}');
      expect(model.prompts.passageWithTitle).toContain('{title}');
      for (const variant of Object.values(model.variants)) {
        expect(variant.file).toMatch(/^onnx\/.+\.onnx$/);
        for (const extra of variant.externalData) expect(extra).toBe(`${variant.file}_data`);
      }
    }
  });

  it('usa os prefixos e agregações medidos no spike 11', () => {
    expect(findCatalogModel('multilingual-e5-small')?.prompts.query).toBe('query: {text}');
    expect(findCatalogModel('multilingual-e5-base')?.pooling).toBe('mean');
    expect(findCatalogModel('bge-m3')?.pooling).toBe('cls');
    expect(findCatalogModel('bge-m3')?.prompts.query).toBe('{text}');
    expect(findCatalogModel('embeddinggemma-300m')?.pooling).toBe('graph');
    expect(findCatalogModel('embeddinggemma-2')?.prompts.passageWithTitle).toBe('title: {title} | text: {text}');
    expect(findCatalogModel('embeddinggemma-300m')?.variants.q4?.externalData).toEqual(['onnx/model_q4.onnx_data']);
  });
});

describe('resolveEmbeddingConfig: modelo do catálogo', () => {
  it('resolve a forma gravada no .cabecao.json (exemplo do doc 03)', () => {
    const spec = resolveEmbeddingConfig({ model: 'embeddinggemma-300m', variant: 'q4', dims: 768, recipe: 1 });
    expect(spec).toMatchObject({
      model: 'embeddinggemma-300m',
      variant: 'q4',
      recipe: 1,
      repo: 'onnx-community/embeddinggemma-300m-ONNX',
      revision: 'main',
      file: 'onnx/model_q4.onnx',
      externalData: ['onnx/model_q4.onnx_data'],
      dims: 768,
      pooling: 'graph',
      normalize: true,
      maxTokens: 2048,
      custom: false,
    });
    expect(specKey(spec)).toBe('embeddinggemma-300m-q4-r1');
  });

  it('usa a variante e a receita padrão quando faltam', () => {
    const spec = resolveEmbeddingConfig({ model: 'multilingual-e5-small' });
    expect(spec.variant).toBe('q8');
    expect(spec.file).toBe('onnx/model_quantized.onnx');
    expect(spec.maxTokens).toBeUndefined();
    expect(resolveEmbeddingConfig(catalogConfig('bge-m3'))).toMatchObject({ dims: 1024, pooling: 'cls' });
  });

  it('recusa nome desconhecido, variante inexistente, dims diferentes e receita que não conhece', () => {
    expect(() => resolveEmbeddingConfig({ model: 'gpt-embed' })).toThrow(UnknownModelError);
    expect(() => resolveEmbeddingConfig({ model: 'bge-m3', variant: 'q4' })).toThrow(/não tem a variante "q4"/);
    expect(() => resolveEmbeddingConfig({ model: 'bge-m3', dims: 768 })).toThrow(/1024/);
    const newer = (() => {
      try {
        resolveEmbeddingConfig({ model: 'bge-m3', recipe: 2 });
      } catch (error) {
        return error;
      }
    })();
    expect(newer).toBeInstanceOf(UnsupportedRecipeError);
    expect((newer as Error).message).toContain('atualize o Cabeção');
    expect(() => resolveEmbeddingConfig(null)).toThrow(EmbeddingConfigError);
    expect(() => resolveEmbeddingConfig({ model: '' })).toThrow(EmbeddingConfigError);
    expect(() => resolveEmbeddingConfig({ model: 'bge-m3', dims: '1024' })).toThrow(/inteiro/);
    expect(() => catalogConfig('bge-m3', 'fp16')).toThrow(EmbeddingConfigError);
  });

  it('os erros têm código estável', () => {
    try {
      resolveEmbeddingConfig({ model: 'nada' });
    } catch (error) {
      expect((error as UnknownModelError).code).toBe('EMBEDDINGS_UNKNOWN_MODEL');
    }
  });
});

describe('resolveEmbeddingConfig: modelo próprio', () => {
  const base = {
    model: 'meu-modelo',
    repo: 'alguem/modelo-ONNX',
    file: 'onnx/model.onnx',
    dims: 512,
    pooling: 'mean',
  };

  it('aceita a declaração mínima e aplica os padrões', () => {
    const spec = resolveEmbeddingConfig(base);
    expect(spec).toMatchObject({
      model: 'meu-modelo',
      variant: 'default',
      recipe: 1,
      revision: 'main',
      externalData: [],
      normalize: true,
      custom: true,
      prompts: { query: '{text}', passage: '{text}', passageWithTitle: '{title}\n{text}' },
    });
  });

  it('transforma prefixos em moldes, escapando chaves literais', () => {
    const spec = resolveEmbeddingConfig({ ...base, queryPrefix: 'q {x}: ', passagePrefix: 'doc: ', recipe: 3 });
    expect(spec.prompts.query).toBe('q {{x}}: {text}');
    expect(spec.prompts.passageWithTitle).toBe('doc: {title}\n{text}');
    expect(spec.recipe).toBe(3);
  });

  it('aceita moldes completos, pesos externos, revisão e limite de tokens', () => {
    const spec = resolveEmbeddingConfig({
      ...base,
      externalData: ['onnx/model.onnx_data'],
      revision: 'v1.0',
      maxTokens: 1024,
      normalize: false,
      pooling: 'last_token',
      prompts: { query: 'Q: {text}', passage: '{text}', passageWithTitle: 'title: {title} | text: {text}' },
    });
    expect(spec).toMatchObject({ externalData: ['onnx/model.onnx_data'], revision: 'v1.0', maxTokens: 1024 });
    expect(spec.normalize).toBe(false);
  });

  it('recusa declarações incompletas ou perigosas', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, model: 'bge-m3' }, /nome de um modelo do catálogo/],
      [{ ...base, model: 'Com Espaço' }, /"model"/],
      [{ ...base, repo: 'semdono' }, /dono\/nome/],
      [{ ...base, file: '../fora.onnx' }, /caminho relativo/],
      [{ ...base, file: 'onnx/model.bin' }, /\.onnx/],
      [{ ...base, dims: undefined }, /"dims" é obrigatório/],
      [{ ...base, dims: 0 }, /"dims"/],
      [{ ...base, pooling: 'max' }, /"pooling"/],
      [{ ...base, externalData: ['outra/pasta.onnx_data'] }, /mesma pasta/],
      [{ ...base, externalData: 'x' }, /lista/],
      [{ ...base, revision: '../main' }, /"revision"/],
      [{ ...base, normalize: 'sim' }, /"normalize"/],
      [{ ...base, prompts: { query: 'x', passage: '{text}', passageWithTitle: '{title}{text}' } }, /prompts.query/],
      [{ ...base, prompts: { query: '{text}', passage: '{text}', passageWithTitle: '{text}' } }, /\{title\}/],
      [{ ...base, queryPrefix: 'a', prompts: {} }, /não os dois/],
    ];
    for (const [config, message] of bad) {
      expect(() => resolveEmbeddingConfig(config), JSON.stringify(config)).toThrow(message);
    }
  });
});
