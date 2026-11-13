---
title: Commits e undo
description: O formato dos commits que o Cabeção faz no seu cérebro e como o undo usa esses commits.
sidebar_position: 6
---

Cada gravação do Cabeção é um commit no repositório do cérebro. O autor é a identidade do seu git (`user.name` e `user.email`). Nenhum commit leva linha de coautoria ou atribuição a IA.

## O formato

O assunto segue o estilo do plugin Obsidian Git. O corpo tem uma linha por mudança e o último parágrafo traz rodapés que identificam a operação:

```text
vault backup: 2026-11-12 23:51:28.161

add preference: Deploy do blog só às sextas

Cabecao-Op: 01M79D2CYHZ9K8D45W0JKNRDHS
Cabecao-Session: 01M79D2CYEH9KV0KR17FPC70HX
Cabecao-Machine: notebook
Cabecao-Client: claude-code
```

| Rodapé | O que é |
| --- | --- |
| `Cabecao-Op` | Identificador da operação (um ULID). É o que o `undo --op` recebe. |
| `Cabecao-Session` | A sessão do agente que gravou (o `session_handle` do `recall`). Falta em edições suas. |
| `Cabecao-Machine` | O nome da máquina, definido no `init`. |
| `Cabecao-Client` | Quem gravou: `claude-code`, `codex`, `cursor`... para agentes; `cli` para você pela CLI; `manual` para edições feitas fora do Cabeção e postas num commit pelo sync. |
| `Cabecao-Reverts` | Só em commits de undo: a operação desfeita. |
| `Cabecao-Approved` | Só em operações de agente feitas com o seu pedido explícito, confirmado. |

As linhas do corpo dizem o que mudou: `add gotcha: título`, `update entity: título`, `revert concept: título`, `edit: 1 nota alterada fora do Cabeção`, `conflict: 1 nota com conflito preservado`.

O assunto pode ser mudado em `commit.message` e `commit.dateFormat` no [`.cabecao.json`](../referencia/configuracao.md#commit).

## Como o undo usa os commits

`cabecao undo` lê esses rodapés para achar o que desfazer e desfaz com `git revert`. O histórico nunca é reescrito: o undo é um commit novo, que também pode ser desfeito.

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

Logo depois, um `cabecao undo` sem argumentos desfez esse undo (a última operação), o que refaz a edição. O commit gerado:

```text
vault backup: 2026-11-12 23:52:44.684

revert entity: Bruno Tavares

Cabecao-Op: 01M79D4QRCZ7DMHZAQGPTZ91MV
Cabecao-Machine: notebook
Cabecao-Client: cli
Cabecao-Reverts: 01M79D4QHMNXGRV0AW6FZG6V50
```

## O que o undo alcança

- **Você, pela CLI**, desfaz qualquer operação do Cabeção: as dos agentes e os próprios undos.
- **Um agente** (pelo MCP ou pela CLI) desfaz sozinho só operações de agentes, pelo identificador completo. Uma operação sua, ou só o começo do identificador, ele só desfaz com o seu pedido explícito, confirmado.
- **Nenhum dos dois** desfaz o que não é operação do Cabeção: edições que você fez no Obsidian, commits do sync, cópias de conflito e o commit do `init`. Para esses, use o git direto (`git log` e `git revert` na pasta do cérebro).

Se o arquivo mudou depois da operação de um jeito que impede o revert limpo, o undo para com o erro `conflict` e não altera nada.

O guia prático está em [Desfazer](../guias/desfazer.md).
