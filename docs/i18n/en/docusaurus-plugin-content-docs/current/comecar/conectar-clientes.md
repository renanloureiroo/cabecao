---
title: Connect to AI clients
description: Register the Cabeção MCP server in Claude Code, Claude Desktop, Codex, Cursor, VS Code, Antigravity and Gemini CLI.
sidebar_position: 3
---

`init` already registers the MCP server in every AI client it finds on this machine. Use `cabecao install-client` when you install a client later, when you want to see the configuration before writing it, or to remove the registration.

There are three ways for an agent to use your brain, and they combine:

| Way | For whom | How |
| --- | --- | --- |
| **MCP server** | Any MCP client, including the ones without a terminal (Claude Desktop) | `cabecao install-client` (this page) |
| **Skills** | Agents with a shell that read skills: Claude Code, Codex, Cursor, VS Code, Antigravity, Gemini CLI | `cabecao install-skills` ([Use Cabeção with skills](../guias/skills.md)) |
| **Plugin** | Claude Code only: bundled server, briefing at the start, sync at the end, and the skills | `/plugin install cabecao@cabecao` ([Claude Code plugin](../guias/claude-code.md)) |

The skills don't need the server: the agent runs `cabecao` in the shell, under the same rules. With the server also registered, the skills tell the agent to prefer the tools.

## Supported clients

| Client | Identifier | Where the registration lives |
| --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude.json` (user scope), through the `claude mcp add-json` command when it exists |
| Claude Desktop | `claude-desktop` | `claude_desktop_config.json` in the app's data folder |
| Codex | `codex` | `~/.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/mcp.json` |
| VS Code | `vscode` | `~/.copilot/mcp-config.json` (and the profile's old `mcp.json`, if the folder exists) |
| Antigravity (`agy` CLI, IDE and App) | `antigravity` | `~/.gemini/config/mcp_config.json` (and the old path `~/.gemini/antigravity/mcp_config.json`, if the folder exists) |
| Gemini CLI (legacy) | `gemini` | `~/.gemini/settings.json` |

A client counts as "detected" when its executable is on the `PATH` or its configuration folder exists. The `~/.gemini` folder is shared by Antigravity and Gemini CLI: Antigravity is detected by `agy` or by the `antigravity-cli`, `antigravity`, `antigravity-ide` or `config` folders inside it; Gemini CLI, by `gemini` or by `~/.gemini/settings.json`.

## Antigravity and Gemini CLI

Google replaced Gemini CLI with **Antigravity CLI** (`agy`), part of the Antigravity platform (CLI, IDE and App). Since June 18, 2026, Gemini CLI no longer serves personal accounts (free, Google AI Pro and Ultra); it remains for Gemini Code Assist Standard or Enterprise licenses and paid API keys. Antigravity keeps MCP servers in a file of its own, separate from Gemini CLI's `settings.json`:

```text
$ cabecao install-client antigravity
Antigravity: registrado
  ~/.gemini/config/mcp_config.json: registrado
Reinicie o cliente para ele enxergar a mudança.
```

`agy mcp list` then shows the `cabecao` server. Antigravity's IDE and App read the same file. Using Cabeção in an Antigravity session is ordinary use of the product; what Cabeção does not do is call Antigravity on its own, through `consolidate --run`, because the personal plan's terms do not allow it (see [Consolidate with an agent](../guias/consolidar-com-agente.md#agentes)). In the update to version 2.0, the old path (`~/.gemini/antigravity/mcp_config.json`) became a link to the new one; Cabeção writes through the link without replacing it with a regular file.

If you still use Gemini CLI, `gemini` keeps working, with a notice:

```text
$ cabecao install-client gemini
Gemini CLI: registrado
  aviso: o Gemini CLI deixou de atender contas pessoais em 18/06/2026 e foi substituído pelo Antigravity: se é o seu caso, use "cabecao install-client antigravity"
  ~/.gemini/settings.json: registrado
Reinicie o cliente para ele enxergar a mudança.
```

If you had already registered `gemini`, nothing is lost: the entry stays where it was, and `cabecao install-client --remove gemini` removes it.

## Connect to Claude Code

:::tip[Plugin or direct registration: one or the other]
In Claude Code, the [Cabeção plugin](../guias/claude-code.md) does more than the registration below: it bundles the server, puts the brain's briefing at the start of every session, and syncs at the end. Use one or the other, not both: the tools would show up twice. `init` registers the server directly even with the plugin installed, and then warns you; `cabecao doctor` also warns and tells you how to remove the direct registration (`cabecao install-client --remove claude-code`).
:::

```bash
cabecao install-client claude-code
```

```text
Claude Code: registrado pelo comando "claude mcp" (escopo user)
Reinicie o cliente para ele enxergar a mudança.
```

Without the `claude` command on the `PATH`, Cabeção edits `~/.claude.json` directly, and the output shows the file. Restart Claude Code. The server shows up with the name `cabecao` and the tools described in the [MCP reference](../referencia/mcp.md).

## All detected clients

```bash
cabecao install-client --all
```

Running it again does not duplicate anything:

```text
Claude Code: já estava registrado pelo comando "claude mcp" (escopo user)
Cursor: já estava registrado
  ~/.cursor/mcp.json: já estava registrado
```

## Preview before writing

`--print` shows the configuration and writes nothing. It is useful for configuring by hand a client that Cabeção does not know:

```text
$ cabecao install-client --print codex
# Codex
# ~/.codex/config.toml
[mcp_servers.cabecao]
command = "/caminho/do/node"
args = ["/caminho/do/cabecao/dist/cabecao.mjs", "mcp", "--brain", "~/cabecao"]
```

The paths depend on your installation. The server is always registered as `cabecao mcp --brain <pasta>`. With a global install, the registration points straight to Node and to the Cabeção file, which avoids 0.5 to 1.4 s of `npx` on every session. With `--npx` (or when you ran Cabeção through `npx`), the registration uses `npx -y cabecao@<versão> mcp`, with the version pinned: without it, `npx` could download a different version on every session.

## Remove the registration

```text
$ cabecao install-client --remove cursor
Cursor: registro removido
  ~/.cursor/mcp.json: registro removido
Reinicie o cliente para ele enxergar a mudança.
```

Cabeção only touches the `cabecao` entry. The other servers and keys in the file stay as they were, and, in the files Cabeção edits directly, the first change saves a copy of the original file next to it, with the `.bak` suffix (the output shows where).

## Check

`doctor` reads the clients' files (without running anything) and tells you which ones have the registration for this brain:

```text
ok     Clientes MCP             2 clientes registrados
                                - Codex: ~/.codex/config.toml: registrado para este cérebro
                                - Cursor: ~/.cursor/mcp.json: registrado para este cérebro
```

It also flags, as a failure, a registration that points to a Node (or a Cabeção file) that no longer exists, for example after removing a Node version with nvm, fnm or Volta: run `cabecao install-client --all` again. And it warns when the Claude Code plugin and the direct registration are active together.

All the options are in the [CLI reference](../referencia/cli.md#cabecao-install-client).
