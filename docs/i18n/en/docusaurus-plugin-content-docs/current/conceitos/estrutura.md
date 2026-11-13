---
title: Brain structure
description: The folders and files of a Cabeção brain and what each one is for.
sidebar_position: 1
---

A brain is a folder with a git repository. `cabecao init` creates this structure in an empty repository:

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

Empty folders are kept in git with a `.gitkeep`.

## The three note folders

| Folder | What it holds | Who writes |
| --- | --- | --- |
| `raw/` | Sources as they arrived: meeting minutes, articles, PDFs, images. They do not follow the schema and do not change after they are created. | You. An agent creates new files there; changing existing ones only with your explicit request. |
| `wiki/` | What is true about the world: concepts, people, projects, decisions, source summaries, syntheses. | You and the agents. |
| `memory/` | What an agent needs to work your way: rules, preferences, gotchas, procedures, facts, episodes, handoffs. | You and the agents; rules, an agent only saves with your explicit request. |

These are the default note folders (`noteDirs` in [`.cabecao.json`](../referencia/configuracao.md)). An adopted vault can have others. Outside them, nothing is indexed and nothing can be written by an agent.

Each note type has its own folder: `decision` goes to `wiki/decisions/`, `gotcha` to `memory/gotchas/`, and so on. Episodes also get the year and month: `memory/episodes/2026/11/`. The full list is in [Note types and frontmatter](./notas.md).

## Control files

- **`AGENTS.md`** tells any agent how to use the brain: call `recall` at the start, search before claiming, what to remember and what not to remember, the order of authority between sources. It is yours: edit it as you like. An agent only changes it with your explicit request.
- **`CLAUDE.md`** has a single line, `@AGENTS.md`, so Claude Code reads the same rules when it opens the folder.
- **`index.md`** is the catalog of all notes, grouped by folder. Cabeção regenerates it; do not edit it by hand.
- **`log.md`** gets one line per operation, always at the end. `.gitattributes` turns on union merge for it, so two machines that wrote at the same time never cause a conflict in this file.

A log after an agent session:

```markdown
# Diário

- 2026-11-13 · add gotcha: Testes de pagamento precisam do fuso fixo
- 2026-11-13 · add preference: Revisão de PR em tópicos curtos
- 2026-11-13 · add episode: Sessão: Revisei o PR de estorno parcial
- 2026-11-13 · add handoff: Revisão do PR de pagamentos
```

## What stays out of git

The `.cabecao/` folder belongs to this machine: the local database (`cabecao.db`, with the search index, the graph and the facts), the locks and the sync state. It is rebuilt from the notes when it is missing, never goes to the remote, and sync ignores it even if your `.gitignore` does not list it. See [Files and directories](../referencia/arquivos.md).

## `memory/_archive/`

Notes you took out of circulation. They stay in git, but search and `recall` do not bring them up. To archive, use [`cabecao forget`](../referencia/cli.md#cabecao-forget): it moves the note here, in a commit, and `cabecao undo` brings it back.
