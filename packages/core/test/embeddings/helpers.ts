/**
 * Apoio dos testes do serviço de embeddings: um provedor com o embedder FALSO de `packages/embeddings` (sem rede, sem
 * runtime, determinístico), que conta as chamadas, e máquinas que são clones de um remoto bare. O isolamento do git
 * vem de `../brain/helpers.ts` (configuração global temporária).
 */
import { join } from 'node:path';
import { createFakeEmbedder } from '../../../embeddings/src/fake.ts';
import type { Brain, OpenBrainOptions } from '../../src/brain/index.ts';
import type { EmbedderLike, EmbeddingProvider, EmbedText } from '../../src/embeddings/index.ts';
import { resolveFromConfig } from '../../src/embeddings/index.ts';
import { runGit } from '../../src/git/index.ts';
import type { EmbeddingConfig } from '../../src/vault/index.ts';
import { git, openTest } from '../brain/helpers.ts';

/** Modelo do catálogo usado nos testes (o provedor falso aceita qualquer nome com dimensões). */
export const TEST_EMBEDDING: EmbeddingConfig = { model: 'multilingual-e5-small', variant: 'q8', dims: 384, recipe: 1 };

export interface FakeStats {
  /** Trechos (`passage`) embutidos. */
  passages: number;
  /** Perguntas (`query`) embutidas. */
  queries: number;
  loads: number;
  /** Textos de trechos embutidos, na ordem. */
  readonly texts: string[];
}

export interface FakeProviderOptions {
  /** Troca palavras antes do hash: simula um modelo que sabe que "broker" e "fila" são a mesma coisa. */
  readonly synonyms?: Readonly<Record<string, string>>;
  /** O runtime "não está instalado". */
  readonly unavailable?: boolean;
  /** A carga do modelo falha. */
  readonly failLoad?: boolean;
  /** O embed de perguntas lança (o runtime cai no meio de uma busca). */
  readonly failQueries?: () => boolean;
  /** O embed de trechos lança depois de N trechos (o runtime cai no meio do cálculo). */
  readonly failAfterPassages?: number;
}

function rewrite(input: EmbedText, synonyms: Readonly<Record<string, string>>): EmbedText {
  const swap = (text: string): string =>
    text.replace(/[\p{L}\p{N}]+/gu, (word) => synonyms[word.toLowerCase()] ?? word);
  return typeof input === 'string'
    ? swap(input)
    : { text: swap(input.text), ...(input.title == null ? {} : { title: swap(input.title) }) };
}

/** Provedor de embeddings para os testes: o embedder falso, com contadores e falhas programáveis. */
export function fakeProvider(options: FakeProviderOptions = {}): EmbeddingProvider & { readonly stats: FakeStats } {
  const stats: FakeStats = { passages: 0, queries: 0, loads: 0, texts: [] };
  return {
    stats,
    resolve: (config) => resolveFromConfig(config),
    async available() {
      return options.unavailable === true
        ? { ok: false, code: 'runtime_missing', reason: 'o runtime de embeddings não está instalado (teste)' }
        : { ok: true, backend: 'fake', modelCached: true };
    },
    async load(config): Promise<EmbedderLike> {
      stats.loads++;
      if (options.failLoad === true) throw new Error('o modelo não abriu (teste)');
      const inner = createFakeEmbedder(config.dims, { model: config.model });
      const synonyms = options.synonyms ?? {};
      return {
        model: config.model,
        dims: inner.dims,
        backend: 'fake',
        async embed(texts, kind) {
          if (kind === 'query') {
            if (options.failQueries?.() === true) throw new Error('o runtime caiu (teste)');
            stats.queries += texts.length;
          } else {
            if (options.failAfterPassages !== undefined && stats.passages + texts.length > options.failAfterPassages) {
              throw new Error('o runtime caiu no meio do cálculo (teste)');
            }
            stats.passages += texts.length;
            for (const text of texts) stats.texts.push(typeof text === 'string' ? text : text.text);
          }
          return inner.embed(
            texts.map((text) => rewrite(text, synonyms)),
            kind,
          );
        },
        dispose: () => inner.dispose(),
      };
    },
  };
}

/** Abre um cérebro de teste como o usuário (CLI), com o provedor falso. */
export function openHuman(
  dir: string,
  provider: EmbeddingProvider,
  extra: Partial<OpenBrainOptions> = {},
): Promise<Brain> {
  return openTest(dir, { client: 'cli', actor: 'human', embeddings: provider, ...extra });
}

/** Mesmo cérebro, como um agente (MCP). */
export function openAgent(
  dir: string,
  provider: EmbeddingProvider,
  extra: Partial<OpenBrainOptions> = {},
): Promise<Brain> {
  return openTest(dir, { client: 'claude-code', actor: 'agent', embeddings: provider, ...extra });
}

/** Um clone novo do remoto, como uma máquina nova que roda `init` com a URL (o clone traz todas as branches). */
export async function cloneMachine(remote: string, name: string): Promise<string> {
  const parent = join(remote, '..');
  const dir = join(parent, name);
  await runGit(['clone', '--quiet', remote, dir], { cwd: parent });
  await git(dir, ['config', 'user.name', 'Teste Cabeção']);
  await git(dir, ['config', 'user.email', 'teste@cabecao.invalid']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

/** Referências do remoto bare (`ref → sha`). */
export async function remoteRefs(remote: string): Promise<Map<string, string>> {
  const out = await git(remote, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref = '', sha = ''] = line.split(' ');
        return [ref, sha] as const;
      }),
  );
}

/** Caminhos e SHAs dos resultados de uma busca, para comparar máquinas. */
export function hitPaths(output: { hits: readonly { path: string }[] }): string[] {
  return output.hits.map((hit) => hit.path);
}
