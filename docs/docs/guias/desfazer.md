---
title: Desfazer
description: Desfaça a última operação, uma operação específica ou tudo o que uma sessão de agente gravou.
sidebar_position: 4
---

Toda gravação do Cabeção é um commit identificado, então qualquer uma pode ser desfeita. O undo é um `git revert`: o histórico não é reescrito, e o próprio undo pode ser desfeito.

## Ver o que dá para desfazer

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

Cada linha mostra a operação, a data, a ação, o cliente e a máquina, a sessão (quando foi um agente) e se já foi desfeita. `--limit <n>` muda quantas aparecem (padrão: 20), e `--session <id>` filtra uma sessão.

## Desfazer

| Comando | Desfaz |
| --- | --- |
| `cabecao undo` | A última operação do Cabeção neste cérebro |
| `cabecao undo --op <id>` | Uma operação. Basta o começo do identificador (pelo menos 8 caracteres), se não for ambíguo |
| `cabecao undo --session <id>` | Tudo o que uma sessão de agente gravou e que ainda vale, num commit só |

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

A sessão tinha duas operações, mas uma já tinha sido desfeita; o undo só pegou a que ainda valia.

Depois, rode `cabecao sync` para levar o undo às outras máquinas.

## Pelo agente

Um agente também desfaz, pela tool `undo`: a última operação dele, uma operação pelo identificador completo ou uma sessão inteira. Ele só alcança operações de agentes, nunca as suas. Peça, por exemplo: "desfaça o que você gravou nesta sessão".

## Esquecer e trazer de volta

[`cabecao forget`](../referencia/cli.md#cabecao-forget) (ou a tool `forget`, com confirmação) arquiva uma nota em `memory/_archive/`. Ela sai da busca e do `recall`, mas o arquivamento é uma operação como as outras: `cabecao undo --op <id>` a traz de volta para onde estava.

## Desfazer uma consolidação

Uma consolidação ([`cabecao consolidate`](../referencia/cli.md#cabecao-consolidate) ou a tool `consolidate`) fecha num commit tudo o que o agente gravou nela. Para desfazer tudo de uma vez, use o id da consolidação como sessão:

```bash
cabecao undo --session 01M7AF1JJ6VKSJXDM09CZ3ZP28
```

Antes de começar, a consolidação cria um ponto de restauração, a tag local `cabecao/restore/<data>-<id>`. Se precisar voltar o cérebro inteiro para aquele instante (descartando também o que veio depois), use o git: `git reset --hard <tag>`. Isso reescreve a branch local; faça só se nada daquilo foi para o remoto.

## O que o undo não alcança

O undo só conhece operações do Cabeção. Edições que você fez no Obsidian, os commits do sync e o commit do `init` ficam de fora. Para esses, use o git na pasta do cérebro:

```bash
git log --oneline
git revert <commit>
cabecao sync
```

Sem nada para desfazer, o comando sai com 1:

```text
$ cabecao undo
cabecao: não há operação do Cabeção para desfazer
```

A anatomia dos commits está em [Commits e undo](../conceitos/commits-e-undo.md).
