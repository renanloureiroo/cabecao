---
title: Release notes
description: What changed in each published version of Cabeção.
---

Versions are published on npm with the `beta` tag. To update:

```bash
npm i -g cabecao@beta
```

## Not yet released

- **Behavior change: the CLI without a terminal runs as an agent.** Until now, every `cabecao` ran as you. Now the one running is **you** only when the process has a controlling terminal and there is no agent signal in the environment (`CLAUDECODE`, `CODEX_*`, `GEMINI_CLI`, `CURSOR_AGENT`, `AI_AGENT`, `CI`...); in any other case (an agent's Bash, a cron job, a script) it is an **agent**, under the same rules as the MCP server. No option or variable elevates to human; `--as <client>` only names the agent. In practice: a script of yours without a terminal now saves memories with `origin: agent:cli-agent`, `cabecao forget --yes` without a terminal is refused, and `embeddings on/off/switch`, `compact`, and `upgrade` only run at your terminal (they exit with code 4 outside it). Administration (`sync`, `status`, `doctor`, `init`, `schedule`, `install-client`, `mcp`, `recall --hook`) runs as before. See [Who is human and who is an agent in the CLI](./guias/humano-e-agente.md).
- **Rules and control files with your request (decision 37).** What was refused to an agent on grounds of authority (creating and editing rules, writing to `AGENTS.md`, `CLAUDE.md`, `log.md`, `.cabecao.json`..., changing `raw/` sources, saving `trust: high`, undoing one of your operations) is now allowed with your explicit request, confirmed by the same two-call token as `forget`. The result is marked (`approved_by: user`, `Cabecao-Approved` trailer), never becomes `origin: human`, and the new `agent_approved` rule of `lint` lists everything for you to review. The technical protections (outside the brain, `.git/`, symbolic links, secrets, forged frontmatter, conflict copies, `index.md`) still hold without exception. See [Security](./seguranca.md).
- **New CLI commands, with the tools' rules:** [`read`](./referencia/cli.md#cabecao-read), [`remember`](./referencia/cli.md#cabecao-remember), [`write`](./referencia/cli.md#cabecao-write), [`patch`](./referencia/cli.md#cabecao-patch), [`relate`](./referencia/cli.md#cabecao-relate), and [`handoff`](./referencia/cli.md#cabecao-handoff). They take content from an argument, a file, standard input, or a JSON with the tool's fields (`--json-input`), with the same limits, and return in `--json` the same output as the tool. An action that needs confirmation exits with code 3. This lets a skill use Cabeção through the CLI, without connecting the MCP server.
- **Obsidian in one command.** `cabecao obsidian setup` configures the vault: graph colors by note type, property types (dates as dates, relations as lists), the archive out of search, five `.base` dashboards in `dashboards/`, and the Web Clipper template, which saves clips to `raw/articles/` with `trust: low`. It only adds to what you already have, with `--dry-run`, a copy of the original and `--remove`. See [Using it with Obsidian](./guias/obsidian.md).
- **Graph maps.** [`cabecao export canvas`](./referencia/cli.md#cabecao-export) writes an Obsidian `.canvas` with the neighborhood of a note, a scope or the whole brain, grouped by type and with each relation type on the arrows.
- **Claude Desktop package.** An `.mcpb` attached to each version on GitHub installs the server with a double click, with the program bundled. See [Claude Desktop](./guias/claude-desktop.md).
- **`cabecao upgrade`.** Applies the brain's schema migrations with a restore point and one commit per migration (there are none pending today). With `--template`, it updates the betas' `AGENTS.md` and completes `.gitignore`, without overwriting what you edited. `status` and `doctor` warn about what is pending. See [Updating Cabeção](./guias/atualizar.md).
- **Sync across versions.** A machine with an older Cabeção applies and pushes nothing when the remote has already been migrated by a newer version; its changes stay in local commits until it is updated.
- **The memory lifecycle.** Five new MCP server tools and four CLI commands:
  - `handoff_save`: the handoff, with an expiry, plus the session's episode; `recall` delivers the project's latest handoff and warns when it was already delivered to another session.
  - `remember` handles duplicates and contradictions in the same scope and type: the same memory is skipped, one that complements updates, a fact with another object supersedes the old one, and the ambiguous case goes back to the agent to decide.
  - `ingest` and [`cabecao ingest`](./referencia/cli.md#cabecao-ingest): register a source in `raw/` with `trust: low` and return the ingestion plan.
  - `lint` and [`cabecao lint`](./referencia/cli.md#cabecao-lint): problem report by rules, read-only.
  - `forget` and [`cabecao forget`](./referencia/cli.md#cabecao-forget): archive in `memory/_archive/`, with confirmation; they never delete.
  - `consolidate` and [`cabecao consolidate`](./referencia/cli.md#cabecao-consolidate): maintenance with a restore point, closed in one commit that `undo` reverts entirely.
  - MCP prompts `ingest`, `review`, and `consolidate`.
- **Old memories never confirmed lose weight.** A preference, gotcha, or procedure without `confirmed` and not updated for 180 days ranks lower in search, without disappearing.
- **Claude Code plugin.** `/plugin marketplace add renanloureiroo/cabecao` and `/plugin install cabecao@cabecao` install the bundled MCP server (no `npx`), the brain's briefing at the start of every session, and a background sync at the end, plus the `cabecao:memory` skill. No hook captures the conversation. See [Claude Code plugin](./guias/claude-code.md).
- **Automatic sync.** `cabecao schedule on|off|status` registers a periodic sync with the system scheduler (LaunchAgent, user systemd timer or crontab, Task Scheduler), without administrator rights. See [Automatic sync](./guias/sync-automatico.md).
- **New commands:** `cabecao recall` shows a task's briefing in the terminal; `cabecao sync` gains `--detach` (background), `--hook`, and `--log`. `doctor` now checks the schedule.
- **More precise mentions.** A name attached to `_`, `/`, `\`, or `@` (such as `sqs_fila`, `filas/SQS`, or `ana@sqs`) no longer counts as an unlinked mention of another note.

## 0.1.0-beta.1

*November 12, 2026*

The graph and validity over time.

- **`graph`, `facts`, and `relate` tools** in the MCP server, which now has 12 tools. `graph` shows the neighbors of a note 1 or 2 hops away; `facts` lists facts and whether they are valid on a date, with the version chain; `relate` adds a typed relation between two notes.
- **`cabecao graph` and `cabecao facts` commands**, and the `--as-of` option in `cabecao search`.
- **Validity over time**: each result says whether the note is current, expired, or not yet valid on that date. Notes that are not valid move down the list, but never disappear. `as_of` in the `search`, `facts`, and `graph` tools answers questions about the past.
- **Replacement without `valid_until`**: the `supersedes` (or `superseded_by`) link is enough for the old note to count as expired from the date of the new one.
- **Typed relations**, one frontmatter property per relation (`uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to`), plus the ones you declare in `relations` in `.cabecao.json`.
- **Unlinked mentions**: the title or one of the `aliases` of another note quoted in the text becomes a link in the graph.
- **Related block in search**: up to 5 neighboring notes of the top results, with the reason, without changing the order.
- **Security**: an agent note that claims to replace a rule of yours does not override it; only another rule of yours can do that.

## 0.1.0-beta.0

*November 12, 2026*

The first published version.

- **`cabecao init` with the repository URL**, on any git provider: creates the brain in an empty repository, just downloads an existing brain, adopts an Obsidian vault without moving files, and refuses anything that is not a brain. Without a URL, it creates a local-only brain.
- **Git sync** of everything git does not ignore, with in-memory integration, a conflict copy instead of data loss, recovery from an interrupted sync, and protection for `.cabecao.json`.
- **Keyword search** in the local index (SQLite with Node's built-in FTS5).
- **MCP server** over stdio with 9 tools: `recall`, `search`, `read`, `status`, `remember`, `write_page`, `patch_page`, `sync`, and `undo`, plus resources and instructions for the agent.
- **Undo** through `git revert` of the last operation, a specific operation, or a whole agent session.
- **Secret scanner** on every write and before every push, with the `cabecao:allow-secret` marker for the user.
- **Agent restrictions**: they do not create rules, do not write to control files or client instruction files, and when they edit a note of yours they set `edited_by` and lower the `trust`.
- **`cabecao install-client`** for Claude Code, Claude Desktop, Codex, Cursor, VS Code, and Gemini CLI, preserving the rest of each client's file.
- **`cabecao doctor`** with the suggested fix for each problem, and **`cabecao status`**.
- A single package, with no runtime dependencies or native binaries. Requires Node.js 22.16+ or 24+ and git 2.38+.
