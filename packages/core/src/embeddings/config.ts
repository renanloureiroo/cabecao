// Gravação do modelo de embeddings no `.cabecao.json`, num commit próprio. Só a CLI (o usuário) chega aqui: nenhuma
// tool do MCP muda o `embedding` (o `.cabecao.json` é arquivo de controle, recusado para agentes; ADR 36).
import { commitPaths, formatCommitMessage } from '../git/index.ts';
import { syncLayout } from '../sync/index.ts';
import { ulid, withLock } from '../util/index.ts';
import {
  BRAIN_CONFIG_FILE,
  type BrainConfig,
  type EmbeddingConfig,
  readBrainConfig,
  writeBrainConfig,
} from '../vault/index.ts';

export interface WriteEmbeddingConfigOptions {
  readonly machine: string;
  /** `cli` (o padrão). */
  readonly client?: string;
  readonly now?: () => Date;
}

export interface WriteEmbeddingConfigResult {
  /** Commit criado; `null` quando o arquivo já tinha exatamente este `embedding`. */
  readonly commit: string | null;
  readonly config: BrainConfig;
}

/** Descrição curta de um modelo para mensagens e commits: `multilingual-e5-small (q8, receita 1)`. */
export function describeEmbedding(embedding: Pick<EmbeddingConfig, 'model' | 'variant' | 'recipe'>): string {
  return `${embedding.model} (${embedding.variant}, receita ${embedding.recipe})`;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Grava (ou, com `null`, remove) o campo `embedding` do `.cabecao.json` e commita só esse arquivo, sob a trava da
 * pasta de trabalho (a mesma das escritas de notas e do sync). As demais chaves do arquivo ficam como estavam.
 */
export async function writeEmbeddingConfig(
  root: string,
  embedding: EmbeddingConfig | null,
  options: WriteEmbeddingConfigOptions,
): Promise<WriteEmbeddingConfigResult> {
  const now = options.now ?? (() => new Date());
  return withLock(
    syncLayout(root).worktreeLock,
    async () => {
      const current = await readBrainConfig(root);
      if (sameJson(current.embedding ?? null, embedding)) return { commit: null, config: current };
      const { embedding: _drop, ...rest } = current;
      const next: BrainConfig = embedding === null ? rest : { ...rest, embedding };
      await writeBrainConfig(root, next);
      const line =
        embedding === null
          ? 'update: busca por significado sem modelo (embedding removido do .cabecao.json)'
          : `update: modelo de embeddings ${describeEmbedding(embedding)}${
              typeof embedding.revision === 'string' ? `, revisão ${embedding.revision}` : ''
            }`;
      const message = formatCommitMessage({
        ...(current.commit?.message === undefined ? {} : { subjectTemplate: current.commit.message }),
        ...(current.commit?.dateFormat === undefined ? {} : { dateFormat: current.commit.dateFormat }),
        date: now(),
        action: 'update',
        numFiles: 1,
        body: [line],
        trailers: { op: ulid(), machine: options.machine, client: options.client ?? 'cli' },
      });
      const commit = await commitPaths(root, [BRAIN_CONFIG_FILE], message);
      return { commit, config: await readBrainConfig(root) };
    },
    { timeoutMs: 30_000 },
  );
}
