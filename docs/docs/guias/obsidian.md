---
title: Usar com o Obsidian
description: Abra o cérebro como vault do Obsidian, edite à vontade e deixe o cabecao sync levar as mudanças.
sidebar_position: 1
---

O cérebro é uma pasta de Markdown com wikilinks, então o Obsidian o abre sem nenhuma configuração. O Cabeção não precisa do Obsidian, e o Obsidian não precisa saber do Cabeção.

## Abrir o cérebro

1. No Obsidian, escolha **Abrir pasta como vault**.
2. Selecione a pasta do cérebro (`~/cabecao`, ou a que você passou em `--dir`).

Se você adotou um vault que já usava, ele continua abrindo como antes: o `init` não moveu nada.

## O que você vê

- **Notas e wikilinks** como em qualquer vault. As notas que os agentes gravam são arquivos comuns em `wiki/` e `memory/`.
- **Propriedades**: o frontmatter aparece no painel de propriedades. As relações tipadas (`uses`, `part_of`...) são listas de links, então o Obsidian as mostra como links clicáveis.
- **Visão de grafo**: os wikilinks e as relações aparecem como arestas.
- **`index.md`** com o catálogo de todas as notas, e **`log.md`** com uma linha por operação.

## Editar no Obsidian

Edite, crie e renomeie notas como sempre. O Cabeção percebe as mudanças sozinho:

- a busca e o `recall` leem o que está no disco (o índice local é atualizado antes de cada consulta);
- o próximo `cabecao sync` põe as suas edições num commit (com `Cabecao-Client: manual`) e envia.

```text
$ cabecao status
...
  Mudanças feitas fora do Cabeção, esperando o sync: 1
```

Você não precisa do plugin Obsidian Git: o `cabecao sync` faz o commit e o envio. Rode-o quando terminar de editar, ou peça ao agente para chamar a tool `sync`.

## O que o sync leva do Obsidian

Tudo o que o git não ignora, inclusive a pasta `.obsidian/` (temas, plugins, atalhos), para as outras máquinas abrirem o vault igual. O `.gitignore` do cérebro já deixa de fora o estado das janelas, que muda a cada clique e só geraria conflito:

```text
.obsidian/workspace.json
.obsidian/workspace-mobile.json
```

Para não levar outra coisa (o cache de um plugin, por exemplo), acrescente a linha no `.gitignore` do cérebro.

## Cuidados

- **Não edite `index.md` nem `log.md`.** O primeiro é regenerado; o segundo só recebe linhas no fim.
- **Segredos**: se você colar uma senha ou um token numa nota, o sync bloqueia o envio e mostra o arquivo e a linha. Veja [Segurança e privacidade](../seguranca.md).
- **Cópias de conflito** (`*.conflict-*.md`) aparecem no vault como notas comuns. Junte e apague; veja [Resolver um conflito](./resolver-conflito.md).

Uma integração mais próxima com o Obsidian está nos planos; veja [Em breve](../em-breve.md).
