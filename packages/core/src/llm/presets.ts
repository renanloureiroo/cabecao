// Provedores conhecidos: endereço, variável de ambiente da chave, modelo padrão e o que a política de dados de cada um
// diz (resumo, link oficial e data da consulta). Tudo conferido na documentação oficial em 13/11/2026; os modelos
// padrão são os mais baratos com saída estruturada naquela data (o usuário troca com `--model`).
//
// O Antigravity instalado (`agy`) NÃO está aqui de propósito: a FAQ oficial diz que embrulhar o `agy` em outro
// aplicativo "is not supported under consumer plans" (https://antigravity.google/docs/faq, consultada em 13/11/2026).
// Os modelos do Google entram pela API do Gemini, com chave.

export const HTTP_PRESET_IDS = [
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'groq',
  'ollama',
  'lmstudio',
  'compatible',
] as const;
export type HttpPresetId = (typeof HTTP_PRESET_IDS)[number];

export type HttpApi = 'anthropic' | 'openai-compatible';

export interface DataPolicy {
  /** Uma ou duas frases, em português, do que a política diz sobre retenção e treino. */
  readonly summary: string;
  readonly url: string;
  /** Data em que a página foi consultada. */
  readonly checked: string;
}

export interface HttpPreset {
  readonly id: HttpPresetId;
  readonly api: HttpApi;
  /** Nome para o usuário. */
  readonly label: string;
  /** Para onde vai o conteúdo (mostrado na ativação e no status). */
  readonly destination: string;
  /** Endereço base (`null`: o usuário informa). */
  readonly baseUrl: string | null;
  /** Variável de ambiente lida primeiro (`null`: sem chave, como um servidor local). */
  readonly envKey: string | null;
  /** Pede chave? (Servidores locais normalmente não.) */
  readonly needsKey: boolean;
  readonly defaultModel: string | null;
  /** Onde ver os modelos. */
  readonly modelsUrl: string | null;
  readonly policy: DataPolicy | null;
  /** Campo do limite de saída no Chat Completions. */
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** Transmite a resposta aos poucos junto com a saída estruturada. */
  readonly stream: boolean;
  /** Pede o uso de tokens no fim do streaming (`stream_options.include_usage`). */
  readonly streamUsage: boolean;
  /** Campos extras no corpo (OpenRouter: só provedores que aceitam todos os parâmetros e não coletam dados). */
  readonly extraBody: Readonly<Record<string, unknown>>;
  /** Aviso obrigatório na ativação. */
  readonly warning: string | null;
}

const CHECKED = '2026-11-13';

export const GEMINI_FREE_TIER_WARNING =
  'Na camada GRATUITA da API do Gemini, o Google usa o que você envia e as respostas para melhorar os produtos dele, e pessoas podem ler, anotar e processar esse conteúdo (desvinculado da sua conta). Na camada PAGA (projeto do Google Cloud com faturamento ativo), o Google não usa os prompts para melhorar os produtos e guarda os registros por tempo limitado, só para detectar abuso. No Espaço Econômico Europeu, Suíça e Reino Unido valem os termos pagos mesmo sem pagar.';

export const HTTP_PRESETS: Readonly<Record<HttpPresetId, HttpPreset>> = {
  anthropic: {
    id: 'anthropic',
    api: 'anthropic',
    label: 'Anthropic (API da Claude)',
    destination: 'Anthropic (API da Claude, api.anthropic.com)',
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    needsKey: true,
    defaultModel: 'claude-haiku-5-5',
    modelsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    policy: {
      summary:
        'Produtos comerciais (a API com chave): por padrão, a Anthropic não usa as entradas e saídas para treinar modelos, a não ser que você envie feedback ou permita.',
      url: 'https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training',
      checked: CHECKED,
    },
    maxTokensField: 'max_tokens',
    stream: true,
    streamUsage: false,
    extraBody: {},
    warning: null,
  },
  openai: {
    id: 'openai',
    api: 'openai-compatible',
    label: 'OpenAI',
    destination: 'OpenAI (api.openai.com)',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    needsKey: true,
    defaultModel: 'gpt-6-luna',
    modelsUrl: 'https://developers.openai.com/api/docs/models',
    policy: {
      summary:
        'O que vai para a API da OpenAI não é usado para treinar modelos, a não ser que você opte por compartilhar; os registros de monitoramento de abuso ficam até 30 dias.',
      url: 'https://developers.openai.com/api/docs/guides/your-data',
      checked: CHECKED,
    },
    maxTokensField: 'max_completion_tokens',
    stream: true,
    streamUsage: true,
    extraBody: {},
    warning: null,
  },
  gemini: {
    id: 'gemini',
    api: 'openai-compatible',
    label: 'Google Gemini (API, com chave do Google AI Studio)',
    destination: 'Google (API do Gemini, generativelanguage.googleapis.com)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    needsKey: true,
    defaultModel: 'gemini-3.5-flash-lite',
    modelsUrl: 'https://aistudio.google.com/docs/models',
    policy: {
      summary: GEMINI_FREE_TIER_WARNING,
      url: 'https://aistudio.google.com/docs/terms',
      checked: CHECKED,
    },
    maxTokensField: 'max_tokens',
    stream: true,
    streamUsage: false,
    extraBody: {},
    warning: GEMINI_FREE_TIER_WARNING,
  },
  openrouter: {
    id: 'openrouter',
    api: 'openai-compatible',
    label: 'OpenRouter',
    destination: 'OpenRouter (openrouter.ai) e o provedor que ele escolher para o modelo',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    needsKey: true,
    defaultModel: null,
    modelsUrl: 'https://openrouter.ai/models',
    policy: {
      summary:
        'O OpenRouter não guarda os prompts nem as respostas, a não ser que você ative o registro; o Cabeção pede só provedores que não coletam dados (provider.data_collection: "deny") e que aceitam todos os parâmetros do pedido.',
      url: 'https://openrouter.ai/docs/guides/privacy/data-collection',
      checked: CHECKED,
    },
    maxTokensField: 'max_tokens',
    stream: true,
    streamUsage: true,
    extraBody: { provider: { require_parameters: true, data_collection: 'deny' } },
    warning: null,
  },
  groq: {
    id: 'groq',
    api: 'openai-compatible',
    label: 'Groq',
    destination: 'Groq (api.groq.com)',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    needsKey: true,
    defaultModel: 'openai/gpt-oss-20b',
    modelsUrl: 'https://console.groq.com/docs/structured-outputs',
    policy: {
      summary:
        'Por padrão, a Groq não guarda os dados das requisições; pode registrá-los por até 30 dias para investigar erro ou abuso.',
      url: 'https://console.groq.com/docs/your-data',
      checked: CHECKED,
    },
    maxTokensField: 'max_completion_tokens',
    // a Groq não transmite aos poucos com saída estruturada
    stream: false,
    streamUsage: false,
    extraBody: {},
    warning: null,
  },
  ollama: {
    id: 'ollama',
    api: 'openai-compatible',
    label: 'Ollama (servidor local)',
    destination: 'Ollama nesta máquina (localhost:11434)',
    baseUrl: 'http://localhost:11434/v1',
    envKey: null,
    needsKey: false,
    defaultModel: null,
    modelsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    policy: null,
    maxTokensField: 'max_tokens',
    stream: true,
    streamUsage: false,
    extraBody: {},
    // o aviso dos modelos "-cloud" (que rodam no ollama.com mesmo chamados por localhost) sai só para eles, no `llm on`
    warning: null,
  },
  lmstudio: {
    id: 'lmstudio',
    api: 'openai-compatible',
    label: 'LM Studio (servidor local)',
    destination: 'LM Studio nesta máquina (localhost:1234)',
    baseUrl: 'http://localhost:1234/v1',
    envKey: null,
    needsKey: false,
    defaultModel: null,
    modelsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    policy: null,
    maxTokensField: 'max_tokens',
    stream: true,
    streamUsage: false,
    extraBody: {},
    warning: null,
  },
  compatible: {
    id: 'compatible',
    api: 'openai-compatible',
    label: 'Outro serviço compatível com a API da OpenAI',
    destination: 'o endereço que você informar',
    baseUrl: null,
    envKey: null,
    needsKey: true,
    defaultModel: null,
    modelsUrl: null,
    policy: null,
    maxTokensField: 'max_tokens',
    stream: true,
    streamUsage: false,
    extraBody: {},
    warning: null,
  },
};

export function isHttpPresetId(value: string): value is HttpPresetId {
  return (HTTP_PRESET_IDS as readonly string[]).includes(value);
}

/** Modelo do Ollama que roda na nuvem do ollama.com (o conteúdo sai da máquina mesmo por localhost). */
export function isOllamaCloudModel(model: string): boolean {
  return /(?:-|:)cloud\b/i.test(model);
}
