// O cérebro aberto, compartilhado pelo processo. Fica fora da fábrica de servidores (`buildServer`): a fábrica roda
// a cada conexão (stdio) ou a cada requisição (HTTP) e não pode guardar estado nem abrir nada.
//
// Abertura preguiçosa: subir o processo, responder `initialize`/`server/discover` e `tools/list` não abre o banco,
// não cria arquivo e não toca no git (alguns clientes sobem o processo duas vezes só para sondar). O cérebro abre na
// primeira chamada de tool que precisa dele e é reaproveitado nas seguintes.
import type { Brain, EmbeddingProvider } from '@cabecao/core';
import { BrainError, openBrain } from '@cabecao/core';

/**
 * Modo sem ninguém olhando (`cabecao mcp --consolidation <id>`, que o `cabecao consolidate --run` usa): o servidor fica
 * preso a uma consolidação já iniciada pela CLI.
 */
export interface UnattendedOptions {
  /** O `consolidation_id`: vira o `session_handle` de TODA escrita, qualquer que seja o que o agente mandar. */
  readonly consolidationId: string;
  /** Libera o `forget` (arquivar memória sem ninguém olhando só com opção explícita do usuário). */
  readonly allowForget: boolean;
}

/** Métodos que gravam e recebem `session_handle`: no modo sem ninguém olhando, a sessão é a da consolidação. */
const SESSION_WRITES = new Set(['remember', 'writePage', 'patchPage', 'relate', 'forget']);

/** Bloqueados sem ninguém olhando: enviar ao remoto, desfazer, passar bastão, trazer conteúdo de fora. */
const UNATTENDED_BLOCKED: Readonly<Record<string, string>> = {
  sync: 'sync (enviar ao remoto fica para você, depois de conferir)',
  undo: 'undo (quem desfaz é você, com "cabecao undo")',
  handoffSave: 'handoff_save (uma consolidação não deixa recado para a próxima sessão)',
  ingest: 'ingest (uma consolidação não traz conteúdo de fora)',
};

function blocked(what: string): BrainError {
  return new BrainError('human_only', `numa consolidação automática (sem ninguém olhando) não há ${what}`, {
    nextStep:
      'Siga só com recall, search, read, graph, facts, lint, remember, write_page, patch_page e relate, e termine com consolidate finish.',
  });
}

/**
 * O cérebro com as travas do modo sem ninguém olhando. As restrições de agente do núcleo continuam todas (o cérebro é
 * aberto com `actor: 'agent'`); isto só tira o que não cabe numa consolidação sem supervisão e prende a sessão.
 */
export function unattendedBrain(brain: Brain, options: UnattendedOptions): Brain {
  const id = options.consolidationId;
  return new Proxy(brain, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof key !== 'string' || typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      const what = UNATTENDED_BLOCKED[key];
      if (what !== undefined) return () => Promise.reject(blocked(what));
      if (key === 'forget' && !options.allowForget) {
        return () =>
          Promise.reject(
            new BrainError(
              'human_only',
              'numa consolidação automática, forget fica bloqueado: arquivar memória sem ninguém olhando só com --allow-forget',
              {
                nextStep: 'Deixe a nota como está e cite-a no resumo final; o usuário decide se arquiva.',
              },
            ),
          );
      }
      if (key === 'consolidate') {
        return (input: unknown) => {
          const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
          if (record.action !== 'finish') {
            return Promise.reject(
              new BrainError(
                'human_only',
                `esta consolidação já começou (consolidation_id "${id}"): não chame start de novo`,
                {
                  nextStep: `Termine com consolidate({ action: "finish", consolidation_id: "${id}" }).`,
                },
              ),
            );
          }
          const given = typeof record.consolidation_id === 'string' ? record.consolidation_id.trim().toUpperCase() : '';
          if (given !== id) {
            return Promise.reject(
              new BrainError('invalid_argument', `o consolidation_id desta consolidação é "${id}"`, {
                nextStep: `Chame consolidate({ action: "finish", consolidation_id: "${id}" }).`,
              }),
            );
          }
          return method.call(target, input);
        };
      }
      if (SESSION_WRITES.has(key)) {
        return (input: unknown, ...rest: unknown[]) =>
          method.call(
            target,
            { ...(typeof input === 'object' && input !== null ? input : {}), session_handle: id },
            ...rest,
          );
      }
      return method.bind(target);
    },
  });
}

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
  /** Modo sem ninguém olhando, preso a uma consolidação (`cabecao consolidate --run`). */
  readonly unattended?: UnattendedOptions;
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
        const unattended = options.unattended;
        brain = openBrain(options.root, {
          client,
          // nenhum cliente MCP escreve como o usuário: `type: rule` é recusado e `trust: high` é rebaixado
          actor: 'agent',
          ...(options.machine === undefined ? {} : { machine: options.machine }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
        }).then((opened) => (unattended === undefined ? opened : unattendedBrain(opened, unattended)));
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
