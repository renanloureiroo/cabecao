// Conferência em tempo de compilação: os esquemas de saída (`schemas.ts`) cobrem exatamente o que o núcleo devolve.
// Só tipos; nada daqui existe em tempo de execução.
//
// Duas falhas possíveis, as duas pegas pelo `pnpm typecheck`:
// - o núcleo devolve um valor que o esquema não aceita (tipo diferente, campo obrigatório que sumiu);
// - o núcleo ganhou um campo que o esquema não declara. Como o JSON Schema publicado tem
//   `additionalProperties: false`, um cliente que valida a saída recusaria o resultado.
import type {
  FactsOutput,
  ForgetOutput,
  GraphOutput,
  HandoffSaveOutput,
  IngestOutput,
  LintOutput,
  ReadOutput,
  RecallOutput,
  RelateOutput,
  RememberOutput,
  SearchOutput,
  StatusOutput,
  SyncOutput,
  UndoOutput,
  WriteOutput,
} from '@cabecao/core';
import type * as z from 'zod';
import type {
  readOutput,
  recallOutput,
  searchOutput,
  statusOutput,
  syncOutput,
  undoOutput,
  writeOutput,
} from './schemas.ts';
import type { factsOutput, graphOutput, relateOutput } from './schemas-graph.ts';
import type { forgetOutput, handoffSaveOutput, ingestOutput, lintOutput, rememberOutput } from './schemas-lifecycle.ts';

/** Tira o `readonly` em profundidade (o Zod infere listas e objetos mutáveis). */
type Writable<T> = T extends readonly (infer U)[]
  ? Writable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Writable<T[K]> }
    : T;

/** Chaves do núcleo que o esquema não declara, em qualquer profundidade. */
type MissingKeys<C, S> = C extends readonly (infer U)[]
  ? S extends readonly (infer V)[]
    ? MissingKeys<U, V>
    : never
  : C extends object
    ? S extends object
      ? Exclude<keyof C, keyof S> | { [K in keyof C & keyof S]-?: MissingKeys<C[K], S[K]> }[keyof C & keyof S]
      : never
    : never;

type Covers<Core, Schema extends z.ZodType> = [Writable<Core>] extends [z.output<Schema>]
  ? [MissingKeys<Core, z.output<Schema>>] extends [never]
    ? true
    : { missing: MissingKeys<Core, z.output<Schema>> }
  : { notAssignable: Core };

type Expect<T extends true> = T;

/**
 * `SyncOutput.reason` é tipado no núcleo como `SyncResult['reason'] | null`, que inclui `undefined` porque
 * `SyncResult.reason` é opcional; em tempo de execução `toSyncOutput` sempre grava `null` no lugar
 * (packages/core/src/brain/sync.ts). O esquema publica `null`, que é o que de fato sai.
 */
type SyncOutputAsEmitted = {
  readonly [K in keyof SyncOutput]: K extends 'reason' ? Exclude<SyncOutput[K], undefined> : SyncOutput[K];
};

export type OutputSchemasCoverCore = [
  Expect<Covers<RecallOutput, typeof recallOutput>>,
  Expect<Covers<SearchOutput, typeof searchOutput>>,
  Expect<Covers<ReadOutput, typeof readOutput>>,
  Expect<Covers<StatusOutput, typeof statusOutput>>,
  Expect<Covers<WriteOutput, typeof writeOutput>>,
  Expect<Covers<SyncOutputAsEmitted, typeof syncOutput>>,
  Expect<Covers<UndoOutput, typeof undoOutput>>,
  Expect<Covers<GraphOutput, typeof graphOutput>>,
  Expect<Covers<FactsOutput, typeof factsOutput>>,
  Expect<Covers<RelateOutput, typeof relateOutput>>,
  Expect<Covers<RememberOutput, typeof rememberOutput>>,
  Expect<Covers<HandoffSaveOutput, typeof handoffSaveOutput>>,
  Expect<Covers<IngestOutput, typeof ingestOutput>>,
  Expect<Covers<LintOutput, typeof lintOutput>>,
  Expect<Covers<ForgetOutput, typeof forgetOutput>>,
];
