---
title: Novidades
description: O que mudou em cada versão publicada do Cabeção.
---

As versões são publicadas no npm. Para atualizar:

```bash
npm i -g cabecao
```

## 1.0.0

A primeira versão estável, publicada sem etiqueta: `npm i -g cabecao` instala a versão mais nova. A partir dela, os comandos, as tools do servidor MCP e o formato do cérebro seguem o versionamento semântico: mudança incompatível só em versão maior. Além do que veio nas betas (abaixo), ela traz o grafo com validade no tempo, a busca por significado, o ciclo de vida da memória, a CLI com as mesmas regras do servidor MCP (que passa a ter 17 tools, mais o `ask` quando você ativa um provedor), as skills, o plugin do Claude Code, o sync automático, a integração com o Obsidian e as respostas com um modelo de linguagem, opcionais.

- **O grafo e a validade no tempo.** Tools [`graph`](./referencia/mcp.md#graph), [`facts`](./referencia/mcp.md#facts) e [`relate`](./referencia/mcp.md#relate) no servidor MCP; comandos [`cabecao graph`](./referencia/cli.md#cabecao-graph) e [`cabecao facts`](./referencia/cli.md#cabecao-facts), e a opção `--as-of` no `cabecao search`. Cada resultado diz se a nota está vigente, vencida ou ainda não vigente na data; as que não valem descem na lista, mas nunca somem. `as_of` nas tools `search`, `facts` e `graph` responde a perguntas sobre o passado.
  - **Substituição sem `valid_until`**: basta o link `supersedes` (ou `superseded_by`) para a nota antiga contar como vencida a partir da data da nova.
  - **Relações tipadas**, uma propriedade de frontmatter por relação (`uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to`), mais as que você declarar em `relations` no `.cabecao.json`.
  - **Menções sem link**: o título ou um `aliases` de outra nota citado no texto vira uma ligação no grafo. Um nome colado a `_`, `/`, `\` ou `@` (como `sqs_fila`, `filas/SQS` ou `ana@sqs`) não conta como menção.
  - **Bloco de relacionadas na busca**: até 5 notas vizinhas dos melhores resultados, com o motivo, sem mudar a ordem.
  - **Segurança**: uma nota de agente que diga substituir uma regra sua não a derruba; só outra regra sua faz isso.
- **Busca por significado, sincronizada.** [`cabecao embeddings on`](./referencia/cli.md#cabecao-embeddings) instala o runtime sob demanda e calcula os embeddings com um modelo local escolhido por você; a busca ganha os modos `keyword`, `semantic` e `hybrid` (`--mode`, e `mode` na tool `search`); os vetores vão para a branch `cabecao/index` e sobem no mesmo envio do conteúdo, então uma segunda máquina não recalcula nada. Comandos novos: `embeddings`, `compact`, `eval` e `reindex`. A busca avisa quando há trechos ainda sem vetor (notas gravadas depois do último sync), que nessa busca só aparecem por palavra-chave até o próximo sync calcular.
- **Skills do Cabeção.** Cinco skills por intenção (consultar, lembrar, passar o bastão, manutenção a pedido e ações com pedido explícito) ensinam o agente a usar o cérebro pela CLI, sem o servidor MCP, com as mesmas regras. [`cabecao install-skills`](./referencia/cli.md#cabecao-install-skills) instala nos agentes detectados (Claude Code, Codex, Cursor, VS Code, Antigravity, Gemini CLI), por usuário ou no projeto, sem sobrescrever uma skill que você alterou; `--instructions` mostra um bloco para colar no `AGENTS.md` de um agente sem skills. O plugin do Claude Code traz as mesmas skills. Veja [Usar o Cabeção com skills](./guias/skills.md).
- **O fim do `init` leva ao primeiro sucesso.** Ele termina com "Pronto", o que ficou configurado em cada agente, um bloco "Teste agora" com o que pedir ao agente e até três opcionais detectados (skills, sync automático, busca por significado, Obsidian), cada um com o comando. `status` e `doctor` repetem os opcionais pendentes. Veja [Criar ou conectar um cérebro](./comecar/init.md).
- **`cabecao uninstall`.** Tira desta máquina os registros nos clientes, as skills, o sync agendado, a configuração e o cache, nunca o cérebro; mostra o que vai sair e pergunta (só você, no terminal); `--dry-run` só mostra. Veja [Atualizar e desinstalar](./guias/atualizar.md).
- **Ajuda melhor.** Todo comando tem exemplos, a ajuda geral agrupa os comandos, o texto respeita a largura do terminal (80 colunas sem terminal) e um comando, uma opção, um subcomando ou um cliente com erro de digitação recebe uma sugestão ("você quis dizer").
- **O `doctor` mais preciso.** Mostra a versão e o comando de atualização da sua instalação; avisa quando o plugin do Claude Code e o registro direto do servidor estão ativos juntos (as tools em dobro); acusa o Node gravado no registro de um cliente que não existe mais (nvm, fnm, Volta); trata a identidade que o git inventa (sem `user.email`) como aviso; confere as skills instaladas; e junta numa linha os avisos da busca por significado de uma mesma causa.
- **Mensagens de erro mais claras.** Permissão negada, disco só de leitura e disco cheio dizem o que houve e o que fazer, sem o texto cru do sistema; o sync não diz mais que as edições estão em commits quando o commit delas falhou; o git ausente diz como instalar; sem estados internos nem referências de documentos internos no texto.
- **A dica de atualização sabe como o Cabeção foi instalado** (npm, pnpm, npx, projeto, plugin) e usa o canal da versão (`@latest` numa versão estável, `@beta` numa beta). O registro por `npx` fixa a versão (`npx -y cabecao@<versão> mcp`).
- **A frase sobre o vault adotado diz a verdade**: o `init` clona o vault numa pasta nova, e é essa pasta que o Obsidian tem de abrir. Veja [Adotar um vault existente](./guias/adotar-vault.md).
- **Respostas com um modelo de linguagem, opcionais.** [`cabecao ask`](./referencia/cli.md#cabecao-ask) e a tool [`ask`](./referencia/mcp.md#ask) respondem com citações conferidas pelo Cabeção (citação inventada é descartada; sem nenhuma válida, "o cérebro não tem isso"), usando o provedor que você ativar com [`cabecao llm on`](./referencia/cli.md#cabecao-llm): o Claude Code instalado, as APIs da Anthropic, da OpenAI, do Gemini, do OpenRouter e da Groq, ou um servidor local (Ollama, LM Studio). Desligado por padrão: nada sai da máquina até você ativar. Notas com `private: true` e trechos com segredo nunca saem, e o `.cabecao.json` ganha a `llm_policy`. O `eval` ganha `--answers`. Veja [Respostas com um modelo de linguagem](./guias/respostas-com-modelo.md).
- **Mudança de comportamento: a CLI sem terminal roda como agente.** Até aqui, todo `cabecao` rodava como você. Agora quem roda é **você** só quando o processo tem um terminal controlador e não há sinal de agente no ambiente (`CLAUDECODE`, `CODEX_*`, `GEMINI_CLI`, `CURSOR_AGENT`, `AI_AGENT`, `CI`...); em qualquer outro caso (o Bash de um agente, um cron, um script), é um **agente**, sob as mesmas regras do servidor MCP. Nenhuma opção ou variável eleva para humano; `--as <cliente>` só dá nome ao agente. Na prática: um script seu sem terminal passa a gravar memórias com `origin: agent:cli-agent`, `cabecao forget --yes` sem terminal é recusado, e `embeddings on/off/switch`, `compact` e `upgrade` só rodam no seu terminal (saem com o código 4 fora dele). A administração (`sync`, `status`, `doctor`, `init`, `schedule`, `install-client`, `mcp`, `recall --hook`) roda como antes. Veja [Quem é humano e quem é agente na CLI](./guias/humano-e-agente.md).
- **Regras e arquivos de controle com o seu pedido.** O que era recusado a um agente por autoridade (criar e editar regras, escrever em `AGENTS.md`, `CLAUDE.md`, `log.md`, `.cabecao.json`..., alterar fontes de `raw/`, gravar `trust: high`, desfazer uma operação sua) passa a ser permitido com o seu pedido explícito, confirmado pelo mesmo token em duas chamadas do `forget`. O resultado fica marcado (`approved_by: user`, rodapé `Cabecao-Approved`), nunca vira `origin: human`, e a regra nova `agent_approved` do `lint` lista tudo para você revisar. As proteções técnicas (fora do cérebro, `.git/`, links simbólicos, segredos, frontmatter forjado, cópias de conflito, `index.md`) continuam valendo sem exceção. Numa consolidação automática (`consolidate --run`), sem ninguém para confirmar, essas ações ficam indisponíveis, a não ser com `--allow-elevated`, opção que, como `--allow-forget`, só você passa no terminal. Veja [Segurança](./seguranca.md).
- **Comandos novos na CLI, com as regras das tools:** [`read`](./referencia/cli.md#cabecao-read), [`remember`](./referencia/cli.md#cabecao-remember), [`write`](./referencia/cli.md#cabecao-write), [`patch`](./referencia/cli.md#cabecao-patch), [`relate`](./referencia/cli.md#cabecao-relate) e [`handoff`](./referencia/cli.md#cabecao-handoff). Recebem o conteúdo por argumento, arquivo, entrada padrão ou um JSON com os campos da tool (`--json-input`), com os mesmos limites, e devolvem em `--json` a mesma saída da tool. Ação que precisa de confirmação sai com o código 3. Assim uma skill pode usar o Cabeção pela CLI, sem conectar o servidor MCP.
- **Obsidian com um comando.** `cabecao obsidian setup` configura o vault: cores do grafo por tipo de nota, tipos das propriedades (datas como data, relações como lista), o arquivo morto fora da busca, cinco painéis `.base` em `dashboards/` e o modelo do Web Clipper, que salva recortes em `raw/articles/` com `trust: low`. Só acrescenta ao que você já tem, com `--dry-run`, cópia do original e `--remove`. Veja [Usar com o Obsidian](./guias/obsidian.md).
- **Mapas do grafo.** [`cabecao export canvas`](./referencia/cli.md#cabecao-export) gera um `.canvas` do Obsidian com a vizinhança de uma nota, um escopo ou o cérebro inteiro, agrupado por tipo e com o tipo de cada relação nas setas.
- **Pacote para o Claude Desktop.** Um `.mcpb` anexado a cada versão no GitHub traz o servidor para o Claude Desktop, com o programa embutido. Veja [Claude Desktop](./guias/claude-desktop.md).
- **`cabecao upgrade`.** Aplica as migrações do esquema do cérebro com ponto de restauração e um commit por migração (hoje não há nenhuma pendente). Com `--template`, atualiza o `AGENTS.md` e o `CLAUDE.md` que ainda estão como o modelo de uma versão anterior e completa o `.gitignore` e o `.gitattributes`, sem passar por cima do que você editou. `status` e `doctor` avisam do que está pendente. Veja [Atualizar o Cabeção](./guias/atualizar.md).
- **Sync entre versões.** Uma máquina com o Cabeção antigo não aplica nem envia nada quando o remoto já foi migrado por uma versão mais nova; as mudanças dela ficam em commits locais até a atualização.
- **O ciclo de vida da memória.** Cinco tools novas no servidor MCP e quatro comandos na CLI:
  - `handoff_save`: a passagem de bastão, com validade, e o episódio da sessão; o `recall` entrega o último handoff do projeto e avisa quando ele já foi entregue a outra sessão.
  - O `remember` trata duplicatas e contradições no mesmo escopo e tipo: igual é ignorado, o que complementa atualiza, um fato com outro objeto substitui o antigo, e o caso ambíguo volta para o agente decidir.
  - `ingest` e [`cabecao ingest`](./referencia/cli.md#cabecao-ingest): registram uma fonte em `raw/` com `trust: low` e devolvem o plano de ingestão.
  - `lint` e [`cabecao lint`](./referencia/cli.md#cabecao-lint): relatório de problemas por regras, só de leitura.
  - `forget` e [`cabecao forget`](./referencia/cli.md#cabecao-forget): arquivam em `memory/_archive/`, com confirmação; nunca apagam.
  - `consolidate` e [`cabecao consolidate`](./referencia/cli.md#cabecao-consolidate): manutenção com ponto de restauração, fechada num commit que o `undo` desfaz inteiro.
  - Prompts MCP `ingest`, `review` e `consolidate`.
- **Memórias velhas nunca confirmadas perdem peso.** Uma preferência, armadilha ou procedimento sem `confirmed` e sem atualização há 180 dias vem mais abaixo na busca, sem sumir.
- **Plugin do Claude Code.** `/plugin marketplace add renanloureiroo/cabecao` e `/plugin install cabecao@cabecao` instalam o servidor MCP embutido (sem `npx`), o briefing do cérebro no início de cada sessão e o sync em segundo plano no fim, além das skills do Cabeção. Nenhum hook captura a conversa. Veja [Plugin do Claude Code](./guias/claude-code.md).
- **Sync automático.** `cabecao schedule on|off|status` registra o sync periódico no agendador do sistema (LaunchAgent, timer do systemd de usuário ou crontab, Agendador de Tarefas), sem administrador. Veja [Sync automático](./guias/sync-automatico.md).
- **Comandos novos:** `cabecao recall` mostra o briefing de uma tarefa no terminal; `cabecao sync` ganha `--detach` (em segundo plano), `--hook` e `--log`. O `doctor` passa a verificar o agendamento.
- **Consolidar com um agente.** `cabecao consolidate --run` chama o Claude Code ou o Codex (com chave de API) sem ninguém olhando, só com as tools do Cabeção (shell, edição de arquivos e rede negados), numa pasta temporária, com tempo limite; se o agente não fechar a consolidação, o que ele gravou é desfeito. `--dry-run` mostra tudo antes. Veja [Consolidar com um agente](./guias/consolidar-com-agente.md).
- **Antigravity.** `cabecao install-client antigravity` registra o servidor no Antigravity (CLI `agy`, IDE e App), o sucessor do Gemini CLI para contas pessoais. Ele não entra no `--run`: os termos do plano pessoal não permitem que outro programa o chame. O `gemini` continua, com aviso, e deixa de ser detectado só pela pasta `~/.gemini`, que é dividida entre os dois.

## 0.1.0-beta.1

*12 de novembro de 2026*

A mesma versão da 0.1.0-beta.0, publicada de novo: só o número da versão mudou.

## 0.1.0-beta.0

*12 de novembro de 2026*

A primeira versão publicada.

- **`cabecao init` com a URL do repositório**, em qualquer provedor git: cria o cérebro num repositório vazio, só baixa um cérebro existente, adota um vault do Obsidian sem mover arquivos e recusa o que não é cérebro. Sem URL, cria um cérebro só local.
- **Sync por git** de tudo o que o git não ignora, com integração em memória, cópia de conflito em vez de perda, recuperação de sync interrompido e proteção do `.cabecao.json`.
- **Busca por palavra-chave** no índice local (SQLite com FTS5 do próprio Node).
- **Servidor MCP** por stdio com 9 tools: `recall`, `search`, `read`, `status`, `remember`, `write_page`, `patch_page`, `sync` e `undo`, mais resources e instruções para o agente.
- **Undo** por `git revert` da última operação, de uma operação ou de uma sessão inteira de agente.
- **Scanner de segredos** em toda gravação e antes de todo envio, com o marcador `cabecao:allow-secret` para o usuário.
- **Restrições a agentes**: não criam regras, não escrevem em arquivos de controle nem de instrução de clientes, e ao editar uma nota sua deixam `edited_by` e baixam o `trust`.
- **`cabecao install-client`** para Claude Code, Claude Desktop, Codex, Cursor, VS Code e Gemini CLI, preservando o resto do arquivo de cada cliente.
- **`cabecao doctor`** com a correção sugerida para cada problema, e **`cabecao status`**.
- Um pacote só, sem dependências de runtime nem binários nativos. Requer Node.js 22.16+ ou 24+ e git 2.38+.
