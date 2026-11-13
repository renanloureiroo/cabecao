<p align="center">
  <strong>🧠 Cabeção</strong><br/>
  <em>Your personal second brain, in Markdown and git, for you and your AI agents.</em>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">Português</a>
</p>

> **Status: 🚧 beta.** Published on npm as [`cabecao@beta`](https://www.npmjs.com/package/cabecao). Commands and file formats may still change before 1.0.

---

*Cabeção* ("big head") is a nod to a character from the Brazilian TV show *Malhação* who knows and remembers everything.

## What it is

A **personal second brain** that lives in **a git repository you own**, on any host (GitHub, GitLab, Bitbucket, Gitea, your own server), exposed to any AI agent over **MCP**. Use it on as many machines as you like: everything syncs, embeddings and graph included.

- 📝 **Markdown is the source of truth.** Read and edit in Obsidian or any editor.
- 🔗 **Any git remote.** No provider API, pull requests or CI required.
- 🔄 **Syncs everything git does not ignore.** Today: notes, attachments and configuration. Planned (milestone 2): embeddings and graph, so a machine never recomputes what another already computed.
- 🔎 **Search** by keyword (today) and, in milestone 2, also by meaning, with a local model (nothing leaves your machine).
- 🕸️ **A wiki with a graph** (milestone 3, under review on `feat/m3-grafo`): wikilinks, typed relations, unlinked mentions and time-bounded facts the agent can navigate.
- 🧠 **Agent memory:** what you taught in one session is there in the next, in any client.
- ↩️ **Reversible:** every operation is a commit, with an undo command.
- 🪶 **Light:** a 241 kB packed package (about 840 kB installed) with no runtime or native dependencies; `cabecao --version` takes about 26 ms. The embedding model (milestone 2) will be downloaded only when you turn on semantic search.

## Install

> **You cannot install from npm yet.** The `cabecao` package has not been published, so `npx cabecao` will only work after publication. Until then, run it from the repository: `pnpm install && pnpm build`, then `node packages/cli/dist/cabecao.mjs init <url>`.

Once published, you only provide the repository URL:

```bash
npx cabecao init git@gitlab.com:you/my-brain.git
```

| The repository... | What happens |
|---|---|
| is empty | scaffolds the brain, makes the first commit and pushes |
| already holds a Cabeção brain | downloads it and builds the local index (from milestone 2, without recomputing embeddings) |
| holds an Obsidian vault or plain Markdown | adopts it without moving any file |
| holds something else (code, for example) | refuses and explains |

With no URL it creates a local-only brain. It then registers the MCP server in the clients it finds (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Gemini CLI).

Requirements: Node.js 22.16+ (24 recommended) and git 2.38+.

> ⚠️ **Cabeção's code is public; your brain should not be.** Use a **private** repository.

## License

[MIT](LICENSE) © Renan Pereira Loureiro
