---
title: Como o sync funciona
description: O que o cabecao sync leva, como integra as mudanças de duas máquinas e o que acontece num conflito.
sidebar_position: 5
---

`cabecao sync` deixa o cérebro desta máquina igual ao do remoto, sem descartar nada. Os agentes também podem pedir um sync pela tool `sync`.

## O que ele faz, em ordem

1. **Toma a trava** do sync. Se outro sync já estiver rodando, sai com 0 e não faz nada.
2. **Procura segredos no que você editou fora do Cabeção** (no Obsidian, num editor) e põe essas mudanças num commit.
3. **Busca o remoto** (`git fetch`), com tempo limite.
4. **Integra em memória**: calcula o resultado da junção sem mexer na pasta de trabalho. Não existe rebase pela metade para sobrar se algo falhar.
5. **Aplica tudo de uma vez** na pasta de trabalho e regenera o `index.md`.
6. **Procura segredos no que vai sair** e só então **envia** (`git push`). Se o envio for recusado porque o remoto andou no meio, ele volta ao passo 3 e tenta de novo.
7. **Atualiza o índice local** com o que chegou.

O sync usa o git e as credenciais que o seu git já usa. Nunca pede senha: ele roda sem terminal, então uma credencial que precisaria ser digitada falha com uma mensagem clara (veja [Solução de problemas](../problemas.md)).

## O que vai para o remoto

Tudo o que o git não ignora: notas, anexos, `dashboards/`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.cabecao.json` e pastas ocultas como `.obsidian/`. Fica de fora:

- o que o `.gitignore` do cérebro exclui (o modelo já ignora o estado das janelas do Obsidian e o lixo do sistema, como `.DS_Store`);
- a pasta `.cabecao/`, em qualquer nível, mesmo que o `.gitignore` não a cite;
- os temporários da escrita atômica (`.cabecao-<pid>-<hex>.tmp`).

## Uma sincronização comum

```text
$ cabecao sync
Sync: ok. 1 commit criado, 1 commit enviado.
Recebidos: 0 commits · enviados: 1 · criados neste sync: 1
```

"Criados" são os commits que o próprio sync fez (as suas edições de fora, por exemplo). Num cérebro sem remoto, o sync sai com 0 e um aviso.

## Conflitos

Se a mesma nota foi editada nas duas máquinas e o git não consegue juntar as mudanças sozinho, **as duas versões ficam**:

- a nota fica com a versão do remoto;
- a sua versão vai para uma cópia ao lado, `nota.conflict-<máquina>-<data>.md`.

```text
$ cabecao sync
Sync: ok. 2 commits criados, 1 commit recebido, 2 commits enviados. 1 conflito preservado: as duas versões ficaram no cérebro; resolva e apague a cópia .conflict-*.
Recebidos: 1 commit · enviados: 2 · criados neste sync: 2
Conflitos (1): nada foi descartado.
  memory/preferences/deploy-do-blog-so-as-sextas.md: ficou com a versão do remoto; a sua está em memory/preferences/deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md
Próximo passo: Há conflitos preservados: compare cada cópia .conflict-* com a nota, junte o que importa e apague a cópia.
```

A cópia viaja pelo sync como qualquer arquivo, então as outras máquinas também a veem. O `status` e o `doctor` a listam até você resolver. Os agentes não tratam a cópia como memória vigente e não podem editá-la. O passo a passo está em [Resolver um conflito](../guias/resolver-conflito.md).

Outros casos:

| Situação | O que acontece |
| --- | --- |
| Uma máquina apagou a nota e a outra a editou | Fica a versão editada |
| O `log.md` mudou nas duas | As linhas das duas são juntadas (merge por união), sem conflito |
| O `.cabecao.json` chegou quebrado do remoto | Fica a versão válida desta máquina, e a do remoto vai para `.cabecao.conflict-<máquina>-<data>.json` |
| O `.cabecao.json` desta pasta está quebrado | O sync roda com a última versão válida do histórico, para poder receber a correção feita em outra máquina |

## Quando o sync para

| Resultado | Código de saída | O que significa |
| --- | --- | --- |
| `ok` | 0 | Terminou |
| `busy` | 0 | Outro sync já estava rodando |
| `blocked` | 1 | Achou um possível segredo, ou há uma operação do git pela metade na pasta. Nada foi commitado nem enviado |
| `offline` | 1 | O remoto não respondeu. As mudanças ficam em commits locais e vão no próximo sync |
| `error` | 1 | Outra falha; a mensagem diz o que fazer |

Um sync interrompido no meio (o computador desligou, por exemplo) é recuperado sozinho no sync seguinte, sem perder nada.
