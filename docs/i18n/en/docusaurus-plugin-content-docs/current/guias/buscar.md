---
title: Search
description: Keyword search, questions about the past with --as-of, a note's graph, and facts.
sidebar_position: 5
---

The examples on this page use the repository's sample brain (`fixtures/vault`), with made-up data: Lumen Logística, Projeto Atlas, Ana Prado, and Bruno Tavares.

## By keyword

```text
$ cabecao search "filas" --type decision
2 resultado(s) para "filas", com todos os termos (validade em 2026-11-12):

1. Usar SQS para filas  [decision · project:atlas]  vigente
   wiki/decisions/usar-sqs-para-filas.md › Usar SQS para filas
   O [[Projeto Atlas]] migrou do [[RabbitMQ]] para o [[SQS]] por custo de operação.

2. Usar RabbitMQ para filas  [decision · project:atlas]  VENCIDO
   wiki/decisions/usar-rabbitmq-para-filas.md › Usar RabbitMQ para filas
   …Veja [[usar-sqs-para-«filas»]].

Relacionadas (vizinhas dos melhores resultados no grafo; fora da ordem acima):
- Mensageria no Projeto Atlas  (wiki/syntheses/Mensageria no Projeto Atlas.md)  ← related_to para wiki/decisions/usar-sqs-para-filas.md
- Projeto Atlas  (wiki/entities/Projeto Atlas.md)  ← part_of de wiki/decisions/usar-sqs-para-filas.md
- Idempotência  (wiki/concepts/Idempotência.md)  ← depends_on de wiki/decisions/usar-sqs-para-filas.md
- SQS  (wiki/entities/SQS.md)  ← uses de wiki/decisions/usar-sqs-para-filas.md
- Ana Prado  (wiki/entities/Ana Prado.md)  ← decided_by de wiki/decisions/usar-sqs-para-filas.md

Modo: keyword (a busca por significado não está ativada neste cérebro ("cabecao embeddings on" ativa)).
```

How to read it:

- Each result shows the title, type, scope, whether it is in effect on the date, the path (with the section, after `›`), and an excerpt with the terms between `«»`.
- Search first tries notes with **all** the terms. If none has them, it says so and switches to accepting **any** of the terms: `3 resultado(s) para "kafka lumen", com algum dos termos (nenhuma nota tinha todos) (validade em 2026-11-12):`.
- Case and accents do not matter.
- Expired notes show up, lower down and marked. Archived notes (`memory/_archive/`) do not show up.
- The **Relacionadas** (related) block lists up to 5 notes linked in the graph to the best results, with the reason. It does not change the order of the list.

Filters:

| Option | Example |
| --- | --- |
| `--type <tipo>` | `--type gotcha,handoff` (repeat it or separate with commas) |
| `--scope <escopo>` | `--scope project:atlas` returns the project and the global notes; `--scope global`, only the global ones |
| `--limit <n>` | From 1 to 100 (default: 10) |
| `--mode <modo>` | `auto` (default), `keyword`, `semantic` or `hybrid` |

Without search by meaning, search is by keyword: it finds the word, not the topic. If it does not find anything, try a synonym or the exact name. With search by meaning turned on ([`cabecao embeddings on`](../referencia/cli.md#cabecao-embeddings)), the `auto` mode combines keyword and meaning. The last line of the output says which mode was used and why.

## Questions about the past

`--as-of` computes validity on a date. The decision that was in effect on that date moves up:

```text
$ cabecao search "filas" --type decision --as-of 2026-03-01
2 resultado(s) para "filas", com todos os termos (validade em 2026-03-01):

1. Usar RabbitMQ para filas  [decision · project:atlas]  vigente
   wiki/decisions/usar-rabbitmq-para-filas.md › Usar RabbitMQ para filas
   …Veja [[usar-sqs-para-«filas»]].

2. Usar SQS para filas  [decision · project:atlas]  AINDA NÃO VIGENTE
   wiki/decisions/usar-sqs-para-filas.md › Usar SQS para filas
   O [[Projeto Atlas]] migrou do [[RabbitMQ]] para o [[SQS]] por custo de operação.
```

(The related block was omitted.) For the agent, the same question is the `as_of` parameter in the `search`, `facts`, and `graph` tools.

## Facts

```text
$ cabecao facts --subject "Projeto Atlas"
4 fato(s), validade em 2026-11-12:

1. Projeto Atlas · led_by · Bruno Tavares  vigente
   de 2026-09-01 até em aberto   memory/facts/fato-bruno-lidera-atlas.md
   substitui: memory/facts/fato-ana-lidera-atlas.md

2. Projeto Atlas · uses_queue · SQS  vigente
   de 2026-05-03 até em aberto   memory/facts/fato-atlas-usa-sqs.md
   substitui: memory/facts/fato-atlas-usa-rabbitmq.md

3. Projeto Atlas · uses_queue · RabbitMQ  VENCIDO
   de 2026-01-14 até 2026-05-03   memory/facts/fato-atlas-usa-rabbitmq.md
   substituído por: memory/facts/fato-atlas-usa-sqs.md

4. Projeto Atlas · led_by · Ana Prado  VENCIDO
   de 2026-01-12 até 2026-09-01   memory/facts/fato-ana-lidera-atlas.md
   substituído por: memory/facts/fato-bruno-lidera-atlas.md
```

Filter by `--subject`, `--predicate`, and `--object` (a note's title, path, or id, or a value), and combine them with `--as-of`. Expired facts come last.

## A note's graph

`cabecao graph` shows the notes linked to a note: typed relations, wikilinks, facts, supersessions, and unlinked mentions, with the direction of each link and whether it is in effect on the date. You can give the note by its title, path, or id.

```text
$ cabecao graph "SQS" --depth 2 --type uses,part_of
SQS  [entity]  vigente
wiki/entities/SQS.md
Vizinhos até 2 salto(s), validade em 2026-11-12, só uses, part_of:

Ligados direto:
  Usar SQS para filas  [decision]  vigente
    wiki/decisions/usar-sqs-para-filas.md
    wiki/decisions/usar-sqs-para-filas.md —uses→ wiki/entities/SQS.md
  Projeto Atlas  [entity]  vigente
    wiki/entities/Projeto Atlas.md
    wiki/entities/Projeto Atlas.md —uses→ wiki/entities/SQS.md

A dois saltos:
  Migração dos consumidores para leitura em lote  [episode]  vigente
    memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md
    memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md —part_of→ wiki/entities/Projeto Atlas.md
  Testes de integração falham sem limpar o banco  [gotcha]  vigente
    memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md
    memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md —part_of→ wiki/entities/Projeto Atlas.md
  Atlas, consumidores em lote  [handoff]  vigente
    memory/handoffs/2026-11-10-atlas-consumidores.md
    memory/handoffs/2026-11-10-atlas-consumidores.md —part_of→ wiki/entities/Projeto Atlas.md
  Publicar nova versão do Atlas  [procedure]  vigente
    memory/procedures/publicar-nova-versao-do-atlas.md
    memory/procedures/publicar-nova-versao-do-atlas.md —part_of→ wiki/entities/Projeto Atlas.md
  Lumen Logística  [entity]  vigente
    wiki/entities/Lumen Logística.md
    wiki/entities/Projeto Atlas.md —part_of→ wiki/entities/Lumen Logística.md
  Reunião de arquitetura 2026-05-03  [source]  vigente
    wiki/sources/Reunião de arquitetura 2026-05-03.md
    wiki/sources/Reunião de arquitetura 2026-05-03.md —part_of→ wiki/entities/Projeto Atlas.md
  Mensageria no Projeto Atlas  [synthesis]  vigente
    wiki/syntheses/Mensageria no Projeto Atlas.md
    wiki/syntheses/Mensageria no Projeto Atlas.md —part_of→ wiki/entities/Projeto Atlas.md
  Usar RabbitMQ para filas  [decision]  VENCIDO
    wiki/decisions/usar-rabbitmq-para-filas.md
    wiki/decisions/usar-rabbitmq-para-filas.md —part_of→ wiki/entities/Projeto Atlas.md (VENCIDO)
```

`--type` accepts the typed relations, `supersedes`, `wikilink`, `fact`, and `mention`. Unlinked mentions show who cites a note without `[[...]]`:

```text
$ cabecao graph "RabbitMQ" --type mention,related_to
RabbitMQ  [entity]  vigente
wiki/entities/RabbitMQ.md
Vizinhos até 1 salto(s), validade em 2026-11-13, só mention, related_to:

Ligados direto:
  Reunião de arquitetura 2026-05-03  [source]  vigente
    wiki/sources/Reunião de arquitetura 2026-05-03.md
    wiki/sources/Reunião de arquitetura 2026-05-03.md —related_to→ wiki/entities/RabbitMQ.md
  Projeto Atlas uses_queue SQS  [fact]  vigente
    memory/facts/fato-atlas-usa-sqs.md
    memory/facts/fato-atlas-usa-sqs.md —mention→ wiki/entities/RabbitMQ.md
  Reunião de arquitetura — 03/05/2026  [sem tipo]  vigente
    raw/meetings/2026-05-03-arquitetura.md
    raw/meetings/2026-05-03-arquitetura.md —mention→ wiki/entities/RabbitMQ.md
```

A heavily linked note gets a truncated answer, with a warning. Filter by relation type to see the rest.

## For scripts

Every command accepts `--json`, with structured output (`{ "ok": true, "command": "search", "data": { ... } }`), the same that the MCP tools return.
