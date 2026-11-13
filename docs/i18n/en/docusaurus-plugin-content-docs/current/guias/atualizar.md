---
title: Update and uninstall
description: Update the program (the way you installed it), apply the brain's migrations with cabecao upgrade, and remove Cabeção from the machine with cabecao uninstall without touching the brain.
sidebar_position: 12
---

Updating has two parts: the **program** (the `cabecao` package, the Claude Code plugin, the Claude Desktop package) and, once in a while, the **brain**, when a new version changes its format. How to [uninstall](#uninstall) is at the end of this page.

## The program

The command depends on how you installed it. `cabecao doctor` shows the one for your installation on its first line:

```text
ok     Cabeção                  0.1.0-beta.1 (instalado com npm -g); para atualizar: npm i -g cabecao@beta
```

| Installed with | To update |
| --- | --- |
| `npm i -g` | `npm i -g cabecao@beta` |
| `pnpm add -g` | `pnpm add -g cabecao@beta` |
| `npx` | `npx cabecao@beta <command>` (`npx` uses the version you ask for) |
| Inside a project | `npm i cabecao@beta`, in the project folder |
| Claude Code plugin | `/plugin update cabecao@cabecao` |

While Cabeção is in beta, use the `@beta` tag: without it, npm may install an older beta. The CLI messages that tell you to update (a brain from a newer version, the scheduled sync that lost the program) already show the command for your installation, with the tag of the channel in use. The Claude Desktop package updates by installing the new `.mcpb` over the old one ([Claude Desktop](./claude-desktop.md)). None of this touches the brain.

After updating, run `cabecao install-skills` again if you installed the [skills](./skills.md): it replaces only the ones still as Cabeção wrote them. `doctor` warns when they are from an earlier version. If Node changed (nvm, fnm, Volta), also run `cabecao install-client --all`: the registration in the clients points to the Node path, and `doctor` flags it when that path no longer exists.

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
Sync: bloqueado. O cérebro no remoto foi atualizado para o esquema 2 por uma versão mais nova do Cabeção, e este Cabeção só entende até o 1. Nada do remoto foi aplicado e nada foi enviado; as mudanças desta máquina estão em commits locais. Atualize o Cabeção nesta máquina e rode o sync de novo.
Recebidos: 0 commits · enviados: 0 · criados neste sync: 1
Próximo passo: Atualize o Cabeção nesta máquina e rode o sync de novo ("cabecao doctor" mostra o comando para a sua instalação); até lá, as mudanças daqui ficam em commits locais e nada é enviado.
Para atualizar: npm i -g cabecao@beta
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

## Uninstall

npm runs nothing when it uninstalls a package. That is why, before removing the program, you run `cabecao uninstall`: it removes from this machine everything Cabeção put **outside the brain**:

- the MCP server registration in every AI client (like `cabecao install-client --remove`);
- the skills it installed (the ones you edited stay);
- the scheduled sync (like `cabecao schedule off`);
- the machine configuration (`~/.config/cabecao`, or the `CABECAO_CONFIG_DIR` folder);
- the provider for [answers with a model](./respostas-com-modelo.md), if you turned it on: `llm.json` and the stored keys, in the system keychain and in the file (if the keychain refuses to delete a key, `uninstall` says which);
- the cache: the semantic search runtime and models and the consolidation logs (`--keep-cache` keeps it).

The **brain is never touched**: it is yours, and it is in git and on the remote. The `.bak` copy that `install-client` saved of each client's original file also stays.

See first what would be removed; anyone, even an agent, can run `--dry-run`:

```text
$ cabecao uninstall --dry-run
O que "cabecao uninstall" tiraria desta máquina (nada foi feito):
  registro do servidor MCP no Codex: ~/.codex/config.toml
  registro do servidor MCP no Cursor: ~/.cursor/mcp.json
  skills do Cabeção em ~/.agents/skills (codex, cursor; só as que você não alterou)
  configuração da máquina: ~/.config/cabecao

Fica: o cérebro em ~/cabecao (é seu, está no git e no remoto). Apague a pasta à mão se quiser.
Para tirar o programa depois: npm uninstall -g cabecao
```

To remove, run it without `--dry-run`, in your terminal. It shows the same list and asks:

```text
$ cabecao uninstall
Vai sair desta máquina:
  ...
Remover? [s/N] s
Pronto:
  registro removido do Codex
  registro removido do Cursor
  skills removidas de ~/.agents/skills
  apagado ~/.config/cabecao
O cérebro continua em ~/cabecao.
Para tirar o programa: npm uninstall -g cabecao
```

Only you confirm: without a terminal (an agent, a script), the command refuses with exit code 4. Then remove the program with the command it showed (`npm uninstall -g cabecao`, `pnpm remove -g cabecao` or `/plugin uninstall cabecao@cabecao`). To also remove the brain from this machine, delete its folder; the remote still has everything.
