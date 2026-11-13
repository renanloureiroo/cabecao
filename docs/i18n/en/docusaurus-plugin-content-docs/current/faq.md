---
title: Frequently asked questions
description: Short answers to the most common questions about Cabeção.
---

## Is it a GraphRAG?

Not in the usual sense. A GraphRAG usually uses a language model to extract entities and relations from documents and build a separate graph. Cabeção does not use a model to build the graph: it comes from what is already in the notes (wikilinks, typed relations in the frontmatter, facts, replacements, and mentions of other notes' titles), and the notes remain the source of truth. The one reasoning about the search is the agent you already use; if you want a ready answer with checked citations, turn on [`ask`](./guias/respostas-com-modelo.md), which is optional.

## Do I need GitHub?

No. Any git remote works: GitHub, GitLab, Bitbucket, Gitea, Codeberg, your own server over SSH, or even a folder on another disk. Cabeção does not use any provider's API, only git. And you can use it with no remote at all, only on your machine.

## Does my data go to any server?

Only to the git remote you configured, when you (or an agent) run the sync. Cabeção has no server of its own, no account, and no telemetry. What an agent reads from the brain becomes part of the conversation with your client's AI model, like any other text. Details in [Security and privacy](./seguranca.md).

The only exception is optional: if you turn on [answers with a language model](./guias/respostas-com-modelo.md) (`cabecao llm on`), each `ask` sends passages from your notes to the provider you chose (or to a server on your machine, such as Ollama). It is off by default; private notes (`private: true`, the `private` or `private/...` tag, or `#private` in the body), their names and passages with secrets never leave, and an agent neither sees nor chooses the provider.

## Does it work without Obsidian?

Yes. Obsidian is optional: the notes are Markdown files that any editor opens, and agents use the brain through MCP. Obsidian is just a good way to read and browse. See [Use with Obsidian](./guias/obsidian.md).

## Which AI clients work?

Any client that speaks MCP over stdio. `install-client` registers the server automatically in Claude Code, Claude Desktop, Codex, Cursor, VS Code, Antigravity, and Gemini CLI. For another client, `cabecao install-client --print` shows the configuration to copy.

## Will the agent fill the brain with junk?

It saves what the instructions ask for (what is durable and non-obvious) and what you ask for. Everything becomes a commit tagged with the session, so `cabecao undo --list` shows what went in and `cabecao undo --session <id>` removes a whole session. A rule only goes in with your explicit, confirmed request. See [What to remember](./guias/o-que-lembrar.md).

## Can I use the same brain across several projects?

Yes. Use `scope: project:<nome>` for anything that only applies to one project. A search or a `recall` with a project scope brings the project notes and the global notes.

## What if I stop using Cabeção?

Nothing changes in your notes: they are Markdown in a git repository. Run `cabecao uninstall`: it removes from this machine the registrations in the clients, the skills, the scheduled sync, the configuration and the cache, never the brain. Then, if you want, delete the brain's `.cabecao/` folder (this machine's database, index and locks, outside git). The rest is yours.

## Why "Cabeção"?

It is a tribute to Cabeção from *Malhação*.
