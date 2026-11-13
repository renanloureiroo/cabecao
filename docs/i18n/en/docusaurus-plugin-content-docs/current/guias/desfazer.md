---
title: Undo
description: Undo the last operation, a specific operation, or everything an agent session wrote.
sidebar_position: 4
---

Every write Cabeção makes is an identified commit, so any of them can be undone. Undo is a `git revert`: history is not rewritten, and the undo itself can be undone.

## See what can be undone

```text
$ cabecao undo --list
Operações, da mais nova para a mais antiga (desfaça uma com "cabecao undo --op <id>"):

01M79D4B78E20YEFD21TH495C6  2026-11-12 23:52  revert   claude-code @ notebook
    revert concept: Idempotência
01M79D4AWHN51E9VYXYX77P36W  2026-11-12 23:52  update   claude-code @ notebook  sessão 01M79D4AFWB93BEMF0A5SXPNQB  [desfeita por 01M79D4B78E20YEFD21TH495C6]
    update concept: Idempotência
01M79D4AQMDYSK089N1VGHE7S6  2026-11-12 23:52  update   claude-code @ notebook  sessão 01M79D4AFWB93BEMF0A5SXPNQB
    update entity: Bruno Tavares
01M79D4AK27GEYVJGB6S40E86X  2026-11-12 23:52  update   claude-code @ notebook
    update entity: SQS
```

Each line shows the operation, the date, the action, the client and the machine, the session (when it was an agent), and whether it has already been undone. `--limit <n>` changes how many are shown (default: 20), and `--session <id>` filters by session.

## Undo

| Command | Undoes |
| --- | --- |
| `cabecao undo` | The last Cabeção operation in this brain |
| `cabecao undo --op <id>` | One operation. The start of the identifier is enough (at least 8 characters), as long as it is not ambiguous |
| `cabecao undo --session <id>` | Everything an agent session wrote that is still in effect, in a single commit |

```text
$ cabecao undo --session 01M79D4AFWB93BEMF0A5SXPNQB
Desfeito: 1 operação, no commit 9558345ce0 (operação de undo 01M79D4QHMNXGRV0AW6FZG6V50).
  01M79D4AQMDYSK089N1VGHE7S6  update entity: Bruno Tavares
Arquivos alterados:
  log.md
  wiki/entities/Bruno Tavares.md
Próximo passo: Para refazer, desfaça este undo: undo({ op: "01M79D4QHMNXGRV0AW6FZG6V50" }).
Mudou de ideia? "cabecao undo --op 01M79D4QHMNXGRV0AW6FZG6V50" desfaz este undo.
```

The session had two operations, but one had already been undone; the undo only took the one still in effect.

Afterward, run `cabecao sync` to carry the undo to the other machines.

## Through the agent

An agent can also undo, through the `undo` tool: its own last operation, an operation by its full identifier, or a whole session. Without confirmation, it only undoes agent operations, by the full identifier; undoing an operation of yours (or giving only the start of the identifier) requires your explicit request, confirmed with a token (see [Who is human and who is an agent in the CLI](./humano-e-agente.md)). Ask, for example: "undo what you wrote in this session".

## Forget and bring back

[`cabecao forget`](../referencia/cli.md#cabecao-forget) (or the `forget` tool, with confirmation) archives a note in `memory/_archive/`. It leaves search and `recall`, but archiving is an operation like the others: `cabecao undo --op <id>` brings it back to where it was.

## Undo a consolidation

A consolidation ([`cabecao consolidate`](../referencia/cli.md#cabecao-consolidate) or the `consolidate` tool) closes everything the agent wrote in it in one commit. To undo it all at once, use the consolidation id as the session:

```bash
cabecao undo --session 01M7AF1JJ6VKSJXDM09CZ3ZP28
```

Before starting, the consolidation creates a restore point, the local tag `cabecao/restore/<date>-<id>`. If you need to take the whole brain back to that moment (also discarding what came after), use git: `git reset --hard <tag>`. That rewrites the local branch; only do it if none of that went to the remote.

## What undo does not reach

Undo only knows Cabeção operations. Edits you made in Obsidian, sync commits, and the `init` commit are left out. For those, use git in the brain folder:

```bash
git log --oneline
git revert <commit>
cabecao sync
```

With nothing to undo, the command exits with 1:

```text
$ cabecao undo
cabecao: não há operação do Cabeção para desfazer
```

The anatomy of the commits is in [Commits and undo](../conceitos/commits-e-undo.md).
