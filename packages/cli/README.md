<p align="center">
  <img src="https://raw.githubusercontent.com/renanloureiroo/cabecao/main/assets/marca/banner.png" alt="Cabeção: segundo cérebro em Markdown e git, servido por MCP">
</p>

# cabecao

Seu segundo cérebro em Markdown e git, para você e seus agentes de IA, servido por MCP.

Suas notas são arquivos Markdown num repositório git seu, em qualquer provedor (GitHub, GitLab, Bitbucket, Gitea, servidor próprio ou só a sua máquina). Os agentes de IA (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Antigravity, Gemini CLI) consultam e gravam nelas pelo servidor MCP do `cabecao` ou, nos agentes com shell, pelas skills do Cabeção, que usam a própria CLI (`cabecao install-skills`). Cada gravação vira um commit que você desfaz com um comando.

> **Beta:** `0.1.0-beta.1`. Instale com a etiqueta `beta`.

*English: Cabeção is a personal second brain. Your notes are Markdown files in a git repository you own, on any host, and AI agents read and write them through a local MCP server. Every write is a commit you can undo. The CLI prints its messages in Portuguese for now. Documentation in English: <https://renanloureiroo.github.io/cabecao/en/>.*

## Começar

Requer Node.js 22.16+ (recomendado: 24) e git 2.38+. Crie antes um repositório vazio e **privado**.

```bash
npm i -g cabecao@beta
cabecao init git@github.com:voce/cerebro.git
cabecao doctor
```

O `init` não pergunta nada: cria o cérebro num repositório vazio, só baixa um cérebro existente (segunda máquina), adota um vault do Obsidian sem mover arquivos, recusa o que não é cérebro e, sem URL, cria um cérebro só local. Depois ele monta o índice local e registra o servidor MCP nos clientes de IA que encontrar.

## Comandos

| Comando | O que faz |
| --- | --- |
| `cabecao init [url]` | Instala ou conecta esta máquina a um cérebro |
| `cabecao status` | Notas, último sync, envios pendentes, conflitos e os opcionais pendentes |
| `cabecao doctor` | Diagnóstico com a correção sugerida para cada problema |
| `cabecao sync` | Sincroniza com o remoto, sem descartar nada |
| `cabecao schedule on\|off\|status` | Sync periódico pelo agendador do sistema |
| `cabecao search "<pergunta>"` | Busca no cérebro, com `--as-of` para o passado |
| `cabecao recall "<tarefa>"` | O briefing que o agente recebe no início de uma tarefa |
| `cabecao read <nota>` | Lê uma nota, com a proveniência |
| `cabecao remember` | Grava uma memória (a tool `remember`) |
| `cabecao write <caminho>` | Cria, sobrescreve ou acrescenta a uma nota |
| `cabecao patch <caminho>` | Troca um trecho exato de uma nota |
| `cabecao relate <de> <tipo> <para>` | Liga duas notas com uma relação tipada |
| `cabecao handoff` | Passagem de bastão para a próxima sessão |
| `cabecao graph "<nota>"` | Vizinhos de uma nota no grafo |
| `cabecao facts` | Fatos e se valem numa data |
| `cabecao ingest <arquivo>` | Registra uma fonte em `raw/` |
| `cabecao lint` | Relatório de saúde do cérebro, por regras |
| `cabecao consolidate` | Consolida a memória (também chamando um agente, com `--run`) |
| `cabecao forget <nota>` | Arquiva uma nota (nunca apaga) |
| `cabecao undo` | Desfaz uma operação ou uma sessão de agente |
| `cabecao embeddings on\|off\|status\|switch` | Busca por significado, com um modelo local |
| `cabecao compact` | Reduz a branch de índice da busca por significado |
| `cabecao eval <perguntas.jsonl>` | Mede a busca com as suas perguntas |
| `cabecao reindex` | Reconstrói o banco local |
| `cabecao obsidian setup` | Configura o cérebro para o Obsidian |
| `cabecao export canvas` | Exporta um mapa do grafo (`.canvas`) |
| `cabecao upgrade` | Aplica as migrações do esquema do cérebro |
| `cabecao ask "<pergunta>"` | Resposta com citações conferidas, pelo provedor que você ativar (opcional) |
| `cabecao llm on\|off\|status\|test\|remove` | O provedor das respostas do `ask`: desligado por padrão; nada sai da máquina até você ativar |
| `cabecao install-client <cliente>` | Registra o servidor MCP num cliente de IA |
| `cabecao install-skills` | Instala as skills do Cabeção nos agentes (uso pela CLI, sem MCP) |
| `cabecao uninstall` | Tira o Cabeção desta máquina; nunca o cérebro |
| `cabecao mcp` | O servidor MCP por stdio, que os clientes iniciam |

`cabecao <comando> --help` mostra as opções e exemplos. Todos aceitam `--json` e `--brain <pasta>`.

## Documentação

<https://renanloureiroo.github.io/cabecao/>: instalação, conceitos, guias, referência da CLI e das 17 tools MCP, segurança e solução de problemas.

Código e issues: <https://github.com/renanloureiroo/cabecao>

## Licença

[MIT](https://github.com/renanloureiroo/cabecao/blob/main/LICENSE)
