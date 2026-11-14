---
title: Release notes
description: What changed in each published version of Cabeção.
---

Versions are published on npm. To update:

```bash
npm i -g cabecao
```

## 1.1.0

The terminal is nicer to use. Nothing changes for scripts and agents: color, animation, and lists only appear when the output is a terminal.

- **`init` shows each step.** It opens with the Cabeção symbol in the brand color and shows each step on one line, which ends in `✓` with the result; the final summary is shorter. See [Create or connect a brain](./comecar/init.md).
- **Questions as lists.** The questions in `llm on`, `embeddings on`, `uninstall`, `forget`, and `upgrade` are now lists you choose from with the arrow keys (`↑` `↓`, a number, or `j`/`k`; Enter confirms, Esc cancels), with a short hint next to each option. In `llm on`, the notice about what leaves the machine fits in four lines, with the full text one Enter away.
- **Plain text where it matters.** In a pipe, with `--json`, for an agent, with `NO_COLOR` set, or with `TERM=dumb`, everything stays in plain text and the questions go back to one line. The help (`--help`) still has no color. See the [CLI reference](./referencia/cli.md).
- **The Node version, said one way.** Everywhere, "22.16 or newer". The accepted range has not changed; on the 23 line, the message explains why it does not work.

## 1.0.0

The first stable version, published without a tag: `npm i -g cabecao` installs the newest version. From it on, the commands, the MCP server tools, and the brain format follow semantic versioning: an incompatible change only in a major version. Besides what came in the betas (below), it brings the graph with validity over time, semantic search, the memory lifecycle, the CLI under the same rules as the MCP server (which now has 17 tools, plus `ask` when you turn on a provider), the skills, the Claude Code plugin, automatic sync, the Obsidian integration, and answers with a language model, optional.

- **The graph and validity over time.** [`graph`](./referencia/mcp.md#graph), [`facts`](./referencia/mcp.md#facts), and [`relate`](./referencia/mcp.md#relate) tools in the MCP server; [`cabecao graph`](./referencia/cli.md#cabecao-graph) and [`cabecao facts`](./referencia/cli.md#cabecao-facts) commands, and the `--as-of` option in `cabecao search`. Each result says whether the note is current, expired, or not yet valid on that date; notes that are not valid move down the list, but never disappear. `as_of` in the `search`, `facts`, and `graph` tools answers questions about the past.
  - **Replacement without `valid_until`**: the `supersedes` (or `superseded_by`) link is enough for the old note to count as expired from the date of the new one.
  - **Typed relations**, one frontmatter property per relation (`uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to`), plus the ones you declare in `relations` in `.cabecao.json`.
  - **Unlinked mentions**: the title or one of the `aliases` of another note quoted in the text becomes a link in the graph. A name attached to `_`, `/`, `\`, or `@` (such as `sqs_fila`, `filas/SQS`, or `ana@sqs`) does not count as a mention.
  - **Related block in search**: up to 5 neighboring notes of the top results, with the reason, without changing the order.
  - **Security**: an agent note that claims to replace a rule of yours does not override it; only another rule of yours can do that.
- **Semantic search, synced.** [`cabecao embeddings on`](./referencia/cli.md#cabecao-embeddings) installs the runtime on demand and computes the embeddings with a local model you choose; search gains the `keyword`, `semantic`, and `hybrid` modes (`--mode`, and `mode` in the `search` tool); the vectors go to the `cabecao/index` branch and are pushed together with the content, so a second machine recomputes nothing. New commands: `embeddings`, `compact`, `eval`, and `reindex`. Search warns when there are passages still without a vector (notes saved after the last sync), which in that search only show up by keyword until the next sync computes them.

- **Cabeção skills.** Five skills by intent (look up, remember, pass the baton, maintenance on request, and actions with an explicit request) teach the agent to use the brain through the CLI, without the MCP server, under the same rules. [`cabecao install-skills`](./referencia/cli.md#cabecao-install-skills) installs them in the detected agents (Claude Code, Codex, Cursor, VS Code, Antigravity, Gemini CLI), per user or in the project, without overwriting a skill you edited; `--instructions` shows a block to paste into the `AGENTS.md` of an agent without skills. The Claude Code plugin brings the same skills. See [Use Cabeção with skills](./guias/skills.md).
- **The end of `init` leads to the first success.** It ends with "Pronto", what was configured in each agent, a "Teste agora" block with what to ask the agent, and up to three detected optional steps (skills, automatic sync, semantic search, Obsidian), each with its command. `status` and `doctor` repeat the pending optional steps. See [Create or connect a brain](./comecar/init.md).
- **`cabecao uninstall`.** Removes from this machine the registrations in the clients, the skills, the scheduled sync, the configuration and the cache, never the brain; it shows what will be removed and asks (only you, in the terminal); `--dry-run` only shows. See [Update and uninstall](./guias/atualizar.md).
- **Better help.** Every command has examples, the general help groups the commands, the text respects the terminal width (80 columns without a terminal), and a command, option, subcommand or client with a typo gets a suggestion ("você quis dizer").
- **A more precise `doctor`.** It shows the version and the update command for your installation; warns when the Claude Code plugin and the server's direct registration are active together (the tools twice); flags a Node recorded in a client's registration that no longer exists (nvm, fnm, Volta); treats the identity git makes up (without `user.email`) as a warning; checks the installed skills; and merges into one line the semantic search warnings that share a cause.
- **Clearer error messages.** Permission denied, read-only disk and full disk say what happened and what to do, without the raw system text; sync no longer says the edits are in commits when committing them failed; missing git says how to install it; no internal states or references to internal documents in the text.
- **The update hint knows how Cabeção was installed** (npm, pnpm, npx, project, plugin) and uses the version's channel (`@latest` on a stable version, `@beta` on a beta). The `npx` registration pins the version (`npx -y cabecao@<versão> mcp`).
- **The sentence about the adopted vault tells the truth**: `init` clones the vault into a new folder, and that is the folder Obsidian has to open. See [Adopt an existing vault](./guias/adotar-vault.md).
- **Answers with a language model, optional.** [`cabecao ask`](./referencia/cli.md#cabecao-ask) and the [`ask`](./referencia/mcp.md#ask) tool answer with citations checked by Cabeção (an invented citation is dropped; with no valid one, "the brain does not have this"), using the provider you turn on with [`cabecao llm on`](./referencia/cli.md#cabecao-llm): Claude Code installed, the Anthropic, OpenAI, Gemini, OpenRouter and Groq APIs, or a local server (Ollama, LM Studio). Off by default: nothing leaves the machine until you turn it on. Notes with `private: true` and passages with secrets never leave, and `.cabecao.json` gains `llm_policy`. `eval` gains `--answers`. See [Answers with a language model](./guias/respostas-com-modelo.md).
- **Behavior change: the CLI without a terminal runs as an agent.** Until now, every `cabecao` ran as you. Now the one running is **you** only when the process has a controlling terminal and there is no agent signal in the environment (`CLAUDECODE`, `CODEX_*`, `GEMINI_CLI`, `CURSOR_AGENT`, `AI_AGENT`, `CI`...); in any other case (an agent's Bash, a cron job, a script) it is an **agent**, under the same rules as the MCP server. No option or variable elevates to human; `--as <client>` only names the agent. In practice: a script of yours without a terminal now saves memories with `origin: agent:cli-agent`, `cabecao forget --yes` without a terminal is refused, and `embeddings on/off/switch`, `compact`, and `upgrade` only run at your terminal (they exit with code 4 outside it). Administration (`sync`, `status`, `doctor`, `init`, `schedule`, `install-client`, `mcp`, `recall --hook`) runs as before. See [Who is human and who is an agent in the CLI](./guias/humano-e-agente.md).
- **Rules and control files with your request.** What was refused to an agent on grounds of authority (creating and editing rules, writing to `AGENTS.md`, `CLAUDE.md`, `log.md`, `.cabecao.json`..., changing `raw/` sources, saving `trust: high`, undoing one of your operations) is now allowed with your explicit request, confirmed by the same two-call token as `forget`. The result is marked (`approved_by: user`, `Cabecao-Approved` trailer), never becomes `origin: human`, and the new `agent_approved` rule of `lint` lists everything for you to review. The technical protections (outside the brain, `.git/`, symbolic links, secrets, forged frontmatter, conflict copies, `index.md`) still hold without exception. In an automatic consolidation (`consolidate --run`), with nobody to confirm, these actions are unavailable unless you pass `--allow-elevated`, an option that, like `--allow-forget`, only you pass at the terminal. See [Security](./seguranca.md).
- **New CLI commands, with the tools' rules:** [`read`](./referencia/cli.md#cabecao-read), [`remember`](./referencia/cli.md#cabecao-remember), [`write`](./referencia/cli.md#cabecao-write), [`patch`](./referencia/cli.md#cabecao-patch), [`relate`](./referencia/cli.md#cabecao-relate), and [`handoff`](./referencia/cli.md#cabecao-handoff). They take content from an argument, a file, standard input, or a JSON with the tool's fields (`--json-input`), with the same limits, and return in `--json` the same output as the tool. An action that needs confirmation exits with code 3. This lets a skill use Cabeção through the CLI, without connecting the MCP server.
- **Obsidian in one command.** `cabecao obsidian setup` configures the vault: graph colors by note type, property types (dates as dates, relations as lists), the archive out of search, five `.base` dashboards in `dashboards/`, and the Web Clipper template, which saves clips to `raw/articles/` with `trust: low`. It only adds to what you already have, with `--dry-run`, a copy of the original and `--remove`. See [Using it with Obsidian](./guias/obsidian.md).
- **Graph maps.** [`cabecao export canvas`](./referencia/cli.md#cabecao-export) writes an Obsidian `.canvas` with the neighborhood of a note, a scope or the whole brain, grouped by type and with each relation type on the arrows.
- **Claude Desktop package.** An `.mcpb` attached to each version on GitHub brings the server to Claude Desktop, with the program bundled. See [Claude Desktop](./guias/claude-desktop.md).
- **`cabecao upgrade`.** Applies the brain's schema migrations with a restore point and one commit per migration (there are none pending today). With `--template`, it updates the `AGENTS.md` and `CLAUDE.md` that are still as an earlier version's template and completes `.gitignore` and `.gitattributes`, without overwriting what you edited. `status` and `doctor` warn about what is pending. See [Updating Cabeção](./guias/atualizar.md).
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
- **Claude Code plugin.** `/plugin marketplace add renanloureiroo/cabecao` and `/plugin install cabecao@cabecao` install the bundled MCP server (no `npx`), the brain's briefing at the start of every session, and a background sync at the end, plus Cabeção's skills. No hook captures the conversation. See [Claude Code plugin](./guias/claude-code.md).
- **Automatic sync.** `cabecao schedule on|off|status` registers a periodic sync with the system scheduler (LaunchAgent, user systemd timer or crontab, Task Scheduler), without administrator rights. See [Automatic sync](./guias/sync-automatico.md).
- **New commands:** `cabecao recall` shows a task's briefing in the terminal; `cabecao sync` gains `--detach` (background), `--hook`, and `--log`. `doctor` now checks the schedule.
- **Consolidate with an agent.** `cabecao consolidate --run` calls Claude Code or Codex (with an API key) with nobody watching, with only Cabeção's tools (shell, file editing, and network denied), in a temporary folder, with a time limit; if the agent does not close the consolidation, what it wrote is undone. `--dry-run` shows everything first. See [Consolidate with an agent](./guias/consolidar-com-agente.md).
- **Antigravity.** `cabecao install-client antigravity` registers the server in Antigravity (the `agy` CLI, IDE, and App), the successor of Gemini CLI for personal accounts. It is not part of `--run`: the personal plan's terms do not allow another program to call it. `gemini` stays, with a notice, and is no longer detected just by the `~/.gemini` folder, which the two share.

## 0.1.0-beta.1

*November 12, 2026*

The same version as 0.1.0-beta.0, published again: only the version number changed.

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
- A single package, with no runtime dependencies or native binaries. Requires Node.js 22.16 or newer and git 2.38+.
