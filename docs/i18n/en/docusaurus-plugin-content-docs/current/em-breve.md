---
title: Coming soon
description: What is planned or under study and does not exist in Cabeção yet.
---

:::note[Nothing on this page exists yet]
The items below are planned or under study. They may change shape, name, or order before they arrive. When they arrive, they go into the [release notes](./novidades.md) and the reference.
:::

## Under study

These experience changes have already been evaluated, but need a decision before they go in:

- **Adopting an Obsidian vault where it is**, without cloning it into a new folder, including a folder that is not a git repository yet. Today `init` clones the vault into a new folder, and you open that folder in Obsidian (see [Adopt an existing vault](./guias/adotar-vault.md)).
- **The plugin as the default path in Claude Code**, installed by `init` itself when Claude Code is on the machine. Today `init` registers the MCP server directly, and the plugin is installed separately.
- **Automatic sync turned on by `init`**. Today it only shows up among the optional steps at the end of `init`, `status` and `doctor` (`cabecao schedule on`).
- **A `cabecao setup`**: a list of what is on and what is missing (skills, automatic sync, semantic search, Obsidian), with a single question to apply the recommended setup.
- **CLI messages in English**, chosen by the system language. Today the CLI speaks Portuguese; the site and the READMEs are in both languages.

## Planned

- **Shell autocompletion** (`cabecao completion bash|zsh|fish|powershell`).
- **Consolidation scheduled by Cabeção itself**: `cabecao consolidate --run` already calls an agent on its own, but `cabecao schedule` only schedules the sync; today, scheduling the consolidation is done with the system scheduler (see [Consolidate with an agent](./guias/consolidar-com-agente.md#agendar)).
- **More agents in `consolidate --run`**: GitHub Copilot CLI and OpenCode have options to restrict tools, but have not been tested yet.
- **Delete for good** (`cabecao purge`): remove a note from the git history, for the rare case of something that should never have been there. Today `forget` archives, and the archived note stays in git.
- **Graph explorer inside Claude**, to browse notes and relations in a window of the conversation.
- **More from the answer provider** ([`ask`](./guias/respostas-com-modelo.md) itself already exists): topic summaries and consolidation help written by the provider, always under the same restrictions as an agent; a model that runs embedded, with no server; and semantic search with Ollama.

Want to follow along or share your opinion? Open an [issue](https://github.com/renanloureiroo/cabecao/issues).
