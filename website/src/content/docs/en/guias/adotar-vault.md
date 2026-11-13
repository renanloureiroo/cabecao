---
title: Adopt an existing vault
description: Turn an Obsidian vault (or a folder of Markdown) into a Cabeção brain without moving any file.
sidebar:
  order: 7
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

`init` clones the repository into a new folder: it refuses a folder that already exists and is not empty. On the machine where the vault already lives, pick another folder with `--dir` (or move the original aside) and run `init` with the URL:

```text
$ cabecao init git@github.com:voce/vault-obsidian.git --dir ~/Obsidian/Notas --machine notebook
...
Pasta do cérebro: ~/Obsidian/Notas (máquina notebook)

Repositório: Vault adotado sem mover nenhum arquivo: .cabecao.json, .gitattributes, .gitignore, AGENTS.md, CLAUDE.md acrescentados ou completados e enviados na branch main.

Índice local: 3 notas indexadas em 7 ms.
...
Próximos passos:
  - Nada foi movido: o Obsidian continua abrindo o vault como antes.
  - Em outra máquina, rode cabecao init git@github.com:voce/vault-obsidian.git.
```

Then, in Obsidian, open the new folder as a vault. You can delete the old one once you have checked that everything is there.

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
```

You do not need to convert anything. If you want an old note to count as a decision, preference, or fact, add the `type` (and whatever else makes sense) to its frontmatter.

## When init refuses

`init` refuses a repository that looks like code (`package.json`, `src/` with code, `Cargo.toml`, and other markers) and a repository without `.obsidian/` in which less than 80% of the content is Markdown or attachments (images, PDFs, `.canvas`...). In these cases nothing is created or changed.

The guide to daily use with Obsidian is in [Use with Obsidian](/cabecao/en/guias/obsidian/).
