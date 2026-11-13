---
title: Grafo, relações e fatos no tempo
description: Como as notas se ligam, o que é uma relação tipada, um fato e como a validade no tempo funciona.
sidebar:
  order: 3
---

As notas do cérebro formam um grafo. O Cabeção monta esse grafo no banco local a cada varredura, a partir do texto das notas: não há nada para manter à mão além dos próprios links.

## De onde vêm as ligações

| Ligação | Como você escreve | Exemplo |
| --- | --- | --- |
| Wikilink | `[[Nota]]` no corpo, como no Obsidian (também `[[Nota\|apelido]]`, `[[Nota#Seção]]` e `[[pasta/Nota]]`) | `O [[Projeto Atlas]] usa [[SQS]].` |
| Relação tipada | Uma propriedade do frontmatter com uma lista de wikilinks | `uses: ["[[SQS]]"]` |
| Substituição | `supersedes` e `superseded_by` | `supersedes: ["[[usar-rabbitmq-para-filas]]"]` |
| Fato | `subject` e `object` de uma nota `type: fact` | `subject: "[[Projeto Atlas]]"` |
| Menção sem link | Nada: o Cabeção acha o título (ou um `aliases`) de outra nota citado no texto | "a reunião sobre o Projeto Atlas" |

As menções sem link aparecem no `graph`, mas não sobem resultados na busca. Nomes curtos demais (menos de 3 letras), genéricos demais ("Projeto", "Ideias") ou de mais de uma nota não viram menção.

## Relações tipadas

Seis relações vêm prontas:

| Relação | Sentido |
| --- | --- |
| `uses` | usa |
| `part_of` | faz parte de |
| `depends_on` | depende de |
| `decided_by` | foi decidido por |
| `works_on` | trabalha em |
| `related_to` | tem relação com |

Cada uma é uma propriedade do frontmatter com uma lista de wikilinks, o que o Obsidian mostra como propriedade de lista:

```yaml
uses: ["[[SQS]]"]
decided_by: ["[[Ana Prado]]", "[[Bruno Tavares]]"]
part_of: ["[[Projeto Atlas]]"]
```

Para ter outras, acrescente os nomes em `relations` no [`.cabecao.json`](/cabecao/referencia/configuracao/), como `"relations": ["mentored_by"]`. Um agente acrescenta uma relação com a tool [`relate`](/cabecao/referencia/mcp/#relate).

## Fatos

Um fato é uma nota pequena com três partes: sujeito, predicado e objeto. O predicado é um identificador em minúsculas, como `uses_queue` ou `led_by`. O objeto pode ser outra nota ou um valor simples.

```yaml
type: fact
subject: "[[Projeto Atlas]]"
predicate: led_by
object: "[[Bruno Tavares]]"
valid_from: 2026-09-01
supersedes: ["[[fato-ana-lidera-atlas]]"]
```

Fatos guardam o que muda com o tempo (quem lidera, o que se usa, onde algo roda) sem apagar o que valia antes.

## Validade no tempo

Toda nota pode dizer quando vale:

| Campo | Significado |
| --- | --- |
| `valid_from` | Passa a valer nesta data (inclusive) |
| `valid_until` | Deixa de valer nesta data (exclusive): o que vale "até 03/05" e o que vale "a partir de 03/05" não se sobrepõem |
| `expires_at` | Vence nesta data, como um handoff que só importa por um mês |
| `supersedes` / `superseded_by` | Outra nota passou a substituir esta |

Numa data qualquer, cada nota fica em um de três estados:

- **vigente** (`current`);
- **vencida** (`expired`): passou de `valid_until` ou de `expires_at`, ou foi substituída;
- **ainda não vigente** (`not_yet_valid`): `valid_from` é depois da data.

Você não precisa preencher `valid_until` na nota antiga quando escreve a nova: basta o link `supersedes`. O Cabeção deriva a data da substituição a partir do `valid_from` (ou do `created`) da nota nova.

Notas vencidas **nunca somem** da busca: elas descem na lista e aparecem marcadas. Para perguntar sobre o passado, passe a data (`--as-of` na CLI, `as_of` no MCP):

```text
$ cabecao facts --subject "Projeto Atlas" --predicate led_by --as-of 2026-03-01
2 fato(s), validade em 2026-03-01:

1. Projeto Atlas · led_by · Ana Prado  vigente
   de 2026-01-12 até 2026-09-01   memory/facts/fato-ana-lidera-atlas.md
   substituído por: memory/facts/fato-bruno-lidera-atlas.md

2. Projeto Atlas · led_by · Bruno Tavares  AINDA NÃO VIGENTE
   de 2026-09-01 até em aberto   memory/facts/fato-bruno-lidera-atlas.md
   substitui: memory/facts/fato-ana-lidera-atlas.md
```

Mais exemplos, com a busca e o grafo, em [Buscar](/cabecao/guias/buscar/).

## Regras não são vencidas por agentes

Uma regra sua (`type: rule` em `memory/rules/`) só é substituída por outra regra sua. Se uma nota de agente disser `supersedes: ["[[sua-regra]]"]`, a regra continua vigente e continua no `recall`.
