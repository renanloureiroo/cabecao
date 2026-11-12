<p align="center">
  <strong>🧠 Cabeção</strong><br/>
  <em>Your personal second brain, in Markdown and git, for you and your AI agents.</em>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">Português</a>
</p>

> **Status: 🚧 foundation in place, features in progress.** The monorepo, CI and a minimal CLI (`cabecao --version`) exist; commands arrive in milestone 1. Every architecture decision was tested in a proof of concept before entering the plan. See the [evidence](docs/11-evidencias.md) and [roadmap](docs/10-roadmap.md) (Portuguese for now).

---

*Cabeção* ("big head") is a nod to a character from the Brazilian TV show *Malhação* who knows and remembers everything.

## What it is

A **personal second brain** that lives in **a git repository you own**, on any host (GitHub, GitLab, Bitbucket, Gitea, your own server), exposed to any AI agent over **MCP**. Use it on as many machines as you like: everything syncs, embeddings and graph included.

- 📝 **Markdown is the source of truth.** Read and edit in Obsidian or any editor.
- 🔗 **Any git remote.** No provider API, pull requests or CI required.
- 🔄 **Everything syncs.** A machine never recomputes an embedding another machine already computed.
- 🔎 **Hybrid search** by keyword and by meaning, with a local model (nothing leaves your machine).
- 🕸️ **A wiki with a graph:** wikilinks, typed relations and time-bounded facts the agent can navigate.
- 🧠 **Agent memory:** what you taught in one session is there in the next, in any client.
- ↩️ **Reversible:** every operation is a commit, with an undo command.
- 🪶 **Light:** a ~160 KB package with no native dependencies. The embedding model is downloaded only when you turn on semantic search.

## Planned install

You only provide the repository URL:

```bash
npx cabecao init git@gitlab.com:you/my-brain.git
```

| The repository... | What happens |
|---|---|
| is empty | scaffolds the brain, makes the first commit and pushes |
| already holds a Cabeção brain | downloads it and builds the index without recomputing anything |
| holds an Obsidian vault or plain Markdown | adopts it without moving any file |
| holds something else (code, for example) | refuses and explains |

Requirements: Node.js 22.16+ (24 recommended) and git 2.38+.

> ⚠️ **Cabeção's code is public; your brain should not be.** Use a **private** repository.

## License

[MIT](LICENSE) © Renan Pereira Loureiro
