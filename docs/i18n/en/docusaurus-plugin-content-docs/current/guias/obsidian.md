---
title: Use with Obsidian
description: Open the brain as an Obsidian vault, edit freely, and let cabecao sync carry the changes.
sidebar_position: 1
---

The brain is a folder of Markdown with wikilinks, so Obsidian opens it without any setup. Cabeção does not need Obsidian, and Obsidian does not need to know about Cabeção.

## Open the brain

1. In Obsidian, choose **Open folder as vault**.
2. Select the brain folder (`~/cabecao`, or the one you passed in `--dir`).

If you adopted a vault you were already using, it keeps opening as before: `init` did not move anything.

## What you see

- **Notes and wikilinks**, as in any vault. The notes that agents write are regular files in `wiki/` and `memory/`.
- **Properties**: the frontmatter shows up in the properties panel. Typed relations (`uses`, `part_of`...) are lists of links, so Obsidian shows them as clickable links.
- **Graph view**: wikilinks and relations show up as edges.
- **`index.md`** with the catalog of all notes, and **`log.md`** with one line per operation.

## Edit in Obsidian

Edit, create, and rename notes as usual. Cabeção picks up the changes on its own:

- search and `recall` read what is on disk (the local index is updated before each query);
- the next `cabecao sync` puts your edits in a commit (with `Cabecao-Client: manual`) and pushes them.

```text
$ cabecao status
...
  Mudanças feitas fora do Cabeção, esperando o sync: 1
```

You do not need the Obsidian Git plugin: `cabecao sync` commits and pushes. Run it when you finish editing, or ask the agent to call the `sync` tool.

## What sync carries from Obsidian

Everything git does not ignore, including the `.obsidian/` folder (themes, plugins, hotkeys), so the other machines open the vault the same way. The brain's `.gitignore` already leaves out the window state, which changes with every click and would only cause conflicts:

```text
.obsidian/workspace.json
.obsidian/workspace-mobile.json
```

To leave something else out (a plugin's cache, for example), add the line to the brain's `.gitignore`.

## Things to watch

- **Do not edit `index.md` or `log.md`.** The first is regenerated; the second only gets lines appended at the end.
- **Secrets**: if you paste a password or a token into a note, sync blocks the push and shows the file and line. See [Security and privacy](../seguranca.md).
- **Conflict copies** (`*.conflict-*.md`) show up in the vault as regular notes. Merge them and delete them; see [Resolve a conflict](./resolver-conflito.md).

A closer integration with Obsidian is planned; see [Coming soon](../em-breve.md).
