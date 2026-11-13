---
title: Commits and undo
description: The format of the commits Cabeção makes in your brain and how undo uses those commits.
sidebar_position: 6
---

Every Cabeção write is a commit in the brain repository. The author is your git identity (`user.name` and `user.email`). No commit carries a co-author line or attribution to AI.

## The format

The subject follows the style of the Obsidian Git plugin. The body has one line per change, and the last paragraph has trailers that identify the operation:

```text
vault backup: 2026-11-12 23:51:28.161

add preference: Deploy do blog só às sextas

Cabecao-Op: 01M79D2CYHZ9K8D45W0JKNRDHS
Cabecao-Session: 01M79D2CYEH9KV0KR17FPC70HX
Cabecao-Machine: notebook
Cabecao-Client: claude-code
```

| Trailer | What it is |
| --- | --- |
| `Cabecao-Op` | Operation identifier (a ULID). It is what `undo --op` takes. |
| `Cabecao-Session` | The session of the agent that wrote (the `session_handle` from `recall`). Missing on your own edits. |
| `Cabecao-Machine` | The machine name, set in `init`. |
| `Cabecao-Client` | Who wrote: `claude-code`, `codex`, `cursor`... for agents; `cli` for you through the CLI; `manual` for edits made outside Cabeção and committed by sync. |
| `Cabecao-Reverts` | Only on undo commits: the operation that was reverted. |
| `Cabecao-Approved` | Only on agent operations done with your explicit, confirmed request. |

The body lines say what changed: `add gotcha: título`, `update entity: título`, `revert concept: título`, `edit: 1 nota alterada fora do Cabeção`, `conflict: 1 nota com conflito preservado`.

You can change the subject with `commit.message` and `commit.dateFormat` in [`.cabecao.json`](../referencia/configuracao.md#commit).

## How undo uses the commits

`cabecao undo` reads these trailers to find what to revert and reverts it with `git revert`. History is never rewritten: the undo is a new commit, which can also be reverted.

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

Right after, a `cabecao undo` with no arguments reverted that undo (the last operation), which redoes the edit. The resulting commit:

```text
vault backup: 2026-11-12 23:52:44.684

revert entity: Bruno Tavares

Cabecao-Op: 01M79D4QRCZ7DMHZAQGPTZ91MV
Cabecao-Machine: notebook
Cabecao-Client: cli
Cabecao-Reverts: 01M79D4QHMNXGRV0AW6FZG6V50
```

## What undo can reach

- **You, through the CLI**, can revert any Cabeção operation: the agents' operations and the undos themselves.
- **An agent** (over MCP or through the CLI) reverts on its own only agent operations, by the full identifier. An operation of yours, or just the start of the identifier, it only reverts with your explicit, confirmed request.
- **Neither of you** can revert what is not a Cabeção operation: edits you made in Obsidian, sync commits, conflict copies and the `init` commit. For those, use git directly (`git log` and `git revert` in the brain folder).

If the file changed after the operation in a way that prevents a clean revert, undo stops with the `conflict` error and changes nothing.

The practical guide is in [Undo](../guias/desfazer.md).
