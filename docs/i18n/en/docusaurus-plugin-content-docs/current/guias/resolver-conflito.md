---
title: Resolve a conflict
description: Merge the two versions of a note edited on two machines and delete the conflict copy.
sidebar_position: 3
---

A conflict happens when the same line of a note was edited on two machines before a sync. Cabeção never chooses for you: both versions stay in the brain.

## How it shows up

In the example, the note was edited on `notebook` (7 p.m.) and on `desktop` (8 p.m.). `notebook` synced first; on `desktop`:

```text
$ cabecao sync
Sync: ok. 2 commits criados, 1 commit recebido, 2 commits enviados. 1 conflito preservado: as duas versões ficaram no cérebro; resolva e apague a cópia .conflict-*.
Recebidos: 1 commit · enviados: 2 · criados neste sync: 2
Conflitos (1): nada foi descartado.
  memory/preferences/deploy-do-blog-so-as-sextas.md: ficou com a versão do remoto; a sua está em memory/preferences/deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md
Próximo passo: Há conflitos preservados: compare cada cópia .conflict-* com a nota, junte o que importa e apague a cópia.
```

- `deploy-do-blog-so-as-sextas.md` kept the version that was already on the remote (7 p.m.);
- `deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md` has this machine's version (8 p.m.). The name tells you the machine and the date.

`status` and `doctor` keep reminding you until you resolve it:

```text
$ cabecao status
...
Conflitos pendentes: 1
  memory/preferences/deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md → memory/preferences/deploy-do-blog-so-as-sextas.md
Problemas:
  - 1 conflito pendente
Próximo passo: Resolva os conflitos: compare cada cópia .conflict-* com a nota original, junte e apague a cópia.
```

## Resolve

1. Open both in your editor (or in Obsidian, side by side).
2. Leave in the original note the text that should stand.
3. Delete the `.conflict-*` copy.
4. Run sync:

```text
$ cabecao sync
Sync: ok. 1 commit criado, 1 commit enviado.
Recebidos: 0 commits · enviados: 1 · criados neste sync: 1
```

The other machines get the resolution on their next sync.

## Until you resolve it

- The copy travels through sync like any other file; every machine sees it.
- Agents do not treat the copy as current memory and cannot edit or delete it. You are the one who resolves it.
- Nothing is blocked: you can keep using the brain and resolve it later.

## Special cases

- **One machine deleted the note and the other edited it**: the edited version stays, with no copy. If you meant to delete it, delete it again.
- **The remote's `.cabecao.json` arrived broken**: this machine's version stays, and the remote's goes to `.cabecao.conflict-<máquina>-<data>.json`. Fix it and delete the copy the same way.
