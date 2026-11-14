---
title: Adotar um vault existente
description: Transforme um vault do Obsidian (ou uma pasta de Markdown) num cérebro do Cabeção, sem mover nem renomear nenhuma nota, e abra a pasta nova no Obsidian.
sidebar_position: 7
---

Se você já tem notas, não precisa começar de novo. O `init` adota um vault do Obsidian ou qualquer repositório que seja, na maior parte, Markdown.

## Antes

O vault precisa estar num repositório git com um remoto. Se ainda não está, na pasta do vault:

```bash
git init
git add -A
git commit -m "primeiro commit"
git remote add origin git@github.com:voce/vault-obsidian.git
git push -u origin main
```

Use um repositório **privado**.

## Adotar

O `init` **clona** o repositório numa pasta nova: ele recusa uma pasta que já existe e não está vazia, inclusive a pasta onde o vault mora hoje. Rode o `init` com a URL (o cérebro vai para `~/cabecao`, ou para a pasta de `--dir`):

```text
$ cabecao init git@github.com:voce/vault.git
...
Pronto. Seu cérebro está em ~/cabecao (máquina notebook) e em git@github.com:voce/vault.git.

Vault adotado: .cabecao.json, .gitattributes, .gitignore, AGENTS.md, CLAUDE.md acrescentados ou completados e enviados na branch main; nenhuma nota foi movida, renomeada ou alterada.
Índice local: 1 nota indexada em 4 ms.

Obsidian: O cérebro é a pasta ~/cabecao, um clone novo do vault. Se o Obsidian abre este vault de outra pasta, ele continua abrindo aquela cópia, que não recebe o que os agentes gravam aqui: no Obsidian, use "Abrir pasta como cofre" (Open folder as vault) e escolha ~/cabecao. Depois de conferir que está tudo aqui, apague a cópia antiga ou deixe de usá-la.
...
Opcional:
  ...
  cabecao obsidian setup  Obsidian: grafo colorido por tipo, propriedades e
                          painéis
```

:::warning[Agora são duas pastas]
Depois do `init`, o seu cérebro é a pasta **nova**. A pasta antiga do vault continua onde estava e o Obsidian continua abrindo ela até você trocar: o que os agentes gravam vai para a pasta nova, e o que você escrever na antiga não chega aos agentes. No Obsidian, use **Abrir pasta como cofre** e escolha a pasta nova. Quando tiver conferido que está tudo lá, apague a antiga (ela é só mais um clone do mesmo repositório).
:::

Adotar o vault no lugar onde ele está, sem clonar, ainda não existe (está [em estudo](../em-breve.md)).

## O que muda no vault

Só arquivos novos ou completados, num commit:

| Arquivo | O que acontece |
| --- | --- |
| `.cabecao.json` | Criado, com as pastas de notas |
| `.gitignore` e `.gitattributes` | Completados com as linhas que faltam; o que você tinha fica |
| `AGENTS.md` e `CLAUDE.md` | Criados só se não existirem. Um `CLAUDE.md` seu fica como está; acrescente nele a linha `@AGENTS.md` |
| `index.md` | Se o vault já tem um, ele fica como está, e o catálogo do Cabeção vai para `cabecao-index.md` |
| `log.md` | Se o vault já tem um, o diário do Cabeção acrescenta linhas no fim dele |

As pastas de notas são `wiki`, `memory` e `raw` (onde o Cabeção grava notas novas; elas são criadas quando a primeira nota chega) mais as pastas do vault que já têm Markdown. No exemplo, `Diário` e `Projetos`:

```json
{
  "schemaVersion": 1,
  "noteDirs": [
    "wiki",
    "memory",
    "raw",
    "Diário",
    "Projetos"
  ],
  "indexMd": "index.md"
}
```

Se o vault tem notas soltas na raiz, a lista vira `["."]`: a raiz inteira.

## Suas notas antigas

Notas sem `type` continuam sendo notas. Elas aparecem na busca e no grafo como "sem tipo":

```text
$ cabecao search rúcula
2 resultado(s) para "rúcula", com todos os termos (validade em 2026-11-13):

1. 2026-11-01  [sem tipo]  vigente
   Diário/2026-11-01.md
   Plantei a «rúcula» hoje.

2. Lista de sementes  [sem tipo]  vigente
   Projetos/Lista de sementes.md › Lista de sementes
   - Alface - «Rúcula»

Relacionadas (vizinhas dos melhores resultados no grafo; fora da ordem acima):
- Horta comunitária  (Projetos/Horta comunitária.md)  ← link para Projetos/Lista de sementes.md

Modo: keyword (a busca por significado não está ativada neste cérebro ("cabecao embeddings on" ativa)).
```

Não precisa converter nada. Se quiser que uma nota antiga conte como decisão, preferência ou fato, acrescente o `type` (e o que mais fizer sentido) no frontmatter dela.

## Quando o init recusa

O `init` recusa um repositório que parece código (`package.json`, `src/` com código, `Cargo.toml` e outros marcadores) e um repositório sem `.obsidian/` em que menos de 80% do conteúdo seja Markdown ou anexo (imagens, PDFs, `.canvas`...). Nesses casos nada é criado nem alterado.

O guia de uso diário com o Obsidian está em [Usar com o Obsidian](./obsidian.md).
