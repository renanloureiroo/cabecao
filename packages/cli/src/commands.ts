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
    name: 'recall',
    summary: 'Briefing do cérebro para uma tarefa (e para o início de sessão do Claude Code)',
    usage: ['recall "<tarefa>" [--scope <escopo>] [--budget <tokens>]', 'recall --hook'],
    options: {
      scope: {
        type: 'string',
        valueName: 'escopo',
        description: '"global" ou "project:<nome>" (que inclui também o global); padrão: todos',
      },
      budget: { type: 'string', valueName: 'tokens', description: 'Orçamento aproximado do briefing (padrão: 2000)' },
      hook: {
        type: 'boolean',
        description: 'Modo hook do Claude Code: lê o JSON da sessão no stdin e devolve o JSON do SessionStart',
      },
    },
    details: [
      'Mostra o que o agente recebe no início de uma tarefa: suas regras, o último handoff, preferências, armadilhas',
      'e as memórias que casam com a tarefa, nessa ordem de prioridade, e um session_handle novo. Só lê.',
      '',
      '--hook é o que o plugin do Claude Code roda quando uma sessão começa: deriva o escopo da pasta do projeto,',
      'põe as regras de uso e o briefing (marcado como dado, abaixo de 10 mil caracteres) em',
      'hookSpecificOutput.additionalContext e sai sempre com 0. Sem cérebro, com o banco ocupado ou em qualquer erro, a',
      'saída é {} e o motivo vai para o stderr: a sessão começa normalmente.',
    ].join('\n'),
    ownsStdout: true,
    load: () => import('./commands/recall.ts'),
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
      'o registro do servidor MCP nos clientes de IA (só lê os arquivos, não executa nada); e o sync agendado (só',
      'consulta o agendador quando o "cabecao schedule on" registrou algo).',
      '',
      'Cada item sai como ok, aviso ou falha, com a correção. O código de saída é 1 se houver alguma falha.',
    ].join('\n'),
    load: () => import('./commands/doctor.ts'),
  },
  {
    name: 'sync',
    summary: 'Sincroniza o cérebro com o remoto',
    usage: ['sync [--session <id>] [--log]', 'sync --detach', 'sync --hook'],
    options: {
      session: {
        type: 'string',
        valueName: 'id',
        description: 'Sessão do agente que pediu o sync (vai para os commits); usado pelo servidor MCP',
      },
      log: { type: 'boolean', description: 'Também acrescenta o resultado a .cabecao/logs/sync.log (o agendador usa)' },
      detach: {
        type: 'boolean',
        description: 'Dispara o sync num processo em segundo plano e volta na hora; o resultado vai para o log',
      },
      hook: {
        type: 'boolean',
        description: 'Fim de sessão do Claude Code: como --detach, mas nunca falha (o motivo vai para o stderr)',
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
      '',
      '--detach volta em milissegundos e deixa o sync rodando num processo destacado, que sobrevive ao terminal (ou ao',
      'Claude Code) fechar; o resultado fica em <cérebro>/.cabecao/logs/sync.log. Se outro sync já estiver rodando, o',
      'novo sai como "outro sync em andamento", sem fazer nada.',
    ].join('\n'),
    load: () => import('./commands/sync.ts'),
  },
  {
    name: 'schedule',
    summary: 'Sync periódico pelo agendador do sistema',
    usage: ['schedule on [--interval <min>]', 'schedule off', 'schedule status'],
    options: {
      interval: {
        type: 'string',
        valueName: 'min',
        description: 'Minutos entre um sync e outro, de 5 a 1440 (padrão: 30)',
      },
    },
    details: [
      'Registra "cabecao sync --log" no agendador do sistema, só para o seu usuário e sem administrador: LaunchAgent no',
      'macOS, timer do systemd --user no Linux (crontab quando não há systemd de usuário) e Agendador de Tarefas',
      '(schtasks) no Windows. Não há serviço rodando o tempo todo: o sistema inicia o sync a cada intervalo.',
      '',
      'O sync agendado usa o cérebro padrão desta máquina (o do "cabecao init") e grava o resultado em',
      '<cérebro>/.cabecao/logs/sync.log. Ele aponta para este Node e para este arquivo do cabecao: precisa de uma',
      'instalação estável ("npm i -g cabecao"); rodando por npx, o comando recusa. Rodar "on" de novo atualiza o',
      'registro (é idempotente); "off" remove só o que o Cabeção criou; "status" mostra o que está registrado.',
    ].join('\n'),
    load: () => import('./commands/schedule.ts'),
  },
  {
    name: 'search',
    summary: 'Busca no cérebro pelo terminal',
    usage: [
      'search "<pergunta>" [--mode auto|keyword|semantic|hybrid] [--type <tipo>...] [--scope <escopo>] [--limit <n>] [--as-of <data>]',
    ],
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
      mode: {
        type: 'string',
        valueName: 'modo',
        description:
          'auto (padrão: híbrida se a busca por significado estiver ligada aqui), keyword, semantic ou hybrid',
      },
    },
    details: [
      'Com a busca por significado ligada ("cabecao embeddings on"), junta palavra-chave e significado; senão, só',
      'palavra-chave. O fim da saída diz o modo usado e por quê.',
      '',
      'Cada resultado traz título, caminho, trecho e se a nota está vigente, vencida ou',
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
    name: 'embeddings',
    summary: 'Busca por significado: ligar, desligar, ver o estado, trocar de modelo',
    usage: [
      'embeddings on [modelo] [--variant <v>] [--yes]',
      'embeddings off',
      'embeddings status',
      'embeddings switch <modelo> [--variant <v>] [--yes]',
    ],
    options: {
      model: { type: 'string', valueName: 'modelo', description: 'O modelo (o mesmo que o argumento)' },
      variant: { type: 'string', valueName: 'v', description: 'Variante do modelo (padrão: a recomendada)' },
      yes: { type: 'boolean', description: 'Aceita sem perguntar (licença que não é de código aberto, sem terminal)' },
    },
    details: [
      'on: sem o nome do modelo, mostra as sugestões testadas (tamanho, qualidade, licença) e pergunta. Instala o',
      '    runtime e baixa o modelo no diretório de dados do usuário, grava a escolha (e a revisão exata do modelo) no',
      '    .cabecao.json num commit e calcula os embeddings que faltam. Numa segunda máquina usa o modelo já gravado,',
      '    sem perguntar, e os vetores que vieram do repositório.',
      'off: desliga só NESTA máquina: a busca volta a ser por palavra-chave e o sync deixa de calcular vetores, mas o',
      '    modelo continua no .cabecao.json e os vetores na branch de índice, para as outras máquinas.',
      'status: modelo, runtime, trechos com e sem vetor, geração e tamanho da branch de índice.',
      'switch: calcula tudo para o modelo novo numa pasta nova da branch de índice; o antigo continua em uso até o',
      '    cálculo terminar. Interrompido, continua de onde parou ao rodar de novo.',
      '',
      'Depois de on ou switch, rode "cabecao sync" para enviar a escolha e os vetores.',
    ].join('\n'),
    load: () => import('./commands/embeddings.ts'),
  },
  {
    name: 'compact',
    summary: 'Reduz a branch de índice e inicia uma geração nova',
    usage: ['compact [--prune]'],
    options: {
      prune: { type: 'boolean', description: 'Apaga no remoto as gerações antigas que já estão inteiras na nova' },
    },
    details: [
      'Sincroniza, junta os segmentos de embeddings num só, tira vetores repetidos, os de trechos que não existem',
      'mais e as pastas de modelos fora de uso, grava tudo numa geração nova da branch de índice (sem reescrever',
      'histórico) e sincroniza de novo para enviá-la. As outras máquinas migram sozinhas no próximo sync.',
    ].join('\n'),
    load: () => import('./commands/compact.ts'),
  },
  {
    name: 'eval',
    summary: 'Mede a busca com as suas perguntas',
    usage: ['eval <perguntas.jsonl> [--alpha <α>...] [--k <n>]'],
    options: {
      alpha: {
        type: 'string',
        multiple: true,
        valueName: 'α',
        description: 'Pesos do vetor na fusão (padrão: 0.3, 0.5 e 0.7)',
      },
      k: { type: 'string', valueName: 'n', description: 'Profundidade das métricas (padrão: 10)' },
    },
    details: [
      'Uma pergunta por linha, em JSON: {"query": "...", "expected": "caminho/da/nota.md", "kind": "paraphrase"}.',
      '"expected" aceita o id ou o caminho da nota, ou uma lista. Compara só palavra-chave, só vetor e a fusão com',
      'cada α, e imprime MRR, nDCG, recall e acerto na 1ª posição, por tipo de pergunta, com o intervalo de',
      'confiança da diferença contra a palavra-chave. Sem a busca por significado, mede só a palavra-chave.',
    ].join('\n'),
    load: () => import('./commands/eval.ts'),
  },
  {
    name: 'reindex',
    summary: 'Reconstrói o banco local',
    usage: ['reindex [--full]'],
    options: { full: { type: 'boolean', description: 'Apaga o banco e indexa tudo do zero' } },
    details:
      'Atualiza o banco local (.cabecao/cabecao.db) com o que mudou nas notas, ou, com --full, refaz do zero. O banco\né só uma visão das notas: refazer é sempre seguro.',
    load: () => import('./commands/reindex.ts'),
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
    name: 'lint',
    summary: 'Relatório de saúde do cérebro, por regras',
    usage: ['lint [--rule <regra>...] [--scope <escopo>] [--limit <n>]'],
    options: {
      rule: {
        type: 'string',
        multiple: true,
        valueName: 'regra',
        description:
          'Só estas regras (repita, ou separe por vírgula): invalid_frontmatter, fact_contradiction, conflict_copy, broken_link, expired_note, unconfirmed_memory, unlinked_mention, orphan_note',
      },
      scope: { type: 'string', valueName: 'escopo', description: '"global" ou "project:<nome>" (que inclui o global)' },
      limit: { type: 'string', valueName: 'n', description: 'Máximo de achados, de 1 a 1000 (padrão: 200)' },
    },
    details: [
      'Só lê: nada é alterado. Aponta fatos vigentes que se contradizem, links quebrados, notas órfãs, memórias sem',
      'confirmação há mais de 180 dias, notas vencidas, menções sem link, cópias de conflito pendentes e notas com',
      'frontmatter inválido, cada achado com a severidade, o caminho e a correção sugerida. Sem LLM: são regras.',
      'Código de saída 1 quando há algum erro (frontmatter ilegível ou inválido); avisos e informativos saem com 0.',
    ].join('\n'),
    load: () => import('./commands/lint.ts'),
  },
  {
    name: 'ingest',
    summary: 'Registra uma fonte (artigo, ata, documento) em raw/',
    usage: ['ingest <arquivo> [--title <título>] [--scope <escopo>]'],
    options: {
      title: { type: 'string', valueName: 'título', description: 'Título da fonte (padrão: o do arquivo)' },
      scope: {
        type: 'string',
        valueName: 'escopo',
        description: '"global" (padrão) ou "project:<nome>" para as notas',
      },
    },
    details: [
      'Copia o texto do arquivo (Markdown ou texto, até 4 MB) para raw/articles/, com origin: ingest:file e trust: low,',
      'passando pelo scanner de segredos, num commit. Um arquivo que já está em raw/ não é copiado de novo. Mostra o',
      'plano de ingestão (o que ler, que notas criar e atualizar): o Cabeção não tem LLM, quem escreve as notas é o',
      'agente. O frontmatter do arquivo não vira frontmatter da nota: só título, fonte e autor são aproveitados.',
    ].join('\n'),
    load: () => import('./commands/ingest.ts'),
  },
  {
    name: 'forget',
    summary: 'Arquiva uma nota em memory/_archive/ (nunca apaga)',
    usage: ['forget <id ou caminho> [--reason <texto>] [--yes]'],
    options: {
      reason: { type: 'string', valueName: 'texto', description: 'Por que esquecer (fica na nota arquivada)' },
      yes: { type: 'boolean', description: 'Arquiva sem perguntar (sem terminal, é obrigatório)' },
    },
    details: [
      'Mostra o que será arquivado e pergunta. A nota vai para memory/_archive/, sai da busca e do recall e continua no',
      'git, num commit; "cabecao undo" a traz de volta. Pela CLI você arquiva qualquer nota, inclusive regras; um agente',
      'não arquiva regras e precisa de confirmação em duas chamadas. Apagar de vez (reescrevendo o histórico) não existe.',
    ].join('\n'),
    load: () => import('./commands/forget.ts'),
  },
  {
    name: 'consolidate',
    summary: 'Prepara e fecha uma consolidação da memória',
    usage: ['consolidate [--scope <escopo>]', 'consolidate --finish <id> [--title <rótulo>]'],
    options: {
      scope: { type: 'string', valueName: 'escopo', description: '"global" ou "project:<nome>" (que inclui o global)' },
      finish: { type: 'string', valueName: 'id', description: 'Fecha a consolidação com este id num commit' },
      title: {
        type: 'string',
        valueName: 'rótulo',
        description: 'Com --finish: rótulo do commit (consolidate: <rótulo>)',
      },
    },
    details: [
      'Sem --finish: cria o ponto de restauração (a tag local cabecao/restore/<data>-<id>) e mostra o material',
      '(episódios que se repetem, notas parecidas, achados do lint) e os passos para um agente seguir. O Cabeção não',
      'tem LLM e este comando não chama nenhum agente: peça a um (Claude Code, por exemplo) para seguir os passos.',
      'Com --finish: junta num commit tudo o que a consolidação gravou, com uma linha por nota. "cabecao undo',
      '--session <id>" desfaz a consolidação inteira; "git reset --hard <tag>" volta ao ponto de restauração.',
    ].join('\n'),
    load: () => import('./commands/consolidate.ts'),
  },
  {
    name: 'obsidian',
    summary: 'Configura o cérebro para o Obsidian: grafo, propriedades, painéis e Web Clipper',
    usage: ['obsidian setup [--dry-run] [--force]', 'obsidian setup --remove [--dry-run]', 'obsidian clipper'],
    options: {
      'dry-run': { type: 'boolean', description: 'Mostra o que mudaria, com a diferença de cada arquivo; não grava' },
      force: { type: 'boolean', description: 'Grava mesmo com o Obsidian aberto neste cérebro' },
      remove: { type: 'boolean', description: 'Tira só o que o setup acrescentou (e não foi mudado depois)' },
    },
    details: [
      'setup: em .obsidian/, MESCLA app.json (links, anexos em raw/assets, memory/_archive fora da busca), graph.json',
      '(uma cor por tipo de nota e por pasta) e types.json (datas como data, relações como lista). Só acrescenta o',
      'que falta: nunca troca uma escolha sua, nunca tira nem reordena o que já existe e não reformata o arquivo. Na',
      'primeira alteração, guarda o original em .cabecao/backups/obsidian/. Rodar de novo não muda nada.',
      'workspace.json e os plugins nunca são tocados. Também grava em dashboards/ os painéis (.base) e o modelo do',
      'Web Clipper, sem substituir um painel que você editou. Feche o Obsidian antes: aberto, ele regrava a configuração.',
      'setup --remove: tira o que o setup desta máquina acrescentou, menos o que você mudou depois.',
      'clipper: mostra o modelo do Web Clipper (JSON), para salvar num arquivo e importar na extensão.',
    ].join('\n'),
    load: () => import('./commands/obsidian.ts'),
  },
  {
    name: 'export',
    summary: 'Exporta um mapa do grafo para o Obsidian (.canvas)',
    usage: [
      'export canvas [--node <nota>] [--depth 1|2] [--limit <n>] [-o <arquivo>] [--force]',
      'export canvas --scope <escopo> [--limit <n>] [-o <arquivo>] [--force]',
    ],
    options: {
      node: { type: 'string', valueName: 'nota', description: 'Nota central: título, caminho ou id' },
      depth: { type: 'string', valueName: 'n', description: 'Com --node: 1 (padrão) ou 2 saltos' },
      scope: {
        type: 'string',
        valueName: 'escopo',
        description: 'Só as notas deste escopo: "global" ou "project:<nome>"',
      },
      limit: { type: 'string', valueName: 'n', description: 'Máximo de notas no mapa, de 1 a 500 (padrão: 60)' },
      output: {
        type: 'string',
        short: 'o',
        valueName: 'arquivo',
        description: 'Arquivo .canvas (padrão: dashboards/mapa-<nome>.canvas)',
      },
      force: { type: 'boolean', description: 'Substitui o arquivo se ele já existe' },
    },
    details: [
      'Gera um arquivo JSON Canvas com a vizinhança de uma nota (--node), as notas de um escopo (--scope) ou o cérebro',
      'inteiro: uma caixa por tipo de nota, com as cores do grafo do Obsidian, notas em grade sem sobreposição e setas',
      'com o tipo da relação (uses, part_of, supersedes...). Menções sem link, notas arquivadas e cópias de conflito',
      'ficam de fora. Acima do limite, saem as notas mais longe e as menos ligadas, com aviso. Não substitui um mapa',
      'existente sem --force: ele pode ter a sua arrumação.',
    ].join('\n'),
    load: () => import('./commands/export.ts'),
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
