---
title: Frontmatter
description: Every field in a note's frontmatter, with its format and who fills it in.
sidebar_position: 4
---

The frontmatter is the YAML block between `---` at the top of the note. Cabeção writes the known fields in a fixed order; fields it does not know are preserved.

## Identity and type

| Field | Format | Notes |
| --- | --- | --- |
| `id` | ULID: 26 uppercase characters | Filled in by Cabeção on a write. It does not change if the note is renamed. Optional in a note written by hand |
| `type` | one of the 12 types | `source`, `concept`, `entity`, `decision`, `synthesis`, `rule`, `preference`, `gotcha`, `procedure`, `fact`, `episode`, `handoff` |
| `title` | text | Required, except in `fact` |
| `aliases` | list of text | Other names for the note, as in Obsidian. They are also used to find unlinked mentions |

## Facts

Only in `type: fact`, and required there.

| Field | Format | Example |
| --- | --- | --- |
| `subject` | wikilink | `"[[Projeto Atlas]]"` |
| `predicate` | lowercase identifier, with `_` | `led_by`, `uses_queue` |
| `object` | wikilink or simple value (text, number, boolean) | `"[[Bruno Tavares]]"` |

## Organization

| Field | Format | Notes |
| --- | --- | --- |
| `scope` | `global` or `project:<nome>` | Recommended. A search with `project:x` also brings the global notes |
| `tags` | list of text | |
| `sources` | list of wikilinks | Where the content came from: `["[[raw/meetings/2026-05-03-arquitetura]]"]` |

## Provenance

| Field | Format | Notes |
| --- | --- | --- |
| `origin` | `human`, `agent:<cliente>`, or `ingest:<fonte>` | On an agent write, Cabeção fills it in and ignores the value sent |
| `trust` | `high`, `medium`, or `low` | Default by origin: `human` → `high`, agent → `medium`, `ingest` → `low`. An agent only writes `high` with the user's explicit request |
| `edited_by` | `agent:<cliente>` | The last agent that changed a note that was not created by an agent |
| `approved_by`, `approved_at` | `user` and the date | Written by Cabeção when an agent writes or changes the note with the user's confirmation; the ones the agent sends are ignored |
| `private` | `true` | The note is never sent to an [`ask`](../guias/respostas-com-modelo.md) answer provider, nor is its name when another note cites it. It works in any case (`Private`) and with any true value (`yes`, `on`, `sim`, `1`, `[true]`); the `private` tag (or `private/...`) in `tags` or `tag`, and `#private` in the body, have the same effect ([what counts as a private note](../guias/respostas-com-modelo.md#what-counts-as-a-private-note)). It does not change search or what an agent reads through the tools |

Cabeção also writes `forget_reason` in the note archived by `forget` and, in a source registered in `raw/` by `ingest`, `ingested_by` (and `source` and `author`, when they come from the source).

See [Provenance and trust](../conceitos/proveniencia.md).

## Dates

All in ISO format `AAAA-MM-DD` (time is optional and counts by the day).

| Field | Meaning |
| --- | --- |
| `created` | When the note was created. Filled in by Cabeção |
| `updated` | The last change. Filled in by Cabeção |
| `confirmed` | The last time someone checked that the note still holds |
| `valid_from` | Becomes valid on this date (inclusive). Recommended for facts |
| `valid_until` | Stops being valid on this date (exclusive) |
| `expires_at` | Expires on this date. Useful for handoffs |

`valid_until` cannot come before `valid_from`.

## Replacement

| Field | Format | Meaning |
| --- | --- | --- |
| `supersedes` | list of wikilinks | This note replaces those |
| `superseded_by` | list of wikilinks | This note was replaced by those |

One side is enough. The replaced note counts as expired starting from the `valid_from` (or the `created`) of the note that replaces it. A rule of yours can only be replaced by another rule of yours.

## Typed relations

Lists of wikilinks, one property per relation: `uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to`, and the ones you declare in `relations` in [`.cabecao.json`](./configuracao.md#relations).

```yaml
uses: ["[[SQS]]"]
part_of: ["[[Projeto Atlas]]"]
```

A single `relations:` property with a map is not used; each relation is its own property.

## What is an error and what is a warning

| Situation | |
| --- | --- |
| Frontmatter that is not valid YAML | Error |
| Unknown `type`; `id` that is not a ULID; invalid or out-of-order date; `scope`, `trust`, or `origin` in the wrong format; relation that is not a list of wikilinks; `rule` with an `origin` other than `human` and without `approved_by: user` | Error |
| Missing `scope`, `trust`, `origin`, `created`, or `updated` (or `valid_from` in a fact) | Warning |
| Note with neither `id` nor `type` | Warning: it is a loose note, outside the schema, but it stays in search |
| File in `raw/` without `id` | Accepted as is |

An agent write with an error is refused (`invalid_note`), and nothing is written. A note of yours with an error stays on disk and in the index, the way you left it.
