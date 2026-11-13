// Estado dos embeddings que é só DESTA máquina: `.cabecao/embeddings.json`, fora do git.
//
// `cabecao embeddings off` desliga a busca por significado nesta máquina sem mexer no cérebro: o `embedding` do
// `.cabecao.json` e os vetores da branch de índice ficam onde estão (as outras máquinas continuam usando e
// calculando). Desligada aqui, esta máquina: não carrega o modelo, não calcula vetores no sync, e o `search` em modo
// `auto` usa só a palavra-chave. O sync continua levando e trazendo a branch de índice e regenerando o grafo
// exportado, para que nada que outra máquina calculou se perca. `cabecao embeddings on` religa.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/index.ts';

export const LOCAL_EMBEDDINGS_FILE = 'embeddings.json';

export interface LocalEmbeddingState {
  /** A busca por significado está desligada nesta máquina (`cabecao embeddings off`). */
  readonly disabled: boolean;
  /** Quando foi desligada (ISO 8601). */
  readonly disabledAt: string | null;
}

export function localEmbeddingsPath(root: string): string {
  return join(root, '.cabecao', LOCAL_EMBEDDINGS_FILE);
}

/** Estado local; arquivo ausente ou ilegível vale como "ligada". */
export async function readLocalEmbeddingState(root: string): Promise<LocalEmbeddingState> {
  try {
    const value: unknown = JSON.parse(await readFile(localEmbeddingsPath(root), 'utf8'));
    if (typeof value === 'object' && value !== null && (value as { disabled?: unknown }).disabled === true) {
      const at = (value as { disabledAt?: unknown }).disabledAt;
      return { disabled: true, disabledAt: typeof at === 'string' ? at : null };
    }
  } catch {
    // ausente ou ilegível: ligada
  }
  return { disabled: false, disabledAt: null };
}

/** Desliga (`true`) ou religa (`false`) a busca por significado nesta máquina. */
export async function setLocalEmbeddingsDisabled(root: string, disabled: boolean, now = new Date()): Promise<void> {
  const path = localEmbeddingsPath(root);
  if (!disabled) {
    await rm(path, { force: true });
    return;
  }
  await writeFileAtomic(path, `${JSON.stringify({ disabled: true, disabledAt: now.toISOString() }, null, 2)}\n`);
}
