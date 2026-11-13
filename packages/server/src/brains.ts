// O cérebro aberto, compartilhado pelo processo. Fica fora da fábrica de servidores (`buildServer`): a fábrica roda
// a cada conexão (stdio) ou a cada requisição (HTTP) e não pode guardar estado nem abrir nada.
//
// Abertura preguiçosa: subir o processo, responder `initialize`/`server/discover` e `tools/list` não abre o banco,
// não cria arquivo e não toca no git (alguns clientes sobem o processo duas vezes só para sondar). O cérebro abre na
// primeira chamada de tool que precisa dele e é reaproveitado nas seguintes.
import type { Brain, EmbeddingProvider } from '@cabecao/core';
import { BrainError, openBrain } from '@cabecao/core';

export interface BrainProviderOptions {
  /** Pasta do cérebro. */
  readonly root: string;
  readonly machine?: string;
  /** Relógio (testes). */
  readonly now?: Date | (() => Date);
  /**
   * Runtime de embeddings injetado pela CLI (marco 2). Abrir o cérebro não carrega o modelo: ele carrega na primeira
   * busca que precisa dele, nunca na subida do servidor.
   */
  readonly embeddings?: EmbeddingProvider;
}

export interface BrainProvider {
  /**
   * O cérebro aberto para o cliente `client` (já saneado). Um por nome de cliente, porque o nome vai nos commits;
   * na prática um processo stdio atende um cliente só. Uma abertura que falha (pasta que não é cérebro) não fica
   * guardada: depois de um `cabecao init`, a próxima chamada abre.
   */
  get(client: string): Promise<Brain>;
  /** Espera as operações em andamento e fecha todos os bancos. Depois disso, `get` recusa. */
  close(): Promise<void>;
}

export function createBrainProvider(options: BrainProviderOptions): BrainProvider {
  const opened = new Map<string, Promise<Brain>>();
  let closed = false;
  return {
    get(client) {
      if (closed) {
        return Promise.reject(new BrainError('closed', 'o servidor do Cabeção está encerrando'));
      }
      let brain = opened.get(client);
      if (brain === undefined) {
        brain = openBrain(options.root, {
          client,
          // nenhum cliente MCP escreve como o usuário: `type: rule` é recusado e `trust: high` é rebaixado
          actor: 'agent',
          ...(options.machine === undefined ? {} : { machine: options.machine }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
        });
        const pending = brain;
        opened.set(client, pending);
        pending.catch(() => {
          if (opened.get(client) === pending) opened.delete(client);
        });
      }
      return brain;
    },
    async close() {
      closed = true;
      const all = [...opened.values()];
      opened.clear();
      await Promise.allSettled(all.map(async (pending) => (await pending).close()));
    },
  };
}
