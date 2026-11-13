import type { CommandSpec } from './types.ts';

/**
 * Registro de comandos. Para ligar um comando novo:
 *
 * 1. crie `commands/<nome>.ts` exportando `run(ctx: CommandContext): Promise<CommandResult>`;
 * 2. acrescente aqui uma entrada com `load: () => import('./commands/<nome>.ts')`.
 *
 * No comando: leia `ctx.values`/`ctx.positionals` (já validados), o processo só por `ctx` (`env`, `cwd`, `platform`,
 * `exec`, `stderr` para avisos), a pasta do cérebro por `resolveBrain(ctx)` de `brain.ts`. Devolva
 * `{ text, data, code }`: o roteador escreve `text` ou, com `--json`, `{ ok, command, data }`. Lance `UsageError`
 * (código 2) ou `CliError` (código 1, com `hint` e `code` estável) de `errors.ts`; qualquer outro erro sai sem stack.
 * O `mcp` (servidor de longa duração) também cabe aqui: o `run` só resolve quando o servidor encerra.
 *
 * Este arquivo é avaliado em todo início, inclusive em `--version`: aqui só entram metadados. O `import()`
 * dinâmico faz o bundler gerar um arquivo por comando, carregado só quando o comando roda.
 * `help`, `version`, `json` e `brain` (e as letras `-h` e `-v`) são opções globais e não podem ser redefinidas.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    summary: 'Instala ou conecta esta máquina a um cérebro',
    usage: ['init [url] [--dir <pasta>] [--machine <nome>] [--no-clients]'],
    options: {
      dir: { type: 'string', valueName: 'pasta', description: 'Pasta do cérebro (padrão: ~/cabecao)' },
      machine: { type: 'string', valueName: 'nome', description: 'Nome desta máquina (padrão: o do computador)' },
      'no-clients': { type: 'boolean', description: 'Não registra o servidor MCP nos clientes de IA' },
    },
    details: [
      'Sem perguntar mais nada:',
      '  1. clona o repositório para a pasta (ou cria a pasta, sem URL);',
      '  2. vê o que há nele: remoto vazio vira um cérebro novo, um cérebro existente é só baixado, um vault de',
      '     Obsidian ou Markdown é adotado sem mover nenhum arquivo, e qualquer outra coisa é recusada;',
      '  3. monta o índice local;',
      '  4. registra o servidor MCP nos clientes de IA encontrados (como "cabecao install-client --all");',
      '  5. roda o "cabecao doctor" e mostra o resultado.',
      '',
      'Funciona com qualquer remoto git (GitHub, GitLab, Bitbucket, Gitea, servidor próprio, pasta local) e usa as',
      'credenciais que o seu git já usa; nunca pede senha. Numa segunda máquina, rode o mesmo comando com a mesma URL.',
      'Sem URL, o cérebro fica só nesta máquina. Em caso de falha, nada fica para trás e o código de saída é 1.',
    ].join('\n'),
    load: () => import('./commands/init.ts'),
  },
  {
    name: 'status',
    summary: 'Notas, último sync, envios pendentes e conflitos',
    usage: ['status'],
    details:
      'Mostra notas por tipo, links quebrados, o último sync, commits ainda não enviados, mudanças feitas fora do\nCabeção esperando o sync e os conflitos pendentes. Sai com 0 mesmo quando há avisos.',
    load: () => import('./commands/status.ts'),
  },
  {
    name: 'doctor',
    summary: 'Diagnóstico com a correção sugerida para cada problema',
    usage: ['doctor [--offline]'],
    options: {
      offline: { type: 'boolean', description: 'Não consulta o remoto (nem a verificação de repositório público)' },
    },
    details: [
      'Verifica: Node.js e git; se a pasta é um cérebro e a versão do esquema; a configuração da máquina; a',
      'identidade do git; commit.gpgsign; o remoto (alcançável e com credencial que funciona sem terminal, com tempo',
      'limite curto) e, em HTTPS de provedor conhecido, se o repositório parece público; .gitignore e .gitattributes;',
      'o banco local; travas órfãs e operações interrompidas; conflitos pendentes; no Windows, o tamanho do caminho; e',
      'o registro do servidor MCP nos clientes de IA (só lê os arquivos, não executa nada).',
      '',
      'Cada item sai como ok, aviso ou falha, com a correção. O código de saída é 1 se houver alguma falha.',
    ].join('\n'),
    load: () => import('./commands/doctor.ts'),
  },
  {
    name: 'sync',
    summary: 'Sincroniza o cérebro com o remoto',
    usage: ['sync [--session <id>]'],
    options: {
      session: {
        type: 'string',
        valueName: 'id',
        description: 'Sessão do agente que pediu o sync (vai para os commits); usado pelo servidor MCP',
      },
    },
    details: [
      'Põe num commit o que foi editado fora do Cabeção (Obsidian, editor), recebe o que veio do remoto, integra sem',
      'descartar nada (a mesma nota editada nos dois lados gera uma cópia nota.conflict-<máquina>-<data>.md ao lado)',
      'e envia. Antes de enviar, procura segredos: se achar, bloqueia e mostra arquivo, linha e regra (nunca o valor).',
      '',
      'Código de saída: 0 quando terminou ou quando outro sync já estava rodando; 1 quando foi bloqueado, deu erro ou',
      'o remoto não respondeu (as mudanças ficam em commits locais e vão no próximo sync). Num cérebro sem remoto,',
      'sai com 0 e um aviso. Com --json, devolve a saída completa.',
    ].join('\n'),
    load: () => import('./commands/sync.ts'),
  },
  {
    name: 'search',
    summary: 'Busca no cérebro pelo terminal',
    usage: ['search "<pergunta>" [--type <tipo>...] [--scope <escopo>] [--limit <n>] [--as-of <data>]'],
    options: {
      type: {
        type: 'string',
        multiple: true,
        valueName: 'tipo',
        description: 'Só notas deste tipo (repita, ou separe por vírgula): decision, gotcha, fact...',
      },
      scope: {
        type: 'string',
        valueName: 'escopo',
        description: '"global" ou "project:<nome>" (que inclui também o global)',
      },
      limit: { type: 'string', valueName: 'n', description: 'Máximo de resultados, de 1 a 100 (padrão: 10)' },
      'as-of': {
        type: 'string',
        valueName: 'data',
        description: 'Data AAAA-MM-DD em que a validade é calculada (padrão: hoje)',
      },
    },
    details: [
      'Busca por palavra-chave. Cada resultado traz título, caminho, trecho e se a nota está vigente, vencida ou',
      'ainda não vigente na data (as que não valem aparecem mais abaixo, nunca escondidas). Para perguntas sobre o',
      'passado, use --as-of: a decisão que valia naquela data sobe. No fim, um bloco separado lista até 5 notas',
      'ligadas no grafo aos melhores resultados, com o motivo; ele não muda a ordem dos resultados.',
    ].join('\n'),
    load: () => import('./commands/search.ts'),
  },
  {
    name: 'graph',
    summary: 'Vizinhos de uma nota no grafo',
    usage: ['graph "<nota>" [--depth 1|2] [--type <tipo>...] [--as-of <data>]'],
    options: {
      depth: { type: 'string', valueName: 'n', description: 'Saltos: 1 (padrão) ou 2' },
      type: {
        type: 'string',
        multiple: true,
        valueName: 'tipo',
        description:
          'Só estas relações (repita, ou separe por vírgula): uses, part_of..., supersedes, wikilink, fact, mention',
      },
      'as-of': { type: 'string', valueName: 'data', description: 'Data AAAA-MM-DD da validade (padrão: hoje)' },
    },
    details: [
      'A nota pode ser o título, o caminho ou o id. Mostra as notas ligadas a ela: relações tipadas do frontmatter,',
      'wikilinks, fatos, encadeamento de versões (supersedes) e menções sem link, cada uma com a direção e se vale',
      'na data. Um nó muito ligado tem a resposta cortada, com o aviso.',
    ].join('\n'),
    load: () => import('./commands/graph.ts'),
  },
  {
    name: 'facts',
    summary: 'Fatos e se valem numa data',
    usage: ['facts [--subject <nota>] [--predicate <p>] [--object <nota>] [--as-of <data>] [--limit <n>]'],
    options: {
      subject: { type: 'string', valueName: 'nota', description: 'Sujeito: título, caminho ou id da nota' },
      predicate: { type: 'string', valueName: 'p', description: 'Predicado, como uses_queue ou led_by' },
      object: { type: 'string', valueName: 'nota', description: 'Objeto: título, caminho ou id (ou um valor)' },
      'as-of': { type: 'string', valueName: 'data', description: 'Data AAAA-MM-DD da validade (padrão: hoje)' },
      limit: { type: 'string', valueName: 'n', description: 'Máximo de fatos, de 1 a 200 (padrão: 50)' },
    },
    details: [
      'Lista as notas de fato (memory/facts/) que atendem aos filtros, com o período de validade, se valem na data',
      'e o encadeamento: que fato cada um substitui e por qual foi substituído. Os vencidos aparecem, por último.',
    ].join('\n'),
    load: () => import('./commands/facts.ts'),
  },
  {
    name: 'undo',
    summary: 'Desfaz a última operação, uma operação ou uma sessão',
    usage: ['undo', 'undo --op <id>', 'undo --session <id>', 'undo --list [--session <id>] [--limit <n>]'],
    options: {
      op: { type: 'string', valueName: 'id', description: 'Desfaz esta operação (o identificador ou o começo dele)' },
      session: { type: 'string', valueName: 'id', description: 'Desfaz tudo o que esta sessão de agente gravou' },
      list: { type: 'boolean', description: 'Mostra as operações que podem ser desfeitas' },
      limit: { type: 'string', valueName: 'n', description: 'Com --list: quantas mostrar (padrão: 20)' },
    },
    details: [
      'Desfaz com um commit de revert, sem reescrever o histórico. O undo também é uma operação: desfazê-lo refaz o',
      'que tinha sido desfeito. Rode "cabecao sync" depois para levar o undo às outras máquinas.',
    ].join('\n'),
    load: () => import('./commands/undo.ts'),
  },
  {
    name: 'mcp',
    summary: 'Servidor MCP por stdio (é o que os clientes de IA iniciam)',
    usage: ['mcp [--brain <pasta>]'],
    details: [
      'Não é para rodar à mão: o cliente de IA inicia este comando e conversa com ele pela entrada e saída padrão.',
      'Registre-o com "cabecao install-client". Mensagens de diagnóstico vão para stderr.',
    ].join('\n'),
    ownsStdout: true,
    load: () => import('./commands/mcp.ts'),
  },
  {
    name: 'install-client',
    summary: 'Registra o servidor MCP nos clientes de IA',
    usage: [
      'install-client <cliente...> [--npx]',
      'install-client --all [--npx]',
      'install-client --print [cliente...]',
      'install-client --remove <cliente...> | --remove --all',
    ],
    options: {
      all: { type: 'boolean', description: 'Todos os clientes detectados nesta máquina' },
      print: { type: 'boolean', description: 'Só mostra a configuração; não grava nada' },
      remove: { type: 'boolean', description: 'Tira o registro em vez de criar' },
      npx: { type: 'boolean', description: 'Registra como "npx -y cabecao mcp" em vez do caminho direto' },
    },
    details: [
      'Clientes: claude-code, claude-desktop, codex, cursor, vscode, gemini.',
      '',
      'O servidor é registrado como "cabecao mcp --brain <pasta>". Quando a instalação é estável (global ou',
      'local), o registro aponta direto para o Node e para o arquivo do cabecao, o que evita de 0,5 a 1,4 s de',
      'npx a cada início de sessão. Rodando por npx, ou com --npx, o registro usa "npx -y cabecao mcp".',
      '',
      'Os outros servidores e chaves do arquivo do cliente são preservados. Na primeira alteração fica uma',
      'cópia do arquivo original ao lado, com o sufixo .bak.',
    ].join('\n'),
    load: () => import('./commands/install-client.ts'),
  },
];
