// Tipos públicos do sync. O resultado é JSON puro: vai para a tool `sync` do MCP e para `cabecao sync --json`.
import type { GitErrorCategory } from '../git/index.ts';
import type { SecretRuleId } from '../security/index.ts';

/**
 * Passos em que o sync chama `faultAt`, na ordem em que acontecem num ciclo. Existem para os testes de morte
 * súbita: matar ou abortar o processo em qualquer um deles não pode perder nota nem travar o próximo sync.
 *
 * - `locked`: trava do sync adquirida.
 * - `recovered`: estado de uma execução interrompida já tratado.
 * - `committed`: edições feitas fora do Cabeção já estão num commit (ou não havia nenhuma).
 * - `fetched`: o remoto já foi consultado.
 * - `integrated`: o resultado da integração existe só no banco de objetos; nada na pasta de trabalho mudou.
 * - `journaled`: o diário de intenção da aplicação foi gravado; a pasta de trabalho ainda não mudou.
 * - `applied`: `git reset --keep` concluído; o diário ainda não foi apagado.
 * - `pushed`: o remoto aceitou o envio; a referência local do remoto ainda não foi atualizada.
 */
export const SYNC_STEPS = [
  'locked',
  'recovered',
  'committed',
  'fetched',
  'integrated',
  'journaled',
  'applied',
  'pushed',
] as const;
export type SyncStep = (typeof SYNC_STEPS)[number];

/**
 * - `ok`: terminou; com remoto, local e remoto ficaram iguais. Sem remoto, as mudanças estão em commits locais.
 * - `busy`: outro sync segurava a trava; nada foi feito.
 * - `blocked`: o sync se recusou a continuar (segredo, arquivo que não deu para escanear, arquivo local que seria
 *   sobrescrito, operação do git em andamento, HEAD solto). Nada foi enviado.
 * - `offline`: o remoto não respondeu, não existe ou recusou a credencial. O que era local foi feito.
 * - `error`: falha inesperada ou envio recusado repetidas vezes.
 */
export type SyncStatus = 'ok' | 'busy' | 'blocked' | 'offline' | 'error';

/** Como o conteúdo remoto entrou: não entrou, avanço simples, reaplicação linear dos commits locais, ou merge. */
export type SyncIntegration = 'none' | 'fast-forward' | 'replay' | 'merge';

/**
 * Motivo de um `blocked`.
 *
 * - `secrets`: o scanner achou um possível segredo no que seria commitado ou enviado.
 * - `unscannable`: um arquivo que seria commitado não pôde ser lido pelo scanner (permissão, arquivo travado).
 * - `local-file`: aplicar o remoto sobrescreveria um arquivo desta máquina que o sync não versiona (ignorado pelo
 *   `.gitignore` ou dentro de `.cabecao/`). Nada foi aplicado.
 * - `git-operation`: operação do git pela metade, deixada por outro programa.
 * - `detached-head`: HEAD fora de uma branch.
 */
export type SyncBlockReason = 'secrets' | 'unscannable' | 'local-file' | 'git-operation' | 'detached-head';

/**
 * Um arquivo (nota, anexo ou configuração) editado nas duas máquinas. Nada foi resolvido em silêncio: as duas
 * versões continuam no cérebro.
 */
export interface SyncConflict {
  /** Caminho do arquivo. Em `content`, fica com a versão do remoto; em `invalid`, com a desta máquina. */
  readonly path: string;
  /**
   * - `content`: editada nos dois lados; a versão local foi para `copy`.
   * - `delete`: editada de um lado e apagada do outro; a edição foi mantida em `path`.
   * - `invalid`: o remoto trouxe um `.cabecao.json` inválido (ou o apagou); ficou a versão desta máquina, e a do
   *   remoto foi para `copy` (`.cabecao.conflict-<máquina>-<data>.json`).
   */
  readonly kind: 'content' | 'delete' | 'invalid';
  /** Em `content`: a cópia com a versão local; em `invalid`: a cópia com a versão do remoto. */
  readonly copy?: string;
  /** Em `delete`: de que lado veio a edição mantida. */
  readonly kept?: 'remote' | 'local';
  /** Em `invalid`: por que a versão do remoto não vale. */
  readonly reason?: string;
}

/** Onde o scanner achou um possível segredo. O segredo em si nunca aparece aqui. */
export interface SecretLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly rule: SecretRuleId;
  readonly description: string;
  /** `pending`: arquivo alterado ainda sem commit. `outgoing`: conteúdo de um commit que seria enviado. */
  readonly where: 'pending' | 'outgoing';
}

/** Um arquivo que mudou no cérebro por causa do sync, para quem reindexa o banco local. */
export interface SyncChange {
  /** Caminho relativo ao cérebro, com `/`. */
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted';
  /** `local`: edição feita fora do Cabeção que o sync pôs num commit. `remote`: veio da integração. */
  readonly origin: 'local' | 'remote';
}

export interface SyncRemoteError {
  readonly category: GitErrorCategory;
  /** Últimas linhas do erro do git, sem credenciais. */
  readonly detail: string;
}

/**
 * A branch de índice (`cabecao/index`) no sync (marco 2). Presente quando quem chama pediu o índice
 * (`SyncOptions.index`) e o cérebro participa: tem `embedding` no `.cabecao.json` ou já tem branch de índice.
 */
export interface SyncIndexResult {
  /** O índice entrou neste sync. Sem `embedding` configurado e sem branch de índice, nenhuma é criada. */
  participating: boolean;
  /** Geração corrente da branch de índice depois do sync; `null` se não existe. */
  generation: number | null;
  /** Vetores do modelo em uso que chegaram do remoto neste sync. */
  received: number;
  /** Vetores calculados nesta máquina neste sync. */
  computed: number;
  /** Vetores enviados ao remoto (contados pelo manifesto da branch de índice). */
  pushed: number;
  /** Trechos que continuam sem vetor do modelo em uso; `null` sem modelo configurado. */
  pending: number | null;
  /** O grafo exportado (`graph/nodes.jsonl`, `graph/edges.jsonl`) mudou e foi gravado neste sync. */
  graphWritten: boolean;
  /** Por que nada foi calculado nesta máquina (sem runtime, desligado aqui, sem modelo); `null` quando calculou. */
  skipped: string | null;
  /** Falha no índice que não impediu o sync do conteúdo. */
  error: string | null;
}

/** O que o sync pede a quem cuida do índice, uma vez por ciclo. */
export interface SyncIndexHook {
  /** Logo antes de buscar a branch de índice do remoto (para contar o que chegou). */
  beforeFetch?(): Promise<void>;
  /**
   * Depois de integrar e aplicar o conteúdo (e reindexar o banco): junta a branch de índice com a do remoto, calcula
   * os vetores que faltam e grava o grafo exportado. Não envia nada: o envio é do sync, no mesmo `push --atomic`.
   */
  update(input: {
    readonly remote: string | null;
    readonly online: boolean;
    readonly contentCommit: string | null;
  }): Promise<Omit<SyncIndexResult, 'pushed' | 'generation'>>;
}

export interface SyncResult {
  status: SyncStatus;
  /** Commits do remoto integrados. */
  pulled: number;
  /** Commits enviados ao remoto. */
  pushed: number;
  /** Commits criados por este sync: edições de fora, merge, catálogo regenerado. */
  committed: number;
  conflicts: SyncConflict[];
  /** Todos os caminhos que mudaram (união de `SyncChange.path`), em ordem. */
  changedPaths: string[];
  /** Presente quando o scanner bloqueou o sync. */
  secrets?: SecretLocation[];
  /** Ciclos fetch → integra → envia; passa de 1 quando o envio foi recusado ou um arquivo mudou no meio. */
  attempts: number;
  ms: number;
  /** Resumo em português para mostrar ao usuário ou ao agente. */
  message: string;
  /** Branch local; `null` com HEAD solto. */
  branch: string | null;
  /** Nome do remoto usado; `null` sem remoto configurado. */
  remote: string | null;
  integration: SyncIntegration;
  reason?: SyncBlockReason;
  remoteError?: SyncRemoteError;
  /** O que a recuperação de uma execução interrompida fez, se fez algo. */
  recovered?: string[];
  /**
   * Presente quando o `.cabecao.json` da pasta de trabalho está inválido: o motivo e com que configuração o sync
   * rodou (a última válida do histórico, ou a padrão). O sync roda mesmo assim, para poder receber a correção.
   */
  configProblem?: string;
  /** A branch de índice neste sync; ausente quando quem chamou não pediu o índice. */
  index?: SyncIndexResult;
}

export interface SyncOptions {
  /** Nome da máquina, para cópias de conflito e rodapés. Padrão: a configuração da máquina, senão o hostname. */
  machine?: string | undefined;
  /** Valor de `Cabecao-Client` nos commits de integração. Padrão: `cli`. Edições de fora usam `manual`. */
  client?: string | undefined;
  /** Sessão do agente que pediu o sync, para o rodapé `Cabecao-Session`. */
  session?: string | undefined;
  /** Remoto a usar. Padrão: o da branch atual, senão `origin`. */
  remote?: string | undefined;
  /** Ciclos antes de desistir quando o remoto muda no meio. Padrão: 5. */
  maxAttempts?: number | undefined;
  /** Espera pela trava do sync antes de responder `busy`. Padrão: 250 ms. */
  lockTimeoutMs?: number | undefined;
  /** Tempo limite de cada comando que fala com o remoto. Padrão: 30 s. */
  networkTimeoutMs?: number | undefined;
  /** Idade a partir da qual um `*.lock` do git é considerado abandonado. Padrão: 30 s. */
  staleGitLockMs?: number | undefined;
  /**
   * Chamado quando arquivos do cérebro mudaram, antes do envio: é onde quem chama reindexa o banco local. Pode
   * ser chamado mais de uma vez num sync (um por ciclo que mudou algo).
   */
  onApplied?: ((changes: readonly SyncChange[]) => void | Promise<void>) | undefined;
  /**
   * Leva a branch de índice junto: busca as duas branches, chama `update` depois de aplicar o conteúdo e envia
   * conteúdo e índice num único `git push --atomic` (decisão 15).
   */
  index?: SyncIndexHook | undefined;
  /** Gancho de teste: chamado em cada passo; pode lançar (abortar) ou matar o processo. */
  faultAt?: ((step: SyncStep) => void | Promise<void>) | undefined;
  /** Relógio, para nomes de conflito e datas de commit. Padrão: `new Date()`. */
  now?: (() => Date) | undefined;
}

/** Uma cópia de conflito presente no cérebro, para `status` e `doctor`. */
export interface ConflictCopy {
  /** Caminho da cópia (versão local na hora do conflito). */
  readonly copy: string;
  /** Caminho da nota original. */
  readonly original: string;
  readonly originalExists: boolean;
  readonly machine: string;
  /** Data e hora da cópia, `AAAA-MM-DDTHH:mm:ss` no fuso da máquina que a criou. */
  readonly date: string;
}

export interface SyncStatusInfo {
  branch: string | null;
  /** Remoto configurado, com a URL sem credenciais; `null` em cérebro só local. */
  remote: { name: string; url: string; branch: string } | null;
  /** Commits locais ainda não enviados, pela última informação que se tem do remoto; `null` sem essa informação. */
  unpushed: number | null;
  /** Commits do remoto já buscados e ainda não integrados; `null` sem essa informação. */
  unpulled: number | null;
  /**
   * Arquivos alterados que o próximo sync vai pôr num commit: tudo o que o git lista como mudado (respeitando o
   * `.gitignore`), menos `.cabecao/` e os temporários da escrita atômica. Mesmo critério do sync.
   */
  pendingChanges: number;
  conflicts: number;
  lastSync: { at: string; status: SyncStatus; message: string } | null;
  /** Um sync segura a trava agora. */
  running: boolean;
}
