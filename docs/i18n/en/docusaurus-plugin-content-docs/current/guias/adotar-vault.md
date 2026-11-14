---
title: Adopt an existing vault
description: Turn an Obsidian vault (or a folder of Markdown) into a Cabeção brain, without moving or renaming any note, and open the new folder in Obsidian.
sidebar_position: 7
---

If you already have notes, you do not need to start over. `init` adopts an Obsidian vault or any repository that is mostly Markdown.

## Before

The vault needs to be in a git repository with a remote. If it is not yet, in the vault folder:

```bash
git init
git add -A
git commit -m "primeiro commit"
git remote add origin git@github.com:voce/vault-obsidian.git
git push -u origin main
```

Use a **private** repository.

## Adopt

`init` **clones** the repository into a new folder: it refuses a folder that already exists and is not empty, including the folder where the vault lives today. Run `init` with the URL (the brain goes to `~/cabecao`, or to the `--dir` folder):

```text
$ cabecao init git@github.com:voce/vault.git
...
Pronto. Seu cérebro está em ~/cabecao (máquina notebook) e em git@github.com:voce/vault.git.

Vault adotado: .cabecao.json, .gitattributes, .gitignore, AGENTS.md, CLAUDE.md acrescentados ou completados e enviados na branch main; nenhuma nota foi movida, renomeada ou alterada.
Índice local: 1 nota indexada em 4 ms.

Obsidian: O cérebro é a pasta ~/cabecao, um clone novo do vault. Se o Obsidian abre este vault de outra pasta, ele continua abrindo aquela cópia, que não recebe o que os agentes gravam aqui: no Obsidian, use "Abrir pasta como cofre" (Open folder as vault) e escolha ~/cabecao. Depois de conferir que está tudo aqui, apague a cópia antiga ou deixe de usá-la.
...
Opcional:
  ...
  cabecao obsidian setup  Obsidian: grafo colorido por tipo, propriedades e
                          painéis
```

:::warning[Now there are two folders]
After `init`, your brain is the **new** folder. The old vault folder stays where it was, and Obsidian keeps opening it until you switch: what the agents save goes to the new folder, and what you write in the old one does not reach the agents. In Obsidian, use **Open folder as vault** and pick the new folder. Once you have checked that everything is there, delete the old one (it is just another clone of the same repository).
:::

Adopting the vault where it is, without cloning, does not exist yet (it is [under study](../em-breve.md)).

## What changes in the vault

Only new or completed files, in one commit:

| File | What happens |
| --- | --- |
| `.cabecao.json` | Created, with the note folders |
| `.gitignore` and `.gitattributes` | Completed with the missing lines; what you had stays |
| `AGENTS.md` and `CLAUDE.md` | Created only if they do not exist. A `CLAUDE.md` of yours stays as it is; add the line `@AGENTS.md` to it |
| `index.md` | If the vault already has one, it stays as it is, and Cabeção's catalog goes to `cabecao-index.md` |
| `log.md` | If the vault already has one, Cabeção's log appends lines at the end of it |

The note folders are `wiki`, `memory`, and `raw` (where Cabeção writes new notes; they are created when the first note arrives) plus the vault folders that already contain Markdown. In the example, `Diário` and `Projetos`:

```json
{
  "schemaVersion": 1,
  "noteDirs": [
    "wiki",
    "memory",
    "raw",
    "Diário",
    "Projetos"
  ],
  "indexMd": "index.md"
}
```

If the vault has loose notes at the root, the list becomes `["."]`: the whole root.

## Your old notes

Notes without a `type` are still notes. They show up in search and in the graph as "sem tipo" (untyped):

```text
$ cabecao search rúcula
2 resultado(s) para "rúcula", com todos os termos (validade em 2026-11-13):

1. 2026-11-01  [sem tipo]  vigente
   Diário/2026-11-01.md
   Plantei a «rúcula» hoje.

2. Lista de sementes  [sem tipo]  vigente
   Projetos/Lista de sementes.md › Lista de sementes
   - Alface - «Rúcula»

Relacionadas (vizinhas dos melhores resultados no grafo; fora da ordem acima):
- Horta comunitária  (Projetos/Horta comunitária.md)  ← link para Projetos/Lista de sementes.md

Modo: keyword (a busca por significado não está ativada neste cérebro ("cabecao embeddings on" ativa)).
```

You do not need to convert anything. If you want an old note to count as a decision, preference, or fact, add the `type` (and whatever else makes sense) to its frontmatter.

## When init refuses

`init` refuses a repository that looks like code (`package.json`, `src/` with code, `Cargo.toml`, and other markers) and a repository without `.obsidian/` in which less than 80% of the content is Markdown or attachments (images, PDFs, `.canvas`...). In these cases nothing is created or changed.

The guide to daily use with Obsidian is in [Use with Obsidian](./obsidian.md).
