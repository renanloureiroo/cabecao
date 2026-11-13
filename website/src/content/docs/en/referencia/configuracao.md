---
title: .cabecao.json
description: The brain's configuration file, versioned and shared across machines.
sidebar:
  order: 3
---

`.cabecao.json` lives at the root of the brain. It marks the folder as a Cabeção brain and holds the configuration that applies to every machine: it goes into git and travels with the sync. What belongs to this machine only lives in [`~/.config/cabecao/config.json`](/cabecao/en/referencia/arquivos/#machine-configuration).

## The file in a new brain

```json
{
  "schemaVersion": 1,
  "noteDirs": [
    "wiki",
    "memory",
    "raw"
  ],
  "indexMd": "index.md"
}
```

## Fields

| Field | Type | Default | What it is |
| --- | --- | --- | --- |
| `schemaVersion` | integer | `1` | Version of the brain format. A brain with a higher version than this Cabeção understands asks you to update Cabeção |
| `noteDirs` | list of folders | `["wiki", "memory", "raw"]` | Where the notes live, relative to the root. `"."` is the whole root (an adopted vault with loose notes at the root). Hidden folders do not count |
| `indexMd` | `.md` path | `"index.md"` | Where the catalog is generated |
| `relations` | list of names | `[]` | Your own typed relations, in addition to the six built-in ones |
| `commit` | object | absent | The template for commit subjects |
| `embedding` | object | absent | Reserved for semantic search, [coming soon](/cabecao/en/em-breve/). It has no effect today |

Keys that Cabeção does not know are kept when it rewrites the file.

### relations

Names in lowercase letters, digits, and `_`, that do not match a frontmatter field (`id`, `type`, `title`, `scope`, `tags`...):

```json
{
  "schemaVersion": 1,
  "noteDirs": ["wiki", "memory", "raw"],
  "indexMd": "index.md",
  "relations": ["mentored_by", "blocks"]
}
```

Each name becomes an accepted frontmatter property (`mentored_by: ["[[Ana Prado]]"]`), an edge in the graph, and a `type` accepted by the `relate` tool and by `cabecao graph --type`.

### commit

The subject of the commits Cabeção makes. The default mimics the Obsidian Git plugin:

```json
{
  "commit": {
    "message": "vault backup: {{date}}",
    "dateFormat": "YYYY-MM-DD HH:mm:ss.SSS"
  }
}
```

Placeholders for `message`:

| Placeholder | Becomes |
| --- | --- |
| `{{date}}` | The date and time, in the `dateFormat` format and in the machine's time zone |
| `{{hostname}}` | The machine name |
| `{{numFiles}}` | How many files the commit changes |
| `{{action}}` | The action: `add`, `update`, `revert`, `edit`, `conflict`... |
| `{{session}}` | The first 8 characters of the agent session (empty for your own edits) |

`dateFormat` uses Moment.js tokens (`YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, `SSS`, `dddd`, `MMMM`...) and accepts literal text in square brackets, such as `[às] HH:mm`. Month and day names come out in English.

The body and the trailers (`Cabecao-Op`, `Cabecao-Session`...) do not change: `undo` depends on them. See [Commits and undo](/cabecao/en/conceitos/commits-e-undo/).

## When the file breaks

A `.cabecao.json` with invalid JSON or a wrong field makes `status`, `doctor`, and the tools point out the problem, with the fix.

The message is shown as printed, in Portuguese. It tells you to fix the brain's `.cabecao.json` (`git log -p -- .cabecao.json` shows earlier versions, including the last one that worked) or revert the change that broke it, and explains that `cabecao sync` keeps running with the last valid configuration in the history, so a fix made on another machine reaches you through it:

> Corrija o .cabecao.json do cérebro (é JSON; "git log -p -- .cabecao.json" mostra as versões anteriores, inclusive a última que funcionava) ou desfaça a mudança que o quebrou. O "cabecao sync" continua rodando com a última configuração válida do histórico, então uma correção feita em outra máquina chega por ele.

A broken version that arrives from the remote does not replace yours: it goes to `.cabecao.conflict-<máquina>-<data>.json`.
