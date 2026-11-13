---
title: Novidades
description: O que mudou em cada versão publicada do Cabeção.
---

As versões são publicadas no npm com a etiqueta `beta`. Para atualizar:

```bash
npm i -g cabecao@beta
```

## Ainda não publicado

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
