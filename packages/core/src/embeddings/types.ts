// Contrato entre o núcleo e o runtime de embeddings (`packages/embeddings`). O núcleo não importa aquele pacote: a
// CLI e o servidor MCP injetam um `EmbeddingProvider` em `openBrain`, e os testes injetam um com o embedder falso.
// Assim o núcleo continua sem nenhuma dependência de aprendizado de máquina (doc 06, "Runtime de embeddings").
import type { EmbeddingConfig } from '../vault/index.ts';

/** Pergunta de quem busca, ou trecho de nota a indexar: cada modelo formata os dois de um jeito. */
export type EmbedKind = 'query' | 'passage';

/** Texto a embutir; o título (`Título › Seção`) só vale para trechos. */
export type EmbedText = string | { readonly text: string; readonly title?: string | null | undefined };

/** O que o núcleo usa de um embedder (a forma do `Embedder` de `packages/embeddings`). */
export interface EmbedderLike {
  readonly model?: string;
  readonly dims: number;
  /** `native`, `wasm` ou `fake`. */
  readonly backend: string;
  /** Um vetor por texto, na mesma ordem. */
  embed(texts: readonly EmbedText[], kind: EmbedKind): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

/** O modelo do `.cabecao.json`, já conferido. */
export interface ResolvedEmbedding {
  readonly model: string;
  readonly variant: string;
  readonly recipe: number;
  readonly dims: number;
  /** Pasta dos vetores na branch de índice: `<modelo>-<variante>-r<receita>`. */
  readonly modelDir: string;
  /** Revisão (commit) gravada no `.cabecao.json`; `null` quando não há (os arquivos vêm de `main`). */
  readonly revision: string | null;
}

/** Se o runtime e o modelo estão prontos nesta máquina, sem carregar nada. */
export type EmbeddingAvailability =
  | { readonly ok: true; readonly backend: string | null; readonly modelCached: boolean | null }
  | {
      readonly ok: false;
      /** `runtime_missing`, `runtime_outdated`, `invalid_config`... (estável, para a CLI e o servidor decidirem). */
      readonly code: string;
      readonly reason: string;
    };

/** Progresso da carga do modelo (download dos arquivos, quando faltam no cache). */
export interface EmbeddingLoadProgress {
  readonly file: string;
  readonly loaded: number;
  readonly total: number | null;
}

/**
 * O runtime de embeddings, injetado por quem abre o cérebro. `resolve` e `available` não carregam nada; só `load`
 * abre o modelo (e pode baixá-lo, se faltar no cache).
 */
export interface EmbeddingProvider {
  /** Confere o campo `embedding` do `.cabecao.json`. Lança com mensagem clara se ele não vale. */
  resolve(config: EmbeddingConfig): ResolvedEmbedding;
  available(config: EmbeddingConfig): Promise<EmbeddingAvailability>;
  load(
    config: EmbeddingConfig,
    options?: { onProgress?: (event: EmbeddingLoadProgress) => void },
  ): Promise<EmbedderLike>;
}

/** Passos do cálculo em que o gancho de teste é chamado (os testes de morte súbita matam o processo neles). */
export const EMBED_STEPS = ['round-embedded', 'round-appended'] as const;
export type EmbedStep = (typeof EMBED_STEPS)[number];

/** Progresso do cálculo dos embeddings que faltam. */
export type EmbedProgress =
  | { readonly phase: 'plan'; readonly chunks: number; readonly missing: number }
  | { readonly phase: 'load'; readonly model: string }
  | { readonly phase: 'download'; readonly file: string; readonly loaded: number; readonly total: number | null }
  | { readonly phase: 'embed'; readonly done: number; readonly total: number }
  | { readonly phase: 'done'; readonly computed: number; readonly total: number };
