import type { PromptTemplates } from './catalog.ts';

/** Pergunta de quem busca, ou trecho de nota a indexar. Cada modelo formata os dois de um jeito. */
export type EmbedKind = 'query' | 'passage';

/**
 * Texto a embutir. O título (`Título › Seção`) só é usado em trechos: cada modelo o põe num lugar (campo próprio no
 * EmbeddingGemma, primeira linha nos demais). Título vazio conta como ausente.
 */
export type EmbedInput = string | { text: string; title?: string | null | undefined };

const PLACEHOLDER_RE = /\{\{|\}\}|\{text\}|\{title\}/g;

/** Aplica um molde numa passada só: o texto inserido nunca é relido como molde. */
export function applyTemplate(template: string, values: { text: string; title?: string }): string {
  return template.replace(PLACEHOLDER_RE, (token) => {
    if (token === '{{') return '{';
    if (token === '}}') return '}';
    if (token === '{text}') return values.text;
    return values.title ?? '';
  });
}

/** O texto que de fato entra no modelo. É também o que o índice usa para calcular a chave do trecho. */
export function formatInput(prompts: PromptTemplates, input: EmbedInput, kind: EmbedKind): string {
  const text = typeof input === 'string' ? input : input.text;
  if (kind === 'query') return applyTemplate(prompts.query, { text });
  const title = typeof input === 'string' ? undefined : (input.title ?? undefined);
  if (title === undefined || title === '') return applyTemplate(prompts.passage, { text });
  return applyTemplate(prompts.passageWithTitle, { text, title });
}
