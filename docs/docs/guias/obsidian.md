---
title: Usar com o Obsidian
description: Abra o cérebro como vault do Obsidian, configure o grafo, os painéis e o Web Clipper com um comando e exporte mapas do grafo.
sidebar_position: 1
---

O cérebro é uma pasta de Markdown com wikilinks, então o Obsidian o abre sem configuração nenhuma. O Obsidian é a janela para o cérebro: você lê, navega, corrige e vê o que os agentes escreveram. Ele é opcional; o Cabeção não precisa dele.

## Abrir o cérebro

1. No Obsidian, escolha **Abrir pasta como vault** ("Open folder as vault").
2. Selecione a pasta do cérebro (`~/cabecao`, ou a que você passou em `--dir`).

A pasta `.cabecao/`, onde ficam o banco e o índice desta máquina, começa com ponto: o Obsidian a esconde do explorador, da busca, dos backlinks e do grafo. Se você adotou um vault que já usava, ele continua abrindo como antes: o `init` não moveu nada.

## Configurar com um comando

```bash
cabecao obsidian setup
```

**Feche o Obsidian (ou só este vault) antes.** Aberto, ele ignora e regrava os arquivos de configuração quando você muda alguma coisa na interface ou fecha uma aba. O comando confere: se o Obsidian estiver rodando com este cérebro aberto, ele recusa gravar (a não ser com `--force`); se só um dos sinais aparecer, ele avisa.

O que o comando faz:

| Arquivo | O que recebe |
| --- | --- |
| `.obsidian/app.json` | Wikilinks (`useMarkdownLinks: false`) com o caminho mais curto, links atualizados ao renomear, anexos em `raw/assets` e `memory/_archive/` fora da busca e do grafo |
| `.obsidian/graph.json` | Um grupo de cor por tipo de nota e pela pasta dele (regras, fatos, decisões, conceitos, entidades, fontes, sínteses, memórias práticas, episódios e handoffs, fontes brutas, arquivo morto) e, num arquivo novo, `dashboards/` fora do grafo |
| `.obsidian/types.json` | Datas como data (`created`, `updated`, `confirmed`, `valid_from`, `valid_until`, `expires_at`, `published`), relações e `sources` como lista, e os campos de texto do Cabeção como texto |
| `dashboards/*.base` | Cinco painéis (veja abaixo) |
| `dashboards/cabecao-web-clipper.json` | O modelo do Web Clipper, para você importar na extensão |

Num cérebro sem `.obsidian/`, a saída é esta:

```text
$ cabecao obsidian setup
Obsidian: ~/cabecao
+ .obsidian/app.json (criado)
+ .obsidian/graph.json (criado)
+ .obsidian/types.json (criado)
+ dashboards/decisoes.base (criado)
+ dashboards/fatos.base (criado)
+ dashboards/memorias.base (criado)
+ dashboards/revisar.base (criado)
+ dashboards/saude.base (criado)
+ dashboards/cabecao-web-clipper.json (criado)
Pronto. Abra a pasta do cérebro no Obsidian ("Open folder as vault"). Para importar o modelo do Web Clipper:
extensão > Settings > Templates > Import > dashboards/cabecao-web-clipper.json. Para desfazer: "cabecao obsidian setup --remove".
```

Rodar de novo não muda nada:

```text
$ cabecao obsidian setup
Obsidian: ~/cabecao
= .obsidian/app.json (sem mudanças)
= .obsidian/graph.json (sem mudanças)
= .obsidian/types.json (sem mudanças)
= dashboards/decisoes.base (sem mudanças)
...
Nada a mudar: o cérebro já está configurado para o Obsidian.
```

### O que ele NÃO muda

O comando foi feito para um vault que já tem a sua configuração. Ele **só acrescenta** o que falta:

- nunca troca um valor seu: se você usa `"newLinkFormat": "relative"`, fica `relative`, e a saída diz que ficou;
- nunca tira nem reordena uma chave, um grupo de cor, um item de lista ou um tipo de propriedade seu; os grupos de cor do Cabeção entram **depois** dos seus, e no grafo o primeiro grupo que casa define a cor, então os seus continuam valendo;
- não reformata o arquivo: a edição mexe só no trecho acrescentado, e o resto fica byte a byte;
- não toca em `workspace.json` (estado das janelas), em `appearance.json`, em `core-plugins.json` nem em `.obsidian/plugins/`;
- não toca num JSON que não consegue ler: ele fica como está, e o comando sai com código 1;
- não substitui um painel que você editou.

Antes da primeira alteração de cada arquivo, o original vai para `.cabecao/backups/obsidian/<arquivo>.bak` (local, fora do git). Com `--dry-run`, o comando mostra a diferença de cada arquivo e não grava nada:

```text
$ cabecao obsidian setup --dry-run
Obsidian: ~/cabecao (simulação: nada foi gravado)
~ .obsidian/app.json (mesclado): chaves useMarkdownLinks, alwaysUpdateLinks, attachmentFolderPath; userIgnoreFilters += memory/_archive/
    mantido como você tinha: newLinkFormat = "relative" (o Cabeção sugere "shortest")
    --- a/.obsidian/app.json
    +++ b/.obsidian/app.json
    @@
       "newLinkFormat": "relative",
       "userIgnoreFilters": [
    -    "private/"
    +    "private/",
    +    "memory/_archive/"
       ],
    -  "promptDelete": false
    +  "promptDelete": false,
    +  "useMarkdownLinks": false,
    +  "alwaysUpdateLinks": true,
    +  "attachmentFolderPath": "raw/assets"
     }
...
~ .obsidian/types.json (mesclado): 24 tipo(s) de propriedade
    mantido como você tinha: created como "datetime" (o Cabeção sugere "date")
...
```

### Desfazer

```bash
cabecao obsidian setup --remove
```

Tira só o que o setup **desta máquina** acrescentou (o registro fica em `.cabecao/obsidian-setup.json`) e que continua com o valor que o Cabeção pôs: o que você mudou depois fica. Um arquivo que o Cabeção criou e que ninguém mexeu é apagado; os painéis e o modelo do Web Clipper saem se estiverem como foram gerados. Num vault que já tinha configuração, os três arquivos voltam byte a byte ao que eram.

Em outra máquina (sem o registro), volte pelos `.bak` de `.cabecao/backups/obsidian/` ou pelo histórico do git (`git log -- .obsidian`).

### Em outras máquinas

A pasta `.obsidian/` e a `dashboards/` vão para o remoto no próximo `cabecao sync`, como qualquer arquivo que o git não ignora. Na outra máquina, o `cabecao obsidian setup` não tem nada a mudar.

## O grafo

Abra com `Ctrl/Cmd + G`. As cores seguem o tipo da nota e, para as notas sem `type` (um vault adotado), a pasta. O arquivo morto (`memory/_archive/`) fica cinza-escuro e fora do grafo.

As relações do frontmatter (`uses: ["[[SQS]]"]`) viram arestas no grafo e backlinks, como qualquer link. O grafo do Obsidian não mostra o **tipo** da aresta; para ver os tipos, use o painel de propriedades da nota, os mapas abaixo ou peça ao agente (tool `graph`). Para ver o contexto de uma nota, abra o **grafo local** dela (menu `⋯` → **Open local graph**) com profundidade 2.

Um filtro útil na busca do grafo: `-path:raw -path:memory/episodes` mostra só o conhecimento consolidado.

## Painéis (Bases)

Os painéis usam o plugin nativo **Bases** do Obsidian (vem ligado num vault novo). Abra qualquer um em `dashboards/`:

| Painel | Mostra |
| --- | --- |
| `memorias.base` | Memórias ativas (sem episódios e handoffs), agrupadas por tipo e por escopo |
| `revisar.base` | Memórias com confiança baixa, nunca confirmadas, sem confirmação há mais de 180 dias ou editadas por agente (`edited_by`) |
| `decisoes.base` | Decisões vigentes, e todas por situação: vigente, vencida, ainda não vigente ou substituída |
| `fatos.base` | Fatos vigentes, vencidos e substituídos, com sujeito, predicado e objeto |
| `saude.base` | Cópias de conflito do sync pendentes, notas da wiki sem fonte, notas editadas por agente e notas órfãs |

Um painel é só uma consulta às propriedades das notas: ele não executa nada. Se você editar um painel, o `cabecao obsidian setup` passa a mantê-lo como está; para voltar ao do Cabeção, apague o arquivo e rode o comando de novo.

## Mapas (Canvas)

```bash
cabecao export canvas --node "Projeto Atlas" --depth 2
```

Gera um arquivo `.canvas` (JSON Canvas, o formato do Canvas do Obsidian) em `dashboards/`, com a vizinhança da nota: uma caixa por tipo de nota, com as mesmas cores do grafo, as notas em grade sem sobreposição e setas com o tipo da relação (`uses`, `part_of`, `supersedes`...). O mapa é editável: arraste, agrupe e anote.

```text
$ cabecao export canvas --node "Projeto Atlas" --depth 2
Mapa: dashboards/mapa-projeto-atlas.canvas
22 notas, 67 relações.
Abra no Obsidian; o arquivo vai para o remoto no próximo "cabecao sync".
```

Também dá para exportar um escopo (`--scope project:atlas`) ou o cérebro inteiro (sem `--node` nem `--scope`). Acima do limite (60 notas; até 500 com `--limit`), saem as notas mais longe e as menos ligadas, com aviso. Um mapa que já existe não é substituído sem `--force`, porque pode ter a sua arrumação. Detalhes na [referência](../referencia/cli.md#cabecao-export).

## Capturar da web (Web Clipper)

A extensão **Obsidian Web Clipper** salva uma página como Markdown. O `setup` grava em `dashboards/cabecao-web-clipper.json` um modelo que salva o recorte em `raw/articles/` com o frontmatter das fontes do Cabeção:

```yaml
title: "{{title}}"
source: "{{url}}"
author: "{{author}}"
published: AAAA-MM-DD
origin: ingest:web-clipper
trust: low
created: AAAA-MM-DD
```

Para importar: na extensão, **Settings** → escolha um modelo → **Import** → o arquivo `dashboards/cabecao-web-clipper.json`. Sem o `setup`, `cabecao obsidian clipper > cabecao-web-clipper.json` gera o mesmo arquivo.

Depois de salvar uma página, peça ao agente: "ingira o artigo que acabei de salvar em raw/articles/". A tool `ingest` lê a fonte (que já está em `raw/`, então nada é copiado) e devolve o plano do que escrever na wiki. Conteúdo de fora entra sempre com `trust: low`.

O modelo foi conferido contra o formato que o importador da extensão aceita, mas **não foi importado numa extensão de verdade** durante o desenvolvimento.

## Editar no Obsidian

Edite, crie e renomeie notas como sempre. O Cabeção percebe as mudanças sozinho:

- a busca e o `recall` leem o que está no disco (o índice local é atualizado antes de cada consulta);
- o próximo `cabecao sync` põe as suas edições num commit e envia.

| Quero... | Faço |
| --- | --- |
| Ver o que os agentes aprenderam | `memorias.base`, ou `log.md` |
| Corrigir uma memória errada | Edito a nota. O próximo sync a registra como edição manual |
| Resolver um conflito de sync | Abro `saude.base`, comparo `nota.md` com `nota.conflict-...md`, fico com o certo e apago o outro ([guia](./resolver-conflito.md)) |
| Editar relações | Painel de propriedades: cada relação é uma lista de links |

## Plugin Obsidian Git

Não é necessário: o `cabecao sync` faz o commit e o envio. Se você já usa o plugin:

- ele pode continuar fazendo commit na branch principal; o Cabeção reindexa o que mudou;
- **desligue o push e o pull automáticos dele** (deixe os intervalos em 0 e ligue "Disable push"), para não haver dois sincronizadores disputando o mesmo remoto;
- ele não cuida da branch de índice da busca por significado: só o `cabecao sync` envia os embeddings.

Essa convivência foi simulada com comandos git; o plugin em si não foi executado nos testes.

## O que o sync leva do Obsidian

Tudo o que o git não ignora, inclusive a pasta `.obsidian/` (temas, plugins, atalhos), para as outras máquinas abrirem o vault igual. O `.gitignore` do cérebro deixa de fora o estado das janelas, que muda a cada clique e só geraria conflito:

```text
.obsidian/workspace.json
.obsidian/workspace-mobile.json
```

Num cérebro antigo ou adotado sem essas linhas, `cabecao upgrade --template` as acrescenta (veja [Atualizar](./atualizar.md)).

## Cuidados

- **Não edite `index.md` nem `log.md`.** O primeiro é regenerado; o segundo só recebe linhas no fim.
- **Segredos**: se você colar uma senha ou um token numa nota, o sync bloqueia o envio e mostra o arquivo e a linha. Veja [Segurança e privacidade](../seguranca.md).
- **Agentes não mexem na configuração do Obsidian**: nenhuma tool do servidor MCP escreve em `.obsidian/` nem grava `.base` ou `.canvas`. Só você, pela CLI.
