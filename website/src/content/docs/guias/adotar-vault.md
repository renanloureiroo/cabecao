---
title: Adotar um vault existente
description: Transforme um vault do Obsidian (ou uma pasta de Markdown) num cérebro do Cabeção sem mover nenhum arquivo.
sidebar:
  order: 7
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

O `init` clona o repositório numa pasta nova: ele recusa uma pasta que já existe e não está vazia. Na máquina onde o vault já mora, escolha outra pasta com `--dir` (ou mova a original para o lado) e rode o `init` com a URL:

```text
$ cabecao init git@github.com:voce/vault-obsidian.git --dir ~/Obsidian/Notas --machine notebook
...
Pasta do cérebro: ~/Obsidian/Notas (máquina notebook)

Repositório: Vault adotado sem mover nenhum arquivo: .cabecao.json, .gitattributes, .gitignore, AGENTS.md, CLAUDE.md acrescentados ou completados e enviados na branch main.

Índice local: 3 notas indexadas em 7 ms.
...
Próximos passos:
  - Nada foi movido: o Obsidian continua abrindo o vault como antes.
  - Em outra máquina, rode cabecao init git@github.com:voce/vault-obsidian.git.
```

Depois, no Obsidian, abra a pasta nova como vault. A antiga pode ser apagada quando você tiver conferido que está tudo lá.

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
```

Não precisa converter nada. Se quiser que uma nota antiga conte como decisão, preferência ou fato, acrescente o `type` (e o que mais fizer sentido) no frontmatter dela.

## Quando o init recusa

O `init` recusa um repositório que parece código (`package.json`, `src/` com código, `Cargo.toml` e outros marcadores) e um repositório sem `.obsidian/` em que menos de 80% do conteúdo seja Markdown ou anexo (imagens, PDFs, `.canvas`...). Nesses casos nada é criado nem alterado.

O guia de uso diário com o Obsidian está em [Usar com o Obsidian](/cabecao/guias/obsidian/).
