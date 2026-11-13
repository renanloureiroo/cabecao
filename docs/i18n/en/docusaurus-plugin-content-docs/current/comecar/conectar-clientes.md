---
title: Connect to AI clients
description: Register the Cabeção MCP server in Claude Code, Claude Desktop, Codex, Cursor, VS Code and Gemini CLI.
sidebar_position: 3
---

`init` already registers the MCP server in every AI client it finds on this machine. Use `cabecao install-client` when you install a client later, when you want to see the configuration before writing it, or to remove the registration.

## Supported clients

| Client | Identifier | Where the registration lives |
| --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude.json` (user scope), through the `claude mcp add-json` command when it exists |
| Claude Desktop | `claude-desktop` | `claude_desktop_config.json` in the app's data folder |
| Codex | `codex` | `~/.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/mcp.json` |
| VS Code | `vscode` | `~/.copilot/mcp-config.json` (and the profile's old `mcp.json`, if the folder exists) |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` |

A client counts as "detected" when its executable is on the `PATH` or its configuration folder exists.

## Connect to Claude Code

:::tip[Prefer the plugin]
In Claude Code, the [Cabeção plugin](../guias/claude-code.md) does more than the registration below: it bundles the server, puts the brain's briefing at the start of every session, and syncs at the end. Use one or the other, not both (the tools would show up twice).
:::

```bash
cabecao install-client claude-code
```

```text
Claude Code: registrado
  ~/.claude.json: registrado
Reinicie o cliente para ele enxergar a mudança.
```

Restart Claude Code. The server shows up with the name `cabecao` and the tools described in the [MCP reference](../referencia/mcp.md).

## All detected clients

```bash
cabecao install-client --all
```

Running it again does not duplicate anything:

```text
Claude Code: já estava registrado
  ~/.claude.json: já estava registrado
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

The paths depend on your installation. The server is always registered as `cabecao mcp --brain <pasta>`. With a global install, the registration points straight to Node and to the Cabeção file, which avoids 0.5 to 1.4 s of `npx` on every session. With `--npx` (or when you ran Cabeção through `npx`), the registration uses `npx -y cabecao mcp`.

## Remove the registration

```text
$ cabecao install-client --remove claude-code
Claude Code: registro removido
  ~/.claude.json: registro removido (original guardado em ~/.claude.json.bak)
Reinicie o cliente para ele enxergar a mudança.
```

Cabeção only touches the `cabecao` entry. The other servers and keys in the file stay as they were, and the first change saves a copy of the original file next to it, with the `.bak` suffix.

## Check

`doctor` reads the clients' files (without running anything) and tells you which ones have the registration for this brain:

```text
ok     Clientes MCP             1 cliente(s) registrado(s)
                                - Claude Code: ~/.claude.json: registrado para este cérebro
```

All the options are in the [CLI reference](../referencia/cli.md#cabecao-install-client).
