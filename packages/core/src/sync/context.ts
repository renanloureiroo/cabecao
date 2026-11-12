// Contexto de uma execução do sync: cérebro, máquina, relógio e os ganchos.
import { type CommitAction, formatCommitMessage } from '../git/index.ts';
import { ulid } from '../util/index.ts';
import type { BrainConfig } from '../vault/index.ts';
import type { CatalogCache, CatalogInput } from './catalog.ts';
import type { SyncLayout } from './layout.ts';
import type { SyncStep } from './types.ts';

export interface SyncContext extends CatalogInput {
  readonly config: BrainConfig;
  readonly layout: SyncLayout;
  readonly machine: string;
  readonly client: string;
  readonly session: string | undefined;
  readonly now: () => Date;
  readonly cache: CatalogCache;
  readonly fault: (step: SyncStep) => Promise<void>;
}

export interface MessageInput {
  readonly action: CommitAction;
  readonly body: readonly string[];
  readonly numFiles?: number;
  /** Padrão: o cliente que pediu o sync. Edições feitas fora do Cabeção usam `manual`, sem sessão. */
  readonly client?: string;
}

/** Mensagem de commit no padrão do doc 12, com o modelo de assunto do `.cabecao.json`. */
export function commitMessage(ctx: SyncContext, input: MessageInput): string {
  const manual = input.client === 'manual';
  const session = manual ? undefined : ctx.session;
  return formatCommitMessage({
    ...(ctx.config.commit?.message === undefined ? {} : { subjectTemplate: ctx.config.commit.message }),
    ...(ctx.config.commit?.dateFormat === undefined ? {} : { dateFormat: ctx.config.commit.dateFormat }),
    date: ctx.now(),
    body: input.body,
    action: input.action,
    numFiles: input.numFiles ?? 0,
    trailers: {
      op: ulid(),
      machine: ctx.machine,
      client: input.client ?? ctx.client,
      ...(session === undefined ? {} : { session }),
    },
  });
}
