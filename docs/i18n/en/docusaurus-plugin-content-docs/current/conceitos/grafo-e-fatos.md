---
title: Graph, relations and facts over time
description: How notes link to each other, what a typed relation and a fact are, and how time validity works.
sidebar_position: 3
---

The notes in the brain form a graph. Cabeção builds this graph in the local database on every scan, from the text of the notes: there is nothing to maintain by hand besides the links themselves.

## Where links come from

| Link | How you write it | Example |
| --- | --- | --- |
| Wikilink | `[[Nota]]` in the body, as in Obsidian (also `[[Nota\|apelido]]`, `[[Nota#Seção]]` and `[[pasta/Nota]]`) | `O [[Projeto Atlas]] usa [[SQS]].` |
| Typed relation | A frontmatter property with a list of wikilinks | `uses: ["[[SQS]]"]` |
| Supersession | `supersedes` and `superseded_by` | `supersedes: ["[[usar-rabbitmq-para-filas]]"]` |
| Fact | `subject` and `object` of a `type: fact` note | `subject: "[[Projeto Atlas]]"` |
| Unlinked mention | Nothing: Cabeção finds the title (or an `aliases` entry) of another note mentioned in the text | "the meeting about Projeto Atlas" |

Unlinked mentions show up in `graph`, but they do not boost search results. Names that are too short (fewer than 3 letters), too generic ("Project", "Ideas") or shared by more than one note do not become mentions.

## Typed relations

Six relations come built in:

| Relation | Meaning |
| --- | --- |
| `uses` | uses |
| `part_of` | is part of |
| `depends_on` | depends on |
| `decided_by` | was decided by |
| `works_on` | works on |
| `related_to` | is related to |

Each one is a frontmatter property with a list of wikilinks, which Obsidian shows as a list property:

```yaml
uses: ["[[SQS]]"]
decided_by: ["[[Ana Prado]]", "[[Bruno Tavares]]"]
part_of: ["[[Projeto Atlas]]"]
```

To have others, add the names to `relations` in [`.cabecao.json`](../referencia/configuracao.md), like `"relations": ["mentored_by"]`. An agent adds a relation with the [`relate`](../referencia/mcp.md#relate) tool.

## Facts

A fact is a small note with three parts: subject, predicate and object. The predicate is a lowercase identifier, like `uses_queue` or `led_by`. The object can be another note or a plain value.

```yaml
type: fact
subject: "[[Projeto Atlas]]"
predicate: led_by
object: "[[Bruno Tavares]]"
valid_from: 2026-09-01
supersedes: ["[[fato-ana-lidera-atlas]]"]
```

Facts store what changes over time (who leads, what is used, where something runs) without erasing what was true before.

## Time validity

Any note can say when it applies:

| Field | Meaning |
| --- | --- |
| `valid_from` | Becomes valid on this date (inclusive) |
| `valid_until` | Stops being valid on this date (exclusive): what is valid "until May 3" and what is valid "from May 3" do not overlap |
| `expires_at` | Expires on this date, like a handoff that only matters for a month |
| `supersedes` / `superseded_by` | Another note has replaced this one |

On any given date, each note is in one of three states:

- **current** (`current`);
- **expired** (`expired`): past `valid_until` or `expires_at`, or superseded;
- **not yet valid** (`not_yet_valid`): `valid_from` is after the date.

You do not need to fill in `valid_until` on the old note when you write the new one: the `supersedes` link is enough. Cabeção derives the supersession date from the new note's `valid_from` (or `created`).

Expired notes **never disappear** from search: they move down the list and show up marked. To ask about the past, pass the date (`--as-of` in the CLI, `as_of` over MCP):

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

More examples, with search and the graph, in [Search](../guias/buscar.md).

## Agents cannot supersede rules

A rule of yours (`type: rule` in `memory/rules/`) can only be superseded by another rule of yours. If an agent's note says `supersedes: ["[[sua-regra]]"]`, the rule stays current and stays in `recall`.
