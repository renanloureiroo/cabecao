---
title: Resolver um conflito
description: Junte as duas versões de uma nota editada em duas máquinas e apague a cópia de conflito.
sidebar_position: 3
---

Um conflito acontece quando a mesma linha de uma nota foi editada em duas máquinas antes de um sync. O Cabeção nunca escolhe por você: as duas versões ficam no cérebro.

## Como ele aparece

No exemplo, a nota foi editada no `notebook` (19h) e no `desktop` (20h). O `notebook` sincronizou primeiro; no `desktop`:

```text
$ cabecao sync
Sync: ok. 2 commits criados, 1 commit recebido, 2 commits enviados. 1 conflito preservado: as duas versões ficaram no cérebro; resolva e apague a cópia .conflict-*.
Recebidos: 1 commit · enviados: 2 · criados neste sync: 2
Conflitos (1): nada foi descartado.
  memory/preferences/deploy-do-blog-so-as-sextas.md: ficou com a versão do remoto; a sua está em memory/preferences/deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md
Próximo passo: Há conflitos preservados: compare cada cópia .conflict-* com a nota, junte o que importa e apague a cópia.
```

- `deploy-do-blog-so-as-sextas.md` ficou com a versão que já estava no remoto (19h);
- `deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md` tem a versão desta máquina (20h). O nome diz a máquina e a data.

O `status` e o `doctor` lembram até você resolver:

```text
$ cabecao status
...
Conflitos pendentes: 1
  memory/preferences/deploy-do-blog-so-as-sextas.conflict-desktop-20261112-235155.md → memory/preferences/deploy-do-blog-so-as-sextas.md
Busca por significado: desativada ("cabecao embeddings on" ativa)
Respostas (ask): opcional, desligado; nada sai da máquina ("cabecao llm on" ativa)
Problemas:
  - 1 conflito pendente
Próximo passo: Resolva os conflitos: compare cada cópia .conflict-* com a nota original, junte e apague a cópia.
```

## Resolver

1. Abra as duas no editor (ou no Obsidian, lado a lado).
2. Deixe na nota original o texto que deve valer.
3. Apague a cópia `.conflict-*`.
4. Rode o sync:

```text
$ cabecao sync
Sync: ok. 1 commit criado, 1 commit enviado.
Recebidos: 0 commits · enviados: 1 · criados neste sync: 1
```

As outras máquinas recebem a resolução no próximo sync delas.

## Enquanto não resolve

- A cópia viaja pelo sync como qualquer arquivo; todas as máquinas a veem.
- Os agentes não tratam a cópia como memória vigente e não podem editá-la nem apagá-la. Quem resolve é você.
- Nada trava: você pode continuar usando o cérebro e resolver depois.

## Casos especiais

- **Uma máquina apagou a nota e a outra editou**: fica a versão editada, sem cópia. Se você queria apagar, apague de novo.
- **O `.cabecao.json` do remoto chegou quebrado**: fica o desta máquina, e o do remoto vai para `.cabecao.conflict-<máquina>-<data>.json`. Corrija e apague a cópia da mesma forma.
