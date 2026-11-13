---
title: Using it with Obsidian
description: Open the brain as an Obsidian vault, set up the graph, dashboards and Web Clipper with one command, and export graph maps.
sidebar_position: 1
---

The brain is a folder of Markdown with wikilinks, so Obsidian opens it with no configuration at all. Obsidian is the window into the brain: you read, browse, fix and see what the agents wrote. It is optional; Cabeção does not need it.

## Open the brain

1. In Obsidian, choose **Open folder as vault**.
2. Select the brain folder (`~/cabecao`, or the one you passed in `--dir`).

The `.cabecao/` folder, where this machine's database and index live, starts with a dot: Obsidian hides it from the file explorer, search, backlinks and graph. If you adopted a vault you already used, it opens as before: `init` did not move anything.

## Set it up with one command

```bash
cabecao obsidian setup
```

**Close Obsidian (or just this vault) first.** While open, it ignores and rewrites its configuration files when you change something in the interface or close a tab. The command checks: if Obsidian is running with this brain open, it refuses to write (unless you pass `--force`); if only one of the signs shows up, it warns you.

What the command does:

| File | What it gets |
| --- | --- |
| `.obsidian/app.json` | Wikilinks (`useMarkdownLinks: false`) with the shortest path, links updated on rename, attachments in `raw/assets`, and `memory/_archive/` out of search and graph |
| `.obsidian/graph.json` | One color group per note type and its folder (rules, facts, decisions, concepts, entities, sources, syntheses, practical memories, episodes and handoffs, raw sources, archive) and, in a new file, `dashboards/` out of the graph |
| `.obsidian/types.json` | Dates as dates (`created`, `updated`, `confirmed`, `valid_from`, `valid_until`, `expires_at`, `published`), relations and `sources` as lists, and Cabeção's text fields as text |
| `dashboards/*.base` | Five dashboards (see below) |
| `dashboards/cabecao-web-clipper.json` | The Web Clipper template, for you to import into the extension |

On a brain without `.obsidian/`, the output is this (the CLI speaks Portuguese; the diff of each configuration file was shortened):

```text
$ cabecao obsidian setup
Obsidian: ~/cabecao
+ .obsidian/app.json (criado)
    --- a/.obsidian/app.json
    +++ b/.obsidian/app.json
    @@
    +{
    +  "newLinkFormat": "shortest",
    ...
+ .obsidian/graph.json (criado)
    ...
+ .obsidian/types.json (criado)
    ...
+ dashboards/decisoes.base (criado)
+ dashboards/fatos.base (criado)
+ dashboards/memorias.base (criado)
+ dashboards/revisar.base (criado)
+ dashboards/saude.base (criado)
+ dashboards/cabecao-web-clipper.json (criado)
Pronto. Abra a pasta do cérebro no Obsidian ("Open folder as vault"). Para importar o modelo do Web Clipper:
extensão > Settings > Templates > Import > dashboards/cabecao-web-clipper.json. Para desfazer: "cabecao obsidian setup --remove".
```

Running it again changes nothing:

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

### What it does NOT change

The command was made for a vault that already has your configuration. It **only adds** what is missing:

- it never replaces a value of yours: if you use `"newLinkFormat": "relative"`, it stays `relative`, and the output says so;
- it never removes or reorders a key, color group, list item or property type of yours; Cabeção's color groups go **after** yours, and in the graph the first group that matches sets the color, so yours keep winning;
- it does not reformat the file: the edit touches only the added part, and the rest stays byte for byte;
- it does not touch `workspace.json` (window state), `appearance.json`, `core-plugins.json` or `.obsidian/plugins/`;
- it does not touch a JSON file it cannot read: it stays as is, and the command exits with code 1;
- it does not replace a dashboard you edited.

Before the first change to each file, the original goes to `.cabecao/backups/obsidian/<file>.bak` (local, outside git). With `--dry-run`, the command shows the same diff of each file and writes nothing:

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

### Undo

```bash
cabecao obsidian setup --remove
```

Removes only what the setup **on this machine** added (the record lives in `.cabecao/obsidian-setup.json`) and that still has the value Cabeção put there: whatever you changed afterwards stays. A file Cabeção created and nobody touched is deleted; the dashboards and the Web Clipper template are removed if they are still as generated. On a vault that already had configuration, the three files go back byte for byte to what they were.

On another machine (without the record), go back through the `.bak` files in `.cabecao/backups/obsidian/` or through git history (`git log -- .obsidian`).

### On other machines

The `.obsidian/` and `dashboards/` folders go to the remote on the next `cabecao sync`, like any file git does not ignore. On the other machine, `cabecao obsidian setup` has nothing to change.

## The graph

Open it with `Ctrl/Cmd + G`. Colors follow the note type and, for notes without a `type` (an adopted vault), the folder. The archive (`memory/_archive/`) is dark gray and out of the graph.

Frontmatter relations (`uses: ["[[SQS]]"]`) become graph edges and backlinks, like any link. Obsidian's graph does not show the **type** of an edge; to see the types, use the note's properties panel, the maps below, or ask the agent (the `graph` tool). To see the context of a note, open its **local graph** (`⋯` menu → **Open local graph**) with depth 2.

A useful filter in the graph search: `-path:raw -path:memory/episodes` shows only consolidated knowledge.

## Dashboards (Bases)

The dashboards use Obsidian's built-in **Bases** plugin (on by default in a new vault). Open any of them in `dashboards/`:

| Dashboard | Shows |
| --- | --- |
| `memorias.base` | Active memories (without episodes and handoffs), grouped by type and by scope |
| `revisar.base` | Memories with low trust, never confirmed, not confirmed in more than 180 days, or edited by an agent (`edited_by`) |
| `decisoes.base` | Current decisions, and all of them by status: current, expired, not yet valid or superseded |
| `fatos.base` | Current, expired and superseded facts, with subject, predicate and object |
| `saude.base` | Pending sync conflict copies, wiki notes without a source, notes edited by an agent, and orphan notes |

A dashboard is just a query over the notes' properties: it does not run anything. If you edit a dashboard, `cabecao obsidian setup` keeps it as is from then on; to get Cabeção's version back, delete the file and run the command again.

## Maps (Canvas)

```bash
cabecao export canvas --node "Projeto Atlas" --depth 2
```

Writes a `.canvas` file (JSON Canvas, the format of Obsidian's Canvas) to `dashboards/`, with the note's neighborhood: one box per note type, with the same colors as the graph, notes in a grid with no overlap, and arrows labeled with the relation type (`uses`, `part_of`, `supersedes`...). The map is editable: drag, group and annotate.

```text
$ cabecao export canvas --node "Projeto Atlas" --depth 2
Mapa: dashboards/mapa-projeto-atlas.canvas
22 notas, 67 relações.
Abra no Obsidian; o arquivo vai para o remoto no próximo "cabecao sync".
```

You can also export a scope (`--scope project:atlas`) or the whole brain (without `--node` or `--scope`). Above the limit (60 notes; up to 500 with `--limit`), the farthest and least connected notes are left out, with a warning. An existing map is not replaced without `--force`, because it may have your arrangement. Details in the [reference](../referencia/cli.md#cabecao-export).

## Clipping from the web (Web Clipper)

The **Obsidian Web Clipper** extension saves a page as Markdown. `setup` writes to `dashboards/cabecao-web-clipper.json` a template that saves the clip to `raw/articles/` with the frontmatter of Cabeção sources:

```yaml
title: "{{title}}"
source: "{{url}}"
author: "{{author}}"
published: YYYY-MM-DD
origin: ingest:web-clipper
trust: low
created: YYYY-MM-DD
```

To import it: in the extension, **Settings** → pick a template → **Import** → the file `dashboards/cabecao-web-clipper.json`. Without `setup`, `cabecao obsidian clipper > cabecao-web-clipper.json` writes the same file.

After saving a page, ask the agent: "ingest the article I just saved in raw/articles/". The `ingest` tool reads the source (already in `raw/`, so nothing is copied) and returns the plan of what to write in the wiki. Outside content always comes in with `trust: low`.

The template was checked against the format the extension's importer accepts, but it **was not imported into a real extension** during development.

## Editing in Obsidian

Edit, create and rename notes as usual. Cabeção notices the changes by itself:

- search and `recall` read what is on disk (the local index is updated before each query);
- the next `cabecao sync` puts your edits in a commit and pushes.

| I want to... | I do |
| --- | --- |
| See what the agents learned | `memorias.base`, or `log.md` |
| Fix a wrong memory | Edit the note. The next sync records it as a manual edit |
| Resolve a sync conflict | Open `saude.base`, compare `note.md` with `note.conflict-...md`, keep the right one and delete the other ([guide](./resolver-conflito.md)) |
| Edit relations | Properties panel: each relation is a list of links |

## The Obsidian Git plugin

It is not needed: `cabecao sync` commits and pushes. If you already use the plugin:

- it can keep committing on the main branch; Cabeção reindexes what changed;
- **turn off its automatic push and pull** (set the intervals to 0 and enable "Disable push"), so there are not two syncers competing for the same remote;
- it does not handle the semantic search index branch: only `cabecao sync` pushes the embeddings.

This coexistence was simulated with git commands; the plugin itself was not run in the tests.

## What sync carries from Obsidian

Everything git does not ignore, including the `.obsidian/` folder (themes, plugins, hotkeys), so the other machines open the vault the same way. The brain's `.gitignore` leaves out the window state, which changes with every click and would only cause conflicts:

```text
.obsidian/workspace.json
.obsidian/workspace-mobile.json
```

On an old or adopted brain without these lines, `cabecao upgrade --template` adds them (see [Updating](./atualizar.md)).

## Cautions

- **Do not edit `index.md` or `log.md`.** The first is regenerated; the second only gets lines at the end.
- **Secrets**: if you paste a password or a token into a note, sync blocks the push and shows the file and line. See [Security and privacy](../seguranca.md).
- **Agents do not touch Obsidian's configuration**: no MCP server tool writes to `.obsidian/` or writes `.base` or `.canvas` files. Only you, through the CLI.
