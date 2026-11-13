---
title: How sync works
description: What cabecao sync sends, how it merges the changes from two machines and what happens in a conflict.
sidebar_position: 5
---

`cabecao sync` makes the brain on this machine match the remote, without discarding anything. Agents can also request a sync through the `sync` tool.

## What it does, in order

1. **Takes the sync lock.** If another sync is already running, it exits with 0 and does nothing.
2. **Scans for secrets in what you edited outside Cabeção** (in Obsidian, in an editor) and puts those changes in a commit.
3. **Fetches the remote** (`git fetch`), with a timeout.
4. **Merges in memory**: it computes the merge result without touching the working folder. There is no half-finished rebase left behind if something fails.
5. **Applies everything at once** to the working folder and regenerates `index.md`.
6. **Scans for secrets in what is about to go out** and only then **pushes** (`git push`). If the push is rejected because the remote moved in the meantime, it goes back to step 3 and tries again.
7. **Updates the local index** with what arrived.

Sync uses git and the credentials your git already uses. It never asks for a password: it runs without a terminal, so a credential that would have to be typed fails with a clear message (see [Troubleshooting](../problemas.md)).

## What goes to the remote

Everything git does not ignore: notes, attachments, `dashboards/`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.cabecao.json` and hidden folders like `.obsidian/`. Left out:

- what the brain's `.gitignore` excludes (the template already ignores the Obsidian window state and system clutter, like `.DS_Store`);
- the `.cabecao/` folder, at any level, even if `.gitignore` does not list it;
- the atomic write temporary files (`.cabecao-<pid>-<hex>.tmp`).

## A regular sync

```text
$ cabecao sync
Sync: ok. 1 commit criado, 1 commit enviado.
Recebidos: 0 commits · enviados: 1 · criados neste sync: 1
```

"Criados" (created) are the commits the sync made itself (your outside edits, for example). In a brain without a remote, sync exits with 0 and a warning.

## Conflicts

If the same note was edited on both machines and git cannot merge the changes on its own, **both versions are kept**:

- the note keeps the remote's version;
- your version goes to a copy next to it, `nota.conflict-<máquina>-<data>.md`.

```text
$ cabecao sync
Sync: ok. 2 commits criados, 1 commit recebido, 2 commits enviados. 1 conflito preservado: as duas versões ficaram no cérebro; resolva e apague a cópia .conflict-*.
Recebidos: 1 commit · enviados: 2 · criados neste sync: 2
Conflitos (1): nada foi descartado.
  memory/preferences/deploy-do-blog-so-as-sextas.md: ficou com a versão do remoto; a sua está em memory/preferences/deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md
Próximo passo: Há conflitos preservados: compare cada cópia .conflict-* com a nota, junte o que importa e apague a cópia.
```

The copy travels through sync like any other file, so the other machines see it too. `status` and `doctor` list it until you resolve it. Agents do not treat the copy as current memory and cannot edit it. The step-by-step is in [Resolve a conflict](../guias/resolver-conflito.md).

Other cases:

| Situation | What happens |
| --- | --- |
| One machine deleted the note and the other edited it | The edited version is kept |
| `log.md` changed on both | The lines from both are combined (union merge), with no conflict |
| `.cabecao.json` arrived broken from the remote | This machine's valid version is kept, and the remote's goes to `.cabecao.conflict-<máquina>-<data>.json` |
| `.cabecao.json` in this folder is broken | Sync runs with the last valid version from the history, so it can receive the fix made on another machine |

## When sync stops

| Result | Exit code | What it means |
| --- | --- | --- |
| `ok` | 0 | Finished |
| `busy` | 0 | Another sync was already running |
| `blocked` | 1 | Found a possible secret, or there is a half-finished git operation in the folder. Nothing was committed or pushed |
| `offline` | 1 | The remote did not respond. The changes stay in local commits and go out on the next sync |
| `error` | 1 | Another failure; the message tells you what to do |

A sync interrupted in the middle (the computer shut down, for example) is recovered automatically on the next sync, without losing anything.
