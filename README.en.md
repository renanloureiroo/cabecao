<p align="center">
  <strong>🧠 Cabeção</strong><br/>
  <em>A local-first second brain for you and your AI agents, served over MCP.</em>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">Português</a>
</p>

> **Status: 🚧 planning.** The architecture, decisions and roadmap are public in [`docs/`](docs/) (Portuguese for now; English docs are on the roadmap). There is no installable release yet.

---

*Cabeção* ("big head") is a nod to a well-known character from the Brazilian TV show *Malhação*, the one who knows and remembers everything. That is the idea: an external brain that **remembers for you and for your agents** across sessions, tools and machines.

## What it is

Cabeção is a **second brain stored as Markdown in a git repository**, on your machine and optionally in a private GitHub repo. It exposes that brain to any AI agent (Claude Code, Claude Desktop, Codex, Cursor...) through an **MCP server**.

- 📝 **Markdown is the source of truth.** Read and edit everything in Obsidian (or any editor).
- 🔎 **Hybrid search:** keyword (BM25) + semantic (embeddings) + link-graph expansion, under a token budget.
- 🕸️ **Knowledge graph:** wikilinks, typed relations, entities and **time-bounded facts**.
- 🧠 **Agent memory:** `remember`/`recall` with scope, type, provenance and conflict resolution (ADD/UPDATE/SUPERSEDE).
- 🔄 **Syncs everything**, including **embeddings, graph and indexes**, through git, so nothing computed on one machine has to be recomputed on another.
- 🧹 **Self-maintaining:** lint, consolidation and forgetting. Changes arrive as **Pull Requests** for you to review.
- 🔒 **Local-first and private:** local embeddings by default, a secret scanner, and external content marked as untrusted.
- 🔌 **Modern MCP:** targets spec **2026-07-28** (stateless core) and stays compatible with 2025-era clients.
- 🖥️ **Visual:** Obsidian (graph, Bases, Canvas) plus an **MCP App** graph explorer inside Claude.

## How it works

```
 Claude Code · Claude Desktop · Codex · Cursor            Obsidian
             │ MCP (stdio / local HTTP)                      │
             ▼                                               ▼
 ┌───────────────────── cabecao (daemon + MCP) ─────────────────────┐
 │ search · read · write · remember · recall · graph · facts ·      │
 │ ingest · handoff · lint · consolidate · sync                     │
 └──────────┬──────────────────────────────────────┬───────────────┘
            ▼                                      ▼
  Your brain's git repository             .cabecao/cache/cabecao.db
  ├─ raw/  wiki/  memory/   (content)     (SQLite: FTS5 + sqlite-vec +
  └─ .cabecao/ embeddings/ graph/          graph tables; rebuilt
     (synced derived data)                  incrementally)
            │
            ▼ cabecao sync (pull → incremental reindex → push)
     GitHub (your PRIVATE brain repo)
```

## Planned install

```bash
npx cabecao@latest init
```

The wizard scaffolds the brain, sets up git and (optionally) a private GitHub repo, configures local embeddings, registers the MCP server with your clients, sets up Obsidian, and runs `cabecao doctor`.

Also planned: a **Claude Code plugin** (`/plugin marketplace add renanloureiroo/cabecao`) and a one-click **MCPB** bundle for Claude Desktop.

> ⚠️ **Cabeção's code is public; your brain should not be.** Keep your brain repository **private**.

## License

[MIT](LICENSE) © Renan Pereira Loureiro
