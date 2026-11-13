---
title: Estrutura do cérebro
description: As pastas e os arquivos de um cérebro do Cabeção e para que serve cada um.
sidebar_position: 1
---

Um cérebro é uma pasta com um repositório git. O `cabecao init` cria esta estrutura num repositório vazio:

```text
cabecao/
├── .cabecao.json        configuração compartilhada entre as máquinas
├── .gitignore           ignora .cabecao/ e o estado das janelas do Obsidian
├── .gitattributes       log.md com merge por união
├── AGENTS.md            regras de uso do cérebro para qualquer agente
├── CLAUDE.md            importa o AGENTS.md para o Claude Code
├── index.md             catálogo gerado de todas as notas
├── log.md               diário: uma linha por operação, só no fim
├── raw/                 fontes brutas e imutáveis
│   ├── articles/
│   ├── assets/
│   ├── meetings/
│   └── pdfs/
├── wiki/                conhecimento sobre o mundo
│   ├── sources/
│   ├── concepts/
│   ├── entities/
│   ├── decisions/
│   └── syntheses/
├── memory/              o que os agentes precisam saber para trabalhar com você
│   ├── rules/
│   ├── preferences/
│   ├── gotchas/
│   ├── procedures/
│   ├── facts/
│   ├── episodes/
│   ├── handoffs/
│   └── _archive/
├── dashboards/          painéis e mapas para o Obsidian
└── .cabecao/            banco local desta máquina (fora do git)
```

As pastas vazias ficam no git com um `.gitkeep`.

## As três pastas de notas

| Pasta | O que guarda | Quem escreve |
| --- | --- | --- |
| `raw/` | Fontes como chegaram: atas, artigos, PDFs, imagens. Não seguem o esquema e não mudam depois de criadas. | Você. Um agente cria arquivos novos ali; alterar os que existem, só com o seu pedido explícito. |
| `wiki/` | O que é verdade sobre o mundo: conceitos, pessoas, projetos, decisões, resumos de fontes, sínteses. | Você e os agentes. |
| `memory/` | O que um agente precisa para trabalhar do seu jeito: regras, preferências, armadilhas, procedimentos, fatos, episódios, handoffs. | Você e os agentes; regras, um agente só grava com o seu pedido explícito. |

Essas são as pastas de notas padrão (`noteDirs` no [`.cabecao.json`](../referencia/configuracao.md)). Um vault adotado pode ter outras. Fora delas, nada é indexado nem pode ser gravado por um agente.

Cada tipo de nota tem a sua pasta: `decision` vai para `wiki/decisions/`, `gotcha` para `memory/gotchas/`, e assim por diante. Episódios ganham ainda o ano e o mês: `memory/episodes/2026/11/`. A lista completa está em [Tipos de nota e frontmatter](./notas.md).

## Arquivos de controle

- **`AGENTS.md`** diz a qualquer agente como usar o cérebro: chamar `recall` no começo, buscar antes de afirmar, o que lembrar e o que não lembrar, a ordem de autoridade entre as fontes. É seu: edite como quiser. Um agente só o altera com o seu pedido explícito.
- **`CLAUDE.md`** tem uma linha só, `@AGENTS.md`, para o Claude Code ler as mesmas regras quando abre a pasta.
- **`index.md`** é o catálogo de todas as notas, agrupado por pasta. O Cabeção o regenera; não edite à mão.
- **`log.md`** recebe uma linha por operação, sempre no fim. O `.gitattributes` liga o merge por união para ele, então duas máquinas que escreveram ao mesmo tempo nunca geram conflito nesse arquivo.

Um diário depois de uma sessão de agente:

```markdown
# Diário

- 2026-11-13 · add gotcha: Testes de pagamento precisam do fuso fixo
- 2026-11-13 · add preference: Revisão de PR em tópicos curtos
- 2026-11-13 · add episode: Sessão: Revisei o PR de estorno parcial
- 2026-11-13 · add handoff: Revisão do PR de pagamentos
```

## O que fica fora do git

A pasta `.cabecao/` é desta máquina: o banco local (`cabecao.db`, com o índice de busca, o grafo e os fatos), as travas e o estado do sync. Ela é refeita a partir das notas quando falta, nunca vai para o remoto e o sync a ignora mesmo que o seu `.gitignore` não a cite. Veja [Arquivos e diretórios](../referencia/arquivos.md).

## `memory/_archive/`

Notas que você tirou de circulação. Elas continuam no git, mas a busca e o `recall` não as trazem. Para arquivar, use [`cabecao forget`](../referencia/cli.md#cabecao-forget): ele move a nota para cá, num commit, e `cabecao undo` a traz de volta.
