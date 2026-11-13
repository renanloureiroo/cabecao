---
title: Buscar
description: Busca por palavra-chave, perguntas sobre o passado com --as-of, o grafo de uma nota e os fatos.
sidebar:
  order: 5
---

Os exemplos desta página usam o cérebro de exemplo do repositório (`fixtures/vault`), com dados inventados: a Lumen Logística, o Projeto Atlas, Ana Prado e Bruno Tavares.

## Por palavra-chave

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
```

Como ler:

- Cada resultado traz título, tipo, escopo, se vale na data, o caminho (com a seção, depois de `›`) e um trecho com os termos entre `«»`.
- A busca tenta primeiro as notas com **todos** os termos. Se nenhuma tiver, ela diz e passa a aceitar **algum** dos termos: `3 resultado(s) para "kafka lumen", com algum dos termos (nenhuma nota tinha todos)`.
- Maiúsculas e acentos não importam.
- Notas vencidas aparecem, mais abaixo e marcadas. Notas arquivadas (`memory/_archive/`) não aparecem.
- O bloco **Relacionadas** lista até 5 notas ligadas no grafo aos melhores resultados, com o motivo. Ele não muda a ordem da lista.

Filtros:

| Opção | Exemplo |
| --- | --- |
| `--type <tipo>` | `--type gotcha,handoff` (repita ou separe por vírgula) |
| `--scope <escopo>` | `--scope project:atlas` traz o projeto e as notas globais; `--scope global`, só as globais |
| `--limit <n>` | De 1 a 100 (padrão: 10) |

A busca é por palavra-chave: ela acha a palavra, não o assunto. Se não achar, tente um sinônimo ou o nome exato. A busca por significado está [a caminho](/cabecao/em-breve/).

## Perguntas sobre o passado

`--as-of` calcula a validade numa data. A decisão que valia naquela data sobe:

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

(O bloco de relacionadas foi omitido.) Para o agente, a mesma pergunta é o parâmetro `as_of` nas tools `search`, `facts` e `graph`.

## Fatos

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

Filtre por `--subject`, `--predicate` e `--object` (título, caminho ou id de uma nota, ou um valor), e combine com `--as-of`. Os vencidos aparecem por último.

## O grafo de uma nota

`cabecao graph` mostra as notas ligadas a uma nota: relações tipadas, wikilinks, fatos, substituições e menções sem link, com a direção de cada ligação e se ela vale na data. A nota pode ser dada pelo título, pelo caminho ou pelo id.

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

`--type` aceita as relações tipadas, `supersedes`, `wikilink`, `fact` e `mention`. As menções sem link mostram quem cita uma nota sem `[[...]]`:

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

Uma nota muito ligada tem a resposta cortada, com aviso. Filtre por tipo de relação para ver o resto.

## Para scripts

Todo comando aceita `--json`, com a saída estruturada (`{ "ok": true, "command": "search", "data": { ... } }`), a mesma que as tools do MCP devolvem.
