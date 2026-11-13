---
title: Files and directories
description: Where Cabeção keeps each thing, on the machine and in the brain, and what can be deleted.
sidebar_position: 5
---

## Machine configuration

`~/.config/cabecao/config.json` holds what belongs to this machine only. It does not go into git.

```json
{
  "machine": "notebook",
  "defaultBrain": "/Users/voce/cabecao"
}
```

| Field | What it is |
| --- | --- |
| `machine` | The name of this machine: lowercase letters, digits, and hyphens, up to 32 characters. It appears in commits (`Cabecao-Machine`) and in conflict copies |
| `defaultBrain` | The brain used when none is given (`--brain` or `CABECAO_BRAIN`) |
| `agent` | Optional. The agent `cabecao consolidate --run` uses without `--agent`: `claude-code` or `codex`. You write it by hand; `init` keeps it |

Where the folder lives:

| System | Folder |
| --- | --- |
| macOS and Linux | `$XDG_CONFIG_HOME/cabecao`, or `~/.config/cabecao` |
| Windows | `%APPDATA%\cabecao` |
| Any | `CABECAO_CONFIG_DIR`, if set, takes precedence over the others |

`init` creates the file. If it breaks, delete it and run `cabecao init` again: in a brain that already exists, `init` only saves the machine name.

## Answer provider: `llm.json`

Only exists if you turned on [answers with a language model](../guias/respostas-com-modelo.md) (`cabecao llm on`). It sits in the same folder as `config.json`, with `0600` permission, and **never stores the key**, only where it is:

```json
{
  "version": 1,
  "enabled": true,
  "providers": {
    "anthropic": { "kind": "http", "preset": "anthropic", "model": "claude-haiku-5-5", "key": "keychain", "consented_at": "2026-11-13T12:00:00.000Z" },
    "claude-code": { "kind": "agent", "agent": "claude-code", "model": null, "consented_at": "2026-11-13T12:05:00.000Z" }
  },
  "roles": { "answer": ["anthropic", "claude-code"] },
  "limits": { "context_tokens": 3000, "max_output_tokens": 2048, "timeout_ms": 60000 }
}
```

| Field | What it is |
| --- | --- |
| `enabled` | `false` after `cabecao llm off`: nothing leaves, and the rest stays |
| `providers` | Each provider: `kind` (`http` or `agent`), `preset` or `agent`, `model`, `base_url` (compatible service), `key` (`env:NAME`, `keychain`, `file` or `none`) and `consented_at` (your confirmation; without it, the provider is not used) |
| `roles.answer` | The order of use: if the first one is unavailable or fails, the next one answers |
| `limits` | Context per question (500 to 8000 tokens), output and the time limit of each call |

Next to it, when applicable: `credentials.json` (keys stored with `--store file`, or on Linux without `secret-tool`; `0600` permission) and, on Windows, `credentials.dpapi.json` (keys encrypted with your user's DPAPI). The question log, `ask.log`, lives in the cache folder (`~/.cache/cabecao`; on Windows, `%LOCALAPPDATA%\cabecao`): one line per question, with the truncated question, the provider, the time and the counts, without brain passages and without the key.

## The brain

The brain folder (default `~/cabecao`) is a regular git repository. The structure is described in [Brain structure](../conceitos/estrutura.md).

| File | Goes into git? | Can you edit it by hand? |
| --- | --- | --- |
| Notes in `wiki/`, `memory/`, `raw/` | Yes | Yes |
| `.cabecao.json` | Yes | Yes, carefully; see [.cabecao.json](./configuracao.md) |
| `AGENTS.md`, `CLAUDE.md` | Yes | Yes (agents cannot) |
| `.gitignore`, `.gitattributes` | Yes | Yes, keeping Cabeção's lines (`doctor` warns you if any are missing) |
| `index.md` | Yes | No: it is regenerated |
| `log.md` | Yes | No: it only gets lines appended at the end |
| `*.conflict-*` | Yes | Yes: merge and delete |
| `.cabecao/` | No | No |

## `.cabecao/`: the local database

A per-machine folder, outside git:

| Path | What it is |
| --- | --- |
| `.cabecao/cabecao.db` | The local database (SQLite): search index, graph, facts, and mentions |
| `.cabecao/locks/` | Locks between processes (sync, writes) |
| `.cabecao/sync/` | State of the last sync, the journal of a sync in progress, and the catalog cache |

Everything there is derived from the notes and from git. If the database has a problem, delete the `.cabecao/` folder and run `cabecao status`: the database is rebuilt from the notes.

## What Cabeção writes outside the brain

Only the AI clients' configuration files, when you run `init` or `install-client`, and only the `cabecao` entry inside them. The first change to each file leaves a `.bak` copy next to it. The list of files per client is in [Connect to AI clients](../comecar/conectar-clientes.md).

`cabecao consolidate --run` creates a temporary folder (the agent's MCP configuration and its working directory), deleted at the end, and keeps the agent's output in `~/.cache/cabecao/consolidate-runs/<id>.log` (on Windows, `%LOCALAPPDATA%\cabecao\consolidate-runs`). It does not change the clients' configuration.
