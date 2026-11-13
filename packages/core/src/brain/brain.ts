// `openBrain`: o ponto de entrada da camada de operações, usado pelo servidor MCP e pela CLI.
import { realpath } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LocalIndex, ScanSummary } from '../db/index.ts';
import { openIndex } from '../db/index.ts';
import type { EmbeddingProvider, EmbedStep } from '../embeddings/index.ts';
import { EmbeddingEngine } from '../embeddings/index.ts';
import type { SyncStep } from '../sync/index.ts';
import type { BrainConfig, EmbeddingConfig } from '../vault/index.ts';
import { readBrainConfig } from '../vault/index.ts';
import type { Actor, BrainContext, WriteStep } from './context.ts';
import { assertOpen, machineName } from './context.ts';
import type {
  CompactInput,
  CompactOutput,
  ComputeEmbeddingsInput,
  ComputeEmbeddingsOutput,
  EmbeddingsStatusOutput,
  EvaluateInput,
  EvaluateOutput,
  SetEmbeddingOutput,
  SwitchEmbeddingsOutput,
} from './embeddings.ts';
import {
  compactBrainIndex,
  computeEmbeddings,
  embeddingsStatus,
  evaluateSearch,
  indexSize,
  reindex,
  setEmbedding,
  switchEmbeddings,
} from './embeddings.ts';
import { BrainError, toBrainError } from './errors.ts';
import type { FactsInput, FactsOutput, GraphInput, GraphOutput } from './graph.ts';
import { facts, graph } from './graph.ts';
import type { HandoffSaveInput, HandoffSaveOutput } from './handoff.ts';
import { handoffSave } from './handoff.ts';
import { Mutex } from './mutex.ts';
import type {
  ReadInput,
  ReadOutput,
  RecallInput,
  RecallOutput,
  SearchInput,
  SearchOutput,
  StatusOutput,
} from './read.ts';
import { read, recall, search, status } from './read.ts';
import type { RelateInput, RelateOutput } from './relate.ts';
import { relate } from './relate.ts';
import type { RememberOutput } from './remember.ts';
import { rememberWithDedup } from './remember.ts';
import type { SyncInput, SyncOutput } from './sync.ts';
import { sync } from './sync.ts';
import type { ListOperationsInput, ListOperationsOutput, UndoInput, UndoOutput } from './undo.ts';
import { listOperations, undo } from './undo.ts';
import type { PatchPageInput, RememberInput, WriteOutput, WritePageInput } from './write.ts';
import { patchPage, writePage } from './write.ts';

/** Nome de cliente aceito: vai para `origin: agent:<cliente>` e para o rodapé `Cabecao-Client`. */
const CLIENT_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

export interface OpenBrainOptions {
  /** Quem está usando: `claude-code`, `claude-desktop`, `codex`, `cli`... */
  readonly client: string;
  /**
   * Quem escreve. `human` grava `origin: human` e `trust: high` e pode criar regras; `agent` grava
   * `origin: agent:<client>` e `trust: medium`. Padrão: `human` só quando `client` é `cli`. O servidor MCP deve
   * passar `agent` explicitamente, para que um cliente que se apresente como "cli" não vire humano.
   */
  readonly actor?: Actor;
  /** Nome da máquina nos rodapés. Padrão: o da configuração da máquina (`cabecao init`), senão o hostname. */
  readonly machine?: string;
  /** Relógio (datas das notas, do assunto dos commits e da validade). Padrão: agora. */
  readonly now?: Date | (() => Date);
  /** Gancho de teste: chamado em cada passo da escrita depois da gravação; pode lançar para simular falha. */
  readonly faultAt?: (step: WriteStep) => void | Promise<void>;
  /**
   * Runtime de embeddings (marco 2). O núcleo não importa `packages/embeddings`: a CLI e o servidor MCP injetam o
   * carregador, e os testes injetam um com o embedder falso. Sem ele, a busca é só por palavra-chave e o sync leva a
   * branch de índice sem calcular nada. Nada é carregado na abertura: o modelo carrega na primeira busca (ou no
   * primeiro cálculo) que precisa dele.
   */
  readonly embeddings?: EmbeddingProvider;
  /** Trechos por rodada do cálculo de embeddings (um segmento por rodada). Para testes. */
  readonly embedRoundSize?: number;
  /** Gancho de teste do cálculo de embeddings. */
  readonly embeddingsFaultAt?: (step: EmbedStep) => void | Promise<void>;
  /** Gancho de teste do sync (`SyncOptions.faultAt`). */
  readonly syncFaultAt?: (step: SyncStep) => void | Promise<void>;
}

/** Um cérebro aberto. Todas as entradas e saídas são JSON; os campos que vão para as tools são `snake_case`. */
export interface Brain {
  /** Raiz do cérebro (caminho real, sem links simbólicos). */
  readonly root: string;
  readonly client: string;
  readonly actor: Actor;
  /** Configuração lida do `.cabecao.json` (relida a cada escrita). */
  readonly config: BrainConfig;

  /** Briefing de início de tarefa: regras, handoff, preferências, armadilhas, memórias e um `session_handle` novo. */
  recall(input: RecallInput): Promise<RecallOutput>;
  /**
   * Busca, com validade e proveniência em cada resultado. `mode` (padrão `auto`): híbrida quando há embeddings
   * ativados e o runtime está disponível; senão, palavra-chave. A saída diz o modo usado e por quê.
   */
  search(input: SearchInput): Promise<SearchOutput>;
  /** Uma nota (ou uma seção dela), com frontmatter, links de saída e backlinks. */
  read(input: ReadInput): Promise<ReadOutput>;
  /** Saúde, contagens, sync, conflitos, links quebrados e versões do esquema. */
  status(): Promise<StatusOutput>;
  /** Vizinhos de uma nota no grafo (1 ou 2 saltos), com tipo, direção e validade de cada relação numa data. */
  graph(input: GraphInput): Promise<GraphOutput>;
  /** Fatos por sujeito, predicado e objeto, e se valem numa data, com a cadeia de versões. */
  facts(input?: FactsInput): Promise<FactsOutput>;

  /**
   * Grava uma memória, tratando duplicatas e contradições no mesmo escopo e tipo: igual → ignora; complementa →
   * atualiza; contradiz → substitui; nova → cria; ambíguo → devolve as candidatas (`resolution` na segunda chamada).
   * Regras só com `actor: 'human'`.
   */
  remember(input: RememberInput): Promise<RememberOutput>;
  /** Cria, sobrescreve ou acrescenta a uma página por caminho. */
  writePage(input: WritePageInput): Promise<WriteOutput>;
  /** Substituição exata e única no corpo de uma nota. */
  patchPage(input: PatchPageInput): Promise<WriteOutput>;
  /** Acrescenta uma relação tipada no frontmatter de uma nota (idempotente). */
  relate(input: RelateInput): Promise<RelateOutput>;
  /** Passagem de bastão: o handoff (com validade) e, se a sessão fez algo, o episódio, num commit. */
  handoffSave(input: HandoffSaveInput): Promise<HandoffSaveOutput>;

  /** Sincroniza com o remoto neste processo e reindexa o que mudou. */
  sync(input?: SyncInput): Promise<SyncOutput>;
  /** Desfaz a última operação, uma operação (`op`) ou uma sessão (`session`), com um commit de revert. */
  undo(input?: UndoInput): Promise<UndoOutput>;
  /** Operações do Cabeção, da mais nova para a mais antiga, com o que já foi desfeito. */
  listOperations(input?: ListOperationsInput): Promise<ListOperationsOutput>;

  /** Estado da busca por significado (modelo, runtime, trechos com e sem vetor), sem carregar o modelo. */
  embeddingsStatus(): Promise<EmbeddingsStatusOutput>;
  /** Tamanho da branch de índice na geração corrente; `null` se ela não existe. */
  indexSize(): Promise<{ bytes: number; commit: string } | null>;
  /** Calcula os embeddings que faltam. Só o usuário (CLI). */
  computeEmbeddings(input?: ComputeEmbeddingsInput): Promise<ComputeEmbeddingsOutput>;
  /** Grava (ou remove) o modelo no `.cabecao.json`, num commit. Só o usuário (CLI). */
  setEmbedding(embedding: EmbeddingConfig | null): Promise<SetEmbeddingOutput>;
  /** Troca de modelo: calcula tudo numa pasta nova e só então muda o `.cabecao.json`. Só o usuário (CLI). */
  switchEmbeddings(next: EmbeddingConfig, input?: ComputeEmbeddingsInput): Promise<SwitchEmbeddingsOutput>;
  /** Compacta a branch de índice numa geração nova. Só o usuário (CLI). */
  compactIndex(input?: CompactInput): Promise<CompactOutput | null>;
  /** Reconstrói o banco local (incremental, ou do zero com `full`). */
  reindex(input?: { readonly full?: boolean }): Promise<ScanSummary>;
  /** Mede a busca com as perguntas do usuário (`cabecao eval`). */
  evaluateSearch(input: EvaluateInput): Promise<EvaluateOutput>;

  /** Espera as operações em andamento e fecha o banco. Chame antes de apagar ou mover a pasta (Windows). */
  close(): Promise<void>;
}

/** SQLite ocupado por outra conexão (`SQLITE_BUSY` ou `SQLITE_LOCKED`). */
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return code === 5 || code === 6 || (error instanceof Error && /database is (?:locked|busy)/i.test(error.message));
}

/** Quanto a abertura insiste quando outro processo está criando o mesmo banco. */
const OPEN_RETRY_MS = 15_000;

/**
 * `openIndex` com novas tentativas. Contorna um defeito de `db/open.ts`: quando dois processos abrem um banco que
 * ainda não existe, a troca para WAL (`pragma journal_mode = WAL`) de um deles falha na hora com "database is
 * locked", sem passar pelo `busy_timeout`. Na segunda tentativa o banco já existe e a abertura segue normal.
 */
async function openIndexRetrying(root: string): Promise<LocalIndex> {
  const deadline = Date.now() + OPEN_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await openIndex(root);
    } catch (error) {
      if (isBusy(error) && Date.now() < deadline) {
        await sleep(Math.min(200, 10 + attempt * 10) * (0.5 + Math.random()));
        continue;
      }
      if (isBusy(error)) {
        throw new BrainError('locked', `o banco local de ${root} está ocupado por outro processo`, {
          nextStep: 'Tente de novo em alguns segundos.',
          cause: error,
        });
      }
      throw new BrainError('index_failed', `não consegui abrir o banco local em ${root}/.cabecao: ${String(error)}`, {
        nextStep: 'Rode "cabecao doctor"; apagar a pasta .cabecao/ é seguro (o banco é refeito a partir das notas).',
        cause: error,
      });
    }
  }
}

/**
 * Abre o cérebro em `root`. Só lê o `.cabecao.json` e abre (ou cria) o banco local em `.cabecao/`: nenhuma nota é
 * lida, nenhum arquivo do cérebro é alterado e nenhum commit é feito. A varredura incremental roda na primeira
 * operação que precisa do banco.
 *
 * Lança `BrainError`: `not_a_brain` (pasta sem `.cabecao.json` ou inexistente), `invalid_config` ou
 * `invalid_argument` (nome de cliente inválido).
 */
export async function openBrain(root: string, options: OpenBrainOptions): Promise<Brain> {
  const client = options?.client;
  if (typeof client !== 'string' || !CLIENT_RE.test(client)) {
    throw new BrainError(
      'invalid_argument',
      `nome de cliente inválido (${JSON.stringify(client)}): use letras, dígitos, ".", "_" e "-", como "claude-code"`,
    );
  }
  if (options.actor !== undefined && options.actor !== 'human' && options.actor !== 'agent') {
    throw new BrainError('invalid_argument', '"actor" deveria ser "human" ou "agent"');
  }
  let real: string;
  try {
    real = await realpath(root);
  } catch {
    throw new BrainError('not_a_brain', `a pasta ${root} não existe`, {
      nextStep: 'Confira o caminho do cérebro ou rode "cabecao init".',
    });
  }
  let config: BrainConfig;
  try {
    config = await readBrainConfig(real);
  } catch (error) {
    throw toBrainError(error);
  }
  const index = await openIndexRetrying(real);
  const now = options.now;
  const ctx: BrainContext = {
    root: real,
    config,
    client,
    actor: options.actor ?? (client === 'cli' ? 'human' : 'agent'),
    now: now === undefined ? () => new Date() : typeof now === 'function' ? now : () => new Date(now.getTime()),
    index,
    machineOption: options.machine,
    machine: null,
    dbMutex: new Mutex(),
    writeMutex: new Mutex(),
    lastScanStartedAt: Number.NEGATIVE_INFINITY,
    closed: false,
    faultAt: options.faultAt,
    engine: new EmbeddingEngine({
      root: real,
      provider: options.embeddings,
      ...(options.embedRoundSize === undefined ? {} : { roundSize: options.embedRoundSize }),
      faultAt: options.embeddingsFaultAt,
    }),
    syncFaultAt: options.syncFaultAt,
  };

  return {
    root: real,
    client,
    actor: ctx.actor,
    get config() {
      return ctx.config;
    },
    recall: (input) => recall(ctx, input),
    search: (input) => search(ctx, input),
    read: (input) => read(ctx, input),
    graph: (input) => graph(ctx, input),
    facts: (input) => facts(ctx, input),
    status: async () => {
      assertOpen(ctx);
      return status(ctx, await machineName(ctx));
    },
    remember: (input) => rememberWithDedup(ctx, input),
    writePage: (input) => writePage(ctx, input),
    patchPage: (input) => patchPage(ctx, input),
    relate: (input) => relate(ctx, input),
    handoffSave: (input) => handoffSave(ctx, input),
    sync: (input) => sync(ctx, input),
    undo: (input) => undo(ctx, input),
    listOperations: async (input) => {
      assertOpen(ctx);
      return listOperations(ctx, input);
    },
    embeddingsStatus: () => embeddingsStatus(ctx),
    indexSize: () => indexSize(ctx),
    computeEmbeddings: (input) => computeEmbeddings(ctx, input),
    setEmbedding: (embedding) => setEmbedding(ctx, embedding),
    switchEmbeddings: (next, input) => switchEmbeddings(ctx, next, input),
    compactIndex: (input) => compactBrainIndex(ctx, input),
    reindex: (input) => reindex(ctx, input),
    evaluateSearch: (input) => evaluateSearch(ctx, input),
    close: async () => {
      if (ctx.closed) return;
      await ctx.writeMutex.run(() =>
        ctx.dbMutex.run(() => {
          ctx.closed = true;
          index.close();
        }),
      );
      await ctx.engine.dispose();
    },
  };
}
