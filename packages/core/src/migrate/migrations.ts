// Migrações do esquema do cérebro (`schemaVersion` do `.cabecao.json`; doc 03, "Versionamento do esquema").
//
// Uma migração é uma FUNÇÃO PURA sobre a árvore de arquivos do cérebro: recebe os arquivos de texto versionados e
// devolve o que muda (criar, alterar, apagar), sem tocar no disco nem no git. Quem aplica, commita (um commit por
// migração, ação `migrate`) e sobe o `schemaVersion` é o `upgradeBrain`, com um ponto de restauração antes.
//
// Regra de compatibilidade (vale para toda migração nova):
// - o Cabeção lê e grava cérebros de esquema ANTERIOR ao dele sem migrar: a migração tem de ser algo que o código
//   novo também entende do jeito antigo. `doctor` e `status` avisam da migração pendente; quem decide é o usuário,
//   com `cabecao upgrade`;
// - um cérebro de esquema MAIS NOVO é recusado (abrir, servidor MCP, CLI) com "atualize o Cabeção", e o sync de uma
//   máquina antiga não aplica nem envia nada quando o remoto já está num esquema mais novo (as mudanças dela ficam em
//   commits locais até a atualização);
// - mudança de esquema só em versão menor ou maior do pacote (doc 08, "Atualizar").

/** Arquivos de texto versionados do cérebro: caminho relativo (com `/`) → conteúdo em UTF-8. */
export type MigrationTree = ReadonlyMap<string, string>;

/** Uma mudança: `content` novo, ou `null` para apagar o arquivo. */
export interface MigrationChange {
  readonly path: string;
  readonly content: string | null;
}

export interface Migration {
  /** Esquema de partida. */
  readonly from: number;
  /** Esquema de chegada: sempre `from + 1`. */
  readonly to: number;
  /** Uma linha, em português: vai para a saída e para o commit (`migrate: <descrição>`). */
  readonly description: string;
  /** Função pura: a mesma árvore dá sempre as mesmas mudanças. Não precisa mexer no `schemaVersion`. */
  readonly migrate: (tree: MigrationTree) => readonly MigrationChange[];
}

/**
 * As migrações reais, em ordem. O esquema 1 é o primeiro: ainda não há nenhuma. A última `to` tem de ser igual a
 * `SUPPORTED_SCHEMA_VERSION` (um teste confere).
 */
export const MIGRATIONS: readonly Migration[] = [];
