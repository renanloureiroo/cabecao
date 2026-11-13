// Classificação de cada comando da CLI quanto a quem pode rodá-lo. É o ÚNICO lugar dela: o roteador recusa os comandos
// só do humano para um agente, a documentação ("Quem é humano e quem é agente na CLI") reproduz esta tabela, e um teste
// falha se um comando for registrado em `commands.ts` sem entrada aqui.
//
// - `memory`: lê ou escreve a memória. Roda para os dois; abre o cérebro com o ator resolvido (`actor.ts`), e para um
//   agente valem EXATAMENTE as regras da camada de operações (as mesmas do servidor MCP): o que é elevado (regra,
//   arquivo de controle, `raw/`, `trust: high`, undo de operação do usuário, arquivar) só com confirmação.
// - `admin`: administração da máquina que roda sem terminal por desenho (agendador, hooks, scripts, o servidor MCP).
//   Não escreve memória em nome de ninguém: o `sync` commita edições de fora como `manual`, como sempre.
// - `human`: só o usuário, num terminal interativo. Para um agente (ou sem terminal), recusado com explicação.
//
// Este módulo é avaliado pelo roteador em todo comando: só metadados aqui.

export type CommandAccess = 'memory' | 'admin' | 'human';

export interface AccessSpec {
  readonly access: CommandAccess;
  /** Por que esta classe, em português (vai para a documentação). */
  readonly why: string;
  /** Subcomandos (primeiro argumento) com classe própria: `embeddings status` só lê. */
  readonly subcommands?: Readonly<Record<string, CommandAccess>>;
}

export const COMMAND_ACCESS: Readonly<Record<string, AccessSpec>> = {
  // memória
  recall: { access: 'memory', why: 'lê o briefing; o --hook roda sem terminal no início de sessão' },
  search: { access: 'memory', why: 'só lê' },
  read: { access: 'memory', why: 'só lê (espelha a tool read)' },
  graph: { access: 'memory', why: 'só lê' },
  facts: { access: 'memory', why: 'só lê' },
  lint: { access: 'memory', why: 'só lê' },
  remember: { access: 'memory', why: 'grava memória (espelha a tool remember); regra só com confirmação' },
  write: { access: 'memory', why: 'grava nota (espelha write_page); regra, controle e raw/ só com confirmação' },
  patch: { access: 'memory', why: 'altera nota (espelha patch_page); regra, controle e raw/ só com confirmação' },
  relate: { access: 'memory', why: 'acrescenta relação (espelha relate)' },
  handoff: { access: 'memory', why: 'passagem de bastão (espelha handoff_save)' },
  ingest: { access: 'memory', why: 'registra fonte em raw/; agente só lê arquivo de dentro do cérebro' },
  forget: { access: 'memory', why: 'arquiva; agente só com o confirm_token, humano confirma no terminal' },
  consolidate: {
    access: 'memory',
    why: 'prepara e fecha consolidação; --run roda sem terminal (agendado), mas --allow-forget e --allow-elevated só o humano passa',
  },
  undo: { access: 'memory', why: 'desfaz; operação do usuário ou começo do id: agente só com confirmação' },
  // administração que roda sem terminal por desenho
  init: { access: 'admin', why: 'prepara a máquina; roda em scripts' },
  status: { access: 'admin', why: 'só lê o estado' },
  doctor: { access: 'admin', why: 'só diagnostica' },
  sync: {
    access: 'admin',
    why: 'roda pelo agendador e pelo hook de fim de sessão; edições de fora entram como manual',
  },
  schedule: { access: 'admin', why: 'registra o sync no agendador; roda em scripts' },
  mcp: { access: 'admin', why: 'é o servidor MCP que os clientes iniciam (ele mesmo sempre abre como agente)' },
  'install-client': { access: 'admin', why: 'registra o servidor nos clientes; roda em scripts' },
  eval: { access: 'admin', why: 'só mede a busca' },
  reindex: { access: 'admin', why: 'refaz o banco local, que é só uma visão das notas' },
  obsidian: {
    access: 'admin',
    why: 'configura o Obsidian (só acrescenta, com cópia do original); não grava nota nem regra; clipper só mostra',
  },
  export: { access: 'admin', why: 'gera um mapa (.canvas) a partir das notas; não grava memória' },
  // só do humano no terminal
  embeddings: {
    access: 'human',
    why: 'instala o runtime, baixa modelo e muda o .cabecao.json; status só lê',
    subcommands: { status: 'admin' },
  },
  compact: { access: 'human', why: 'reescreve a branch de índice numa geração nova e pode apagar no remoto' },
  upgrade: {
    access: 'human',
    why: 'migra o esquema do cérebro (commits e ponto de restauração) e troca AGENTS.md e CLAUDE.md pelo modelo',
  },
};

/**
 * A classe de `name` para estes argumentos (com o subcomando, quando ele tem classe própria). Sem entrada: `null` (o
 * teste `access.test.ts` garante que todo comando de `commands.ts` tem a sua).
 */
export function accessOf(name: string, positionals: readonly string[]): CommandAccess | null {
  const spec = COMMAND_ACCESS[name];
  if (spec === undefined) return null;
  const sub = positionals[0];
  return (sub === undefined ? undefined : spec.subcommands?.[sub]) ?? spec.access;
}
