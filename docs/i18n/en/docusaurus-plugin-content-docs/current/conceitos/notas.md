---
title: Note types and frontmatter
description: The 12 note types, what each one is for and the frontmatter Cabeção writes.
sidebar_position: 2
---

Every note is a `.md` file with a YAML frontmatter block at the top. The `type` field says what the note is and, therefore, which folder it lives in.

## The 12 types

| `type` | Folder | What for |
| --- | --- | --- |
| `source` | `wiki/sources/` | Summary of a source (a meeting, an article), pointing to the original in `raw/` |
| `concept` | `wiki/concepts/` | An idea or technique: idempotency, message queue |
| `entity` | `wiki/entities/` | A concrete thing: person, project, company, tool |
| `decision` | `wiki/decisions/` | A decision **and the why**, with the date it took effect |
| `synthesis` | `wiki/syntheses/` | A text that combines several notes into an overview |
| `rule` | `memory/rules/` | A rule every agent follows. **An agent only creates it with your explicit request.** |
| `preference` | `memory/preferences/` | How you like things to be done |
| `gotcha` | `memory/gotchas/` | A gotcha: what went wrong and how to avoid it |
| `procedure` | `memory/procedures/` | A repeated step-by-step |
| `fact` | `memory/facts/` | An atomic fact (subject, predicate, object) with a validity period |
| `episode` | `memory/episodes/AAAA/MM/` | The record of something that happened on a date |
| `handoff` | `memory/handoffs/` | The end of a session: what was done, what is left, where it stopped |

## A wiki note

A decision from the example brain, with typed relations and an earlier version that it supersedes:

```markdown
---
id: 01KNWQPCCGW9YN4PHGN519T4H6
type: decision
title: Usar SQS para filas
scope: project:atlas
tags: [infra, filas]
sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]
trust: high
origin: agent:claude-code
created: 2026-05-03
updated: 2026-11-10
confirmed: 2026-11-10
valid_from: 2026-05-03
valid_until:
supersedes: ["[[usar-rabbitmq-para-filas]]"]
superseded_by: []
expires_at:
uses: ["[[SQS]]"]
decided_by: ["[[Ana Prado]]", "[[Bruno Tavares]]"]
part_of: ["[[Projeto Atlas]]"]
depends_on: ["[[Idempotência]]"]
---
# Usar SQS para filas

O [[Projeto Atlas]] migrou do [[RabbitMQ]] para o [[SQS]] por custo de operação.
```

## A fact

Facts do not need a title: Cabeção shows `sujeito predicado objeto` (subject, predicate, object).

```markdown
---
id: 01KWE9TKFRS0SE22ZDN9SJEEPP
type: fact
subject: "[[Projeto Atlas]]"
predicate: led_by
object: "[[Bruno Tavares]]"
valid_from: 2026-09-01
valid_until:
supersedes: ["[[fato-ana-lidera-atlas]]"]
superseded_by: []
trust: high
origin: human
created: 2026-09-01
updated: 2026-09-01
---
Bruno Tavares lidera o Projeto Atlas desde setembro de 2026.
```

## Fields Cabeção takes care of

When the write goes through Cabeção (an agent over MCP or through the CLI), `id`, `created`, `updated`, `origin`, `edited_by`, `approved_by` and `approved_at` are filled in by it; the agent does not choose these values. The `id` is a [ULID](https://github.com/ulid/spec): 26 uppercase characters that do not change if the note is renamed.

In a note you write by hand (in Obsidian, for example), the most important field is `type`: it tells Cabeção what the note is. Without an `id`, the note is still indexed and searchable, identified by its path; `status` counts it among the notes "without an id". A note with neither `id` nor `type` is treated as a loose note, outside the schema, and also shows up in search.

Fields that Cabeção does not know are preserved. You can have your own Obsidian properties.

## Scope

`scope` separates what applies everywhere from what applies to one project:

- `global`: always applies (the default for notes saved by agents);
- `project:<nome>`: applies to one project, like `project:atlas`.

A search or a `recall` with `project:atlas` brings the project's notes **and** the global ones.

The list of all fields, with the format of each one, is in the [frontmatter reference](../referencia/frontmatter.md).
