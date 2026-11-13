---
title: Novidades
description: O que mudou em cada versão publicada do Cabeção.
---

As versões são publicadas no npm com a etiqueta `beta`. Para atualizar:

```bash
npm i -g cabecao@beta
```

## Ainda não publicado

- **Mudança de comportamento: a CLI sem terminal roda como agente.** Até aqui, todo `cabecao` rodava como você. Agora quem roda é **você** só quando o processo tem um terminal controlador e não há sinal de agente no ambiente (`CLAUDECODE`, `CODEX_*`, `GEMINI_CLI`, `CURSOR_AGENT`, `AI_AGENT`, `CI`...); em qualquer outro caso (o Bash de um agente, um cron, um script), é um **agente**, sob as mesmas regras do servidor MCP. Nenhuma opção ou variável eleva para humano; `--as <cliente>` só dá nome ao agente. Na prática: um script seu sem terminal passa a gravar memórias com `origin: agent:cli-agent`, `cabecao forget --yes` sem terminal é recusado, e `embeddings on/off/switch`, `compact` e `upgrade` só rodam no seu terminal (saem com o código 4 fora dele). A administração (`sync`, `status`, `doctor`, `init`, `schedule`, `install-client`, `mcp`, `recall --hook`) roda como antes. Veja [Quem é humano e quem é agente na CLI](./guias/humano-e-agente.md).
- **Regras e arquivos de controle com o seu pedido (decisão 37).** O que era recusado a um agente por autoridade (criar e editar regras, escrever em `AGENTS.md`, `CLAUDE.md`, `log.md`, `.cabecao.json`..., alterar fontes de `raw/`, gravar `trust: high`, desfazer uma operação sua) passa a ser permitido com o seu pedido explícito, confirmado pelo mesmo token em duas chamadas do `forget`. O resultado fica marcado (`approved_by: user`, rodapé `Cabecao-Approved`), nunca vira `origin: human`, e a regra nova `agent_approved` do `lint` lista tudo para você revisar. As proteções técnicas (fora do cérebro, `.git/`, links simbólicos, segredos, frontmatter forjado, cópias de conflito, `index.md`) continuam valendo sem exceção. Veja [Segurança](./seguranca.md).
- **Comandos novos na CLI, com as regras das tools:** [`read`](./referencia/cli.md#cabecao-read), [`remember`](./referencia/cli.md#cabecao-remember), [`write`](./referencia/cli.md#cabecao-write), [`patch`](./referencia/cli.md#cabecao-patch), [`relate`](./referencia/cli.md#cabecao-relate) e [`handoff`](./referencia/cli.md#cabecao-handoff). Recebem o conteúdo por argumento, arquivo, entrada padrão ou um JSON com os campos da tool (`--json-input`), com os mesmos limites, e devolvem em `--json` a mesma saída da tool. Ação que precisa de confirmação sai com o código 3. Assim uma skill pode usar o Cabeção pela CLI, sem conectar o servidor MCP.
- **Obsidian com um comando.** `cabecao obsidian setup` configura o vault: cores do grafo por tipo de nota, tipos das propriedades (datas como data, relações como lista), o arquivo morto fora da busca, cinco painéis `.base` em `dashboards/` e o modelo do Web Clipper, que salva recortes em `raw/articles/` com `trust: low`. Só acrescenta ao que você já tem, com `--dry-run`, cópia do original e `--remove`. Veja [Usar com o Obsidian](./guias/obsidian.md).
- **Mapas do grafo.** [`cabecao export canvas`](./referencia/cli.md#cabecao-export) gera um `.canvas` do Obsidian com a vizinhança de uma nota, um escopo ou o cérebro inteiro, agrupado por tipo e com o tipo de cada relação nas setas.
- **Pacote para o Claude Desktop.** Um `.mcpb` anexado a cada versão no GitHub instala o servidor com dois cliques, com o programa embutido. Veja [Claude Desktop](./guias/claude-desktop.md).
- **`cabecao upgrade`.** Aplica as migrações do esquema do cérebro com ponto de restauração e um commit por migração (hoje não há nenhuma pendente). Com `--template`, atualiza o `AGENTS.md` das betas e completa o `.gitignore`, sem passar por cima do que você editou. `status` e `doctor` avisam do que está pendente. Veja [Atualizar o Cabeção](./guias/atualizar.md).
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
- **Plugin do Claude Code.** `/plugin marketplace add renanloureiroo/cabecao` e `/plugin install cabecao@cabecao` instalam o servidor MCP embutido (sem `npx`), o briefing do cérebro no início de cada sessão e o sync em segundo plano no fim, além da skill `cabecao:memory`. Nenhum hook captura a conversa. Veja [Plugin do Claude Code](./guias/claude-code.md).
- **Sync automático.** `cabecao schedule on|off|status` registra o sync periódico no agendador do sistema (LaunchAgent, timer do systemd de usuário ou crontab, Agendador de Tarefas), sem administrador. Veja [Sync automático](./guias/sync-automatico.md).
- **Comandos novos:** `cabecao recall` mostra o briefing de uma tarefa no terminal; `cabecao sync` ganha `--detach` (em segundo plano), `--hook` e `--log`. O `doctor` passa a verificar o agendamento.
- **Menções mais precisas.** Um nome colado a `_`, `/`, `\` ou `@` (como `sqs_fila`, `filas/SQS` ou `ana@sqs`) não conta mais como menção sem link a outra nota.

## 0.1.0-beta.1

*12 de novembro de 2026*

O grafo e a validade no tempo.

- **Tools `graph`, `facts` e `relate`** no servidor MCP, que passa a ter 12 tools. `graph` mostra os vizinhos de uma nota a 1 ou 2 saltos; `facts` lista fatos e se valem numa data, com o encadeamento de versões; `relate` acrescenta uma relação tipada entre duas notas.
- **Comandos `cabecao graph` e `cabecao facts`**, e a opção `--as-of` no `cabecao search`.
- **Validade no tempo**: cada resultado diz se a nota está vigente, vencida ou ainda não vigente na data. As que não valem descem na lista, mas nunca somem. `as_of` nas tools `search`, `facts` e `graph` responde a perguntas sobre o passado.
- **Substituição sem `valid_until`**: basta o link `supersedes` (ou `superseded_by`) para a nota antiga contar como vencida a partir da data da nova.
- **Relações tipadas**, uma propriedade de frontmatter por relação (`uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to`), mais as que você declarar em `relations` no `.cabecao.json`.
- **Menções sem link**: o título ou um `aliases` de outra nota citado no texto vira uma ligação no grafo.
- **Bloco de relacionadas na busca**: até 5 notas vizinhas dos melhores resultados, com o motivo, sem mudar a ordem.
- **Segurança**: uma nota de agente que diga substituir uma regra sua não a derruba; só outra regra sua faz isso.

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
