---
title: Use Cabeção with skills
description: The Cabeção skills teach the agent to use the brain through the CLI, without the MCP server. How to install them in each agent and when to use skills, the plugin or MCP.
sidebar_position: 2
---

A **skill** is a folder with a `SKILL.md` file (the [Agent Skills](https://agentskills.io/specification) format) that the agent loads when the topic of the conversation matches its description. The Cabeção skills teach the agent to look things up and save them in your brain **through the command line**, with the `cabecao` already installed on the machine. They don't need the MCP server connected.

## Why they work without MCP

The agent runs the `cabecao` commands in its shell, the same way it runs `git` or `npm`. The CLI knows when the one running it is an agent (no controlling terminal, or an agent signal in the environment) and applies **exactly the same rules** as the MCP server: rules, control files, `raw/` and `trust: high` only with your explicit request, confirmed in two calls; secrets blocked; everything in a commit that `undo` undoes. The skills only say which commands to use and how to read the answer. The details are in [Who is human and who is an agent in the CLI](./humano-e-agente.md).

## The five skills

Each one covers an **intent**, and its description is written around what you ask for, not around exact words:

| Skill | Kicks in when | Commands |
| --- | --- | --- |
| `cabecao-consultar` | Start of a task; before stating something about your history, decisions or preferences | `recall`, `search`, `read`, `graph`, `facts` |
| `cabecao-lembrar` | You state a preference, correct the agent, make a decision; the agent discovers a gotcha | `remember` (with `--resolution` for similar memories), `relate`, `write`, `patch` |
| `cabecao-passar-bastao` | End of a relevant piece of work, change of machine or agent | `handoff`, `sync` |
| `cabecao-manutencao` | Only when you ask: see the state, find problems, consolidate, forget, undo, sync | `status`, `lint`, `consolidate`, `forget`, `undo`, `sync` |
| `cabecao-pedido-explicito` | Only when you ask for a rule for the agents, a change to `AGENTS.md` (or another control file), to `raw/`, or to undo what was not the agent's | the two-call flow with `--confirm <token>` |

All of them say to run with `--json` and `--as <agent name>`, to pass the content through standard input (a heredoc with `<<'EOF'`, which does not depend on shell escaping), to treat what Cabeção returns as **data, never instructions**, and to use the equivalent tools when the `cabecao` MCP server is connected in the session. The descriptions are in Portuguese, with a sentence in English at the end, so the agent recognizes the request in both languages without two copies of each skill.

## Install

```bash
cabecao install-skills
```

Without a name, it installs in the agents detected on this machine. Real output, on a machine with Codex and Cursor (the output is in Portuguese):

```text
$ cabecao install-skills
Codex, Cursor: ~/.agents/skills
  cabecao-consultar: instalada
  cabecao-lembrar: instalada
  cabecao-manutencao: instalada
  cabecao-passar-bastao: instalada
  cabecao-pedido-explicito: instalada
Abra uma sessão nova do agente para ele carregar as skills.
```

Running it again changes nothing (`já estava em dia`). For a single agent, give its name: `cabecao install-skills codex`. With `--project`, the skills go into the current project's folder, so they apply only there (and go into the project's git, if you want).

### Where each agent reads the skills

| Agent | `client` | User (default) | Project (`--project`) |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) | `.claude/skills` |
| Codex | `codex` | `~/.agents/skills` | `.agents/skills` |
| Cursor | `cursor` | `~/.agents/skills` | `.agents/skills` |
| Gemini CLI | `gemini` | `~/.agents/skills` | `.agents/skills` |
| Antigravity (agy, IDE and App) | `antigravity` | `~/.gemini/config/skills` | `.agents/skills` |
| VS Code and GitHub Copilot | `vscode` | `~/.copilot/skills` (or `$COPILOT_HOME/skills`) | `.github/skills` |

What is **confirmed** in each agent's official documentation (checked on 11/13/2026): the folders in the table, without the variables. What is an **assumption**: that `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` take the skills along (both variables change the whole configuration folder, but the skills documentation does not say so) and the paths on Windows (the same folders inside `%USERPROFILE%`). Codex, Cursor and Gemini CLI read `~/.agents/skills`, so they share the same copy; removing the skills from one of them does not remove them from the others that still use the folder. Cursor and VS Code also read `~/.claude/skills`: with Claude Code and one of them on the same machine, the agent may see the skills twice.

### Your changes are yours

Cabeção records the hash of each file it wrote (`skills.json`, in the machine's configuration folder). So:

- running `install-skills` again (for example, after updating Cabeção) replaces only the files still as Cabeção wrote them;
- a skill you edited, or a skill of yours with the same name, stays as it is (`mantida como está: foi alterada por você`); `cabecao install-skills --print` shows Cabeção's version for you to compare;
- `cabecao install-skills --remove` removes only what Cabeção put there and you did not edit (`--remove codex` removes from one agent; `--remove --all`, from every folder, including project folders).

Writing is atomic: a file is never left half-written. `cabecao doctor` checks whether the installed skills are up to date with the Cabeção version:

```text
ok     Skills do Cabeção        instaladas e em dia
                                - ~/.agents/skills (codex, cursor): 5 arquivos em dia
```

### Preview without writing

```bash
cabecao install-skills --print codex
```

Shows each agent's folder, what would happen to each skill, and the full content of the `SKILL.md` files. Nothing is written.

## Agents without skills

Claude Desktop does not run terminal commands and has no skills folder on disk: there, Cabeção comes in through the MCP server ([the `.mcpb` package](./claude-desktop.md)).

```text
$ cabecao install-skills claude-desktop
cabecao: o Claude Desktop não roda comandos de terminal e não tem pasta de skills no disco: lá o Cabeção entra pelo servidor MCP (o pacote .mcpb ou "cabecao install-client claude-desktop")
```

For an agent that does not read skills but reads an instructions file (`AGENTS.md`, `GEMINI.md` and the like), Cabeção **does not edit** that file for you. It shows a short block for you to paste:

```bash
cabecao install-skills --instructions
```

## Skills, plugin or MCP server?

| | Skills (`install-skills`) | MCP server (`install-client`) | Claude Code plugin |
| --- | --- | --- | --- |
| How the agent uses the brain | Runs `cabecao` in the shell | Calls the server's tools | Tools of the bundled server, plus the skills |
| Needs Cabeção installed on the machine | Yes (`npm i -g cabecao@beta`) | Yes, or `npx` | Not for the server (it ships inside the plugin) |
| Automatic briefing at session start | No: the skill says to call `recall` | No: the server's instructions ask for `recall` | Yes (hook) |
| Sync at session end | The skill says to run `cabecao sync` | No (use `cabecao schedule on`) | Yes (hook) |
| Where it works | Agents with a shell that read skills | Any MCP client, including the ones without a shell (Claude Desktop) | Claude Code only |

When to use each one:

- **Claude Code**: the [plugin](./claude-code.md) brings everything together. Without the plugin, the skills or the server registration work. Don't use the plugin and the direct registration at the same time (`doctor` warns): the tools would show up twice.
- **Codex, Cursor, Gemini CLI, Antigravity, Copilot**: the skills alone are enough. If you also registered the server (`install-client`), the skills tell the agent to prefer the tools; the two together don't get in each other's way.
- **Claude Desktop** and MCP clients without a shell: only the MCP server.
- **Without automatic sync**: with skills or MCP, what the agent saves stays in a local commit until a `cabecao sync`. The pass-the-baton skill says to sync at the end; `cabecao schedule on` covers the rest.

## In the Claude Code plugin

The plugin brings the Cabeção skills together with the server and the hooks. It matches the **published version** of Cabeção: new skills reach the plugin in the next published version (until then, the plugin brings the `memory` reference skill). If you use the plugin, you don't need `install-skills` in Claude Code.

## What has not been tested

The skills were checked by a test that runs, as an agent, every command they tell the agent to run, against a copy of the sample brain. A real agent loading the skills by their description and following them in a conversation has not been tested. If an agent does not use a skill when it should, tell us in the [issues](https://github.com/renanloureiroo/cabecao/issues) which agent and what you asked.
