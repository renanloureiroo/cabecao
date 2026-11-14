---
title: Claude Desktop
description: Install Cabeção in Claude Desktop with the .mcpb package, with the server bundled and the brain folder chosen at install time.
sidebar_position: 11
---

Claude Desktop installs local MCP servers through an **`.mcpb` package** (MCP Bundle): a file you open with a double click. Cabeção's package bundles the server, so it does not depend on `npx`, `node_modules` or the network to start.

## Before installing

The package does not create the brain: it only connects Claude Desktop to a brain that already exists. Create it (or connect this machine) first:

```bash
npx cabecao init git@github.com:you/my-brain.git
```

## Install

1. Download `cabecao-<version>.mcpb` from the [project's releases page](https://github.com/renanloureiroo/cabecao/releases).
2. Open the file with a double click, drag it onto the Claude Desktop window, or use **Settings → Extensions → Advanced settings → Install Extension**.
3. On the configuration screen, choose the **brain folder** (the default is `~/cabecao`).

Claude Desktop now has Cabeção's 17 tools (`recall`, `search`, `remember`, `sync`...). The usage rules come through the server instructions; there are no hooks as in the [Claude Code plugin](./claude-code.md), so sync happens when the agent calls the `sync` tool, when you run `cabecao sync`, or through [automatic sync](./sync-automatico.md).

:::warning[Not tested in the app]
The package is built for every version and checked by the project's tests (manifest conforming to the MCPB 0.3 specification, contents checked, and the server starts from the extracted package the way the app would start it); the manifest has also passed the official `mcpb validate` tool. **Installing it in the real Claude Desktop has not been tested yet.** If something goes wrong, use the path below and tell us in an [issue](https://github.com/renanloureiroo/cabecao/issues).
:::

## What is in the package

Only three things, about 490 kB:

| File | What it is |
| --- | --- |
| `manifest.json` | The manifest (MCPB specification 0.3): name, version, the tools, the `brain_dir` folder option and the command `node ${__dirname}/server/cabecao.mjs mcp`, with the chosen folder in `CABECAO_BRAIN` |
| `icon.png` | The icon |
| `server/*.mjs` | The same program published on npm, with no dependencies |

The server runs on the Node.js that Claude Desktop ships. Cabeção needs Node.js 22.16 or newer: on an older Node, the server does not start and the message says so. The system git is still needed for sync.

## Updating

The package does not update itself: download the new version's `.mcpb` and install it over the old one. The brain does not change with that; if the new version brings a schema migration, run `cabecao upgrade` (see [Updating](./atualizar.md)).

## Without the package

`cabecao install-client claude-desktop` writes the server entry in the app's `claude_desktop_config.json`, keeping what is already there (see [Connecting AI clients](../comecar/conectar-clientes.md)). Use one or the other: both together register Cabeção twice.
