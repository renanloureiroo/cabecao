---
title: Updating Cabeção
description: Update the program, apply the brain's schema migrations with cabecao upgrade and, if you want, the new AGENTS.md template.
sidebar_position: 12
---

Updating has two parts: the **program** (the `cabecao` package, the Claude Code plugin, the Claude Desktop package) and, once in a while, the **brain**, when a new version changes its format.

## The program

```bash
npm i -g cabecao@beta     # or: npx cabecao@beta <command>
```

The Claude Code plugin updates through the marketplace, and the Claude Desktop package by installing the new `.mcpb` over the old one ([Claude Desktop](./claude-desktop.md)). None of them touches the brain.

Update every machine that uses the same brain. See below what happens to a machine that falls behind.

## The brain schema: `cabecao upgrade`

`.cabecao.json` stores the version of the brain format, `schemaVersion`. When a Cabeção version changes that format, it brings a **migration**, and `cabecao status` and `cabecao doctor` warn with a line like this (the format; today it does not show up, because there is no migration):

```text
Atualização: 1 migração pendente do esquema 1 para o 2. Rode "cabecao upgrade".
```

Today the schema is 1 and there is no migration: the command just confirms it.

```text
$ cabecao upgrade
Esquema 1: em dia (este Cabeção usa o 1). Nenhuma migração pendente.
```

When there is a migration, `cabecao upgrade`:

1. only runs with the brain **clean and synced**: run `cabecao sync` first (with changes outside a commit, or commits not yet pushed, it refuses and says so);
2. creates a **restore point**, the local tag `cabecao/restore/<date>-upgrade`;
3. applies the migrations in order, **one commit per migration** (`migrate: <what changed> (esquema 1 → 2)`), all in the same session;
4. ends by telling you how to undo: `cabecao undo --session <id>` undoes the whole update, and `git reset --hard <tag>` goes back to the restore point.

`cabecao upgrade --dry-run` shows the migrations and the files that would change, without writing anything. Running it again, already up to date, does nothing. Afterwards, run `cabecao sync`.

### Machines on different versions

The compatibility rule is this:

- **New Cabeção, brain on an older schema**: works normally, with the pending-migration warning. You decide when to migrate.
- **Old Cabeção, brain on a newer schema**: Cabeção refuses to open the brain (CLI and MCP server) and tells you to update. `cabecao sync` on an old machine **applies and pushes nothing** when the remote is already on a newer schema: that machine's changes stay in local commits, and go out on the first sync after you update Cabeção on it.

```text
$ cabecao sync
Sync: bloqueado. O cérebro no remoto foi atualizado para o esquema 2 por uma versão mais nova do Cabeção, e este Cabeção só entende até o 1. Nada do remoto foi aplicado e nada foi enviado; as mudanças desta máquina estão em commits locais. Atualize o Cabeção nesta máquina ("npm i -g cabecao@latest" ou "npx cabecao@latest") e rode o sync de novo.
Recebidos: 0 commits · enviados: 0 · criados neste sync: 1
Próximo passo: Atualize o Cabeção nesta máquina e rode sync de novo; até lá, as mudanças daqui ficam em commits locais e nada é enviado.
```

A schema change only ships in a minor or major version of the package, never in a patch.

## The brain template: `cabecao upgrade --template`

`init` writes an `AGENTS.md` (the brain's rules for agents), a `CLAUDE.md`, a `.gitignore` and a `.gitattributes`. New Cabeção versions sometimes improve that template: the `AGENTS.md` from betas `0.1.0-beta.0` and `beta.1`, for example, still tells agents to save the handoff with `remember`, and today there is the `handoff_save` tool. These files are yours, so the update is **optional and never overwrites what you edited**:

- a file equal to the template of an earlier version (you never edited it) is replaced with the current one;
- a file you edited shows the diff and asks; without a terminal (or if you say no), it stays as is, and the current template goes to `.cabecao/template/<file>`, for you to compare and merge by hand; `--yes` replaces without asking;
- in `.gitignore` and `.gitattributes`, it only appends the missing lines, at the end;
- a file that does not exist is not recreated;
- everything goes in one commit, which `cabecao undo --op <id>` undoes.

`cabecao status` tells you when there is a template update. On a brain created by the beta:

```text
$ cabecao upgrade --template --dry-run
Modelo do cérebro: ~/cabecao (simulação: nada foi gravado)
  AGENTS.md: modelo de uma versão anterior, sem edição sua: será trocado
  CLAUDE.md: igual ao modelo atual
  .gitignore: igual ao modelo atual
  .gitattributes: igual ao modelo atual
Rode sem --dry-run para aplicar (os arquivos editados por você só mudam se você confirmar).

$ cabecao upgrade --template
Modelo do cérebro: ~/cabecao
  AGENTS.md: modelo de uma versão anterior, sem edição sua: será trocado
  CLAUDE.md: igual ao modelo atual
  .gitignore: igual ao modelo atual
  .gitattributes: igual ao modelo atual
  ~ AGENTS.md: trocado pelo modelo atual
Commit b3ea13bf2c; "cabecao undo --op 01M7AKWKSKNEWJ4XXPNDP69ZEV" desfaz. Rode "cabecao sync" depois.
```

On a brain with an edited `AGENTS.md` and a short `.gitignore` (an adopted vault, for example):

```text
$ cabecao upgrade --template
Modelo do cérebro: ~/cabecao
  AGENTS.md: editado por você
  CLAUDE.md: igual ao modelo atual
  .gitignore: faltam linhas do modelo (.cabecao-*.tmp, .obsidian/workspace.json, .obsidian/workspace-mobile.json, .DS_Store, Thumbs.db, desktop.ini)
  .gitattributes: igual ao modelo atual
Diferença entre o seu AGENTS.md e o modelo atual:
    --- seu AGENTS.md
    +++ modelo atual
    ...
  ~ .gitignore: linhas acrescentadas
  = AGENTS.md: mantido como está; o modelo atual ficou em .cabecao/template/AGENTS.md para você comparar
Commit 6e2b2ec7ce; "cabecao undo --op 01M7AKW4EGWA9XY09SJ7V2DQDT" desfaz. Rode "cabecao sync" depois.
```

The Obsidian dashboards in `dashboards/` follow the same rule through `cabecao obsidian setup`: a dashboard you edited is never replaced ([Obsidian](./obsidian.md)).
