---
title: CLI
description: Every cabecao command, with its options, examples, and exit codes.
sidebar_position: 1
---

Reference for `cabecao 0.1.0-beta.1`. `cabecao --help` lists the commands, and `cabecao <command> --help` shows the options for each one.

## Global options

These apply to every command and can come before or after the command name.

| Option | What it does |
| --- | --- |
| `--brain <pasta>` | Brain folder to use |
| `--json` | Structured JSON output, for scripts and hooks |
| `-h`, `--help` | Shows the help |
| `-v`, `--version` | Shows the version |

**Which brain is used:** the one from `--brain`; otherwise the one from the `CABECAO_BRAIN` variable; otherwise this machine's default, saved by `init`; otherwise the current folder, if it is a brain.

**`--json` output:** on success, `{ "ok": true, "command": "<comando>", "data": { ... } }`. On error, `{ "ok": false, "command": "<comando>", "error": { "kind", "message", "code", "hint" } }`, and the human-readable message also goes to standard error.

**Exit codes**, unless the command says otherwise:

| Code | Meaning |
| --- | --- |
| `0` | It worked |
| `1` | Runtime error: the message says what happened and what to do |
| `2` | Usage error: unknown option, missing argument, or invalid value |

```text
$ cabecao search
cabecao: diga o que procurar: cabecao search "<pergunta>"
Rode cabecao search --help para ver o uso.
```

With `CABECAO_DEBUG=1`, errors include the stack trace, so you can report a problem.

---

## cabecao init

Installs a brain on this machine or connects this machine to one.

```text
cabecao init [url] [--dir <pasta>] [--machine <nome>] [--no-clients]
```

| Option | What it does |
| --- | --- |
| `[url]` | Address of the git repository (SSH, HTTPS, or a local folder). Without it, the brain stays on this machine only |
| `--dir <pasta>` | Brain folder (default: `~/cabecao`). It must not exist or must be empty |
| `--machine <nome>` | Name of this machine (default: the computer's name), adjusted to lowercase letters, digits, and hyphens |
| `--no-clients` | Does not register the MCP server in the AI clients |

Without asking anything, it: clones the repository (or creates the folder); checks what is in it (an empty repository becomes a new brain, an existing brain is just downloaded, an Obsidian or Markdown vault is adopted without moving files, and anything else is refused); builds the local index; registers the MCP server in the clients it finds; and runs `doctor`.

It uses the credentials your git already uses and never asks for a password. It saves `machine` and `defaultBrain` to `~/.config/cabecao/config.json`.

**Exit:** `0` when the brain is ready; `1` on any failure, without leaving anything behind.

```bash
cabecao init git@github.com:voce/cerebro.git
cabecao init git@github.com:voce/cerebro.git --machine trabalho
cabecao init git@github.com:voce/vault.git --dir ~/Obsidian/Notas
cabecao init
```

The five cases, with the output of each one, are in [Create or connect a brain](../comecar/init.md).

## cabecao status

Notes by type, broken links, the sync state, and pending conflicts.

```text
cabecao status
```

```text
$ cabecao status
Cérebro: ~/cabecao (máquina notebook, esquema 1)
Notas: 25 (concept 2, decision 2, entity 6, episode 1, fact 4, gotcha 1, handoff 1, preference 1, procedure 1, rule 1, source 1, synthesis 1, sem tipo 2) · 1 arquivada · 2 sem id (fontes ou notas soltas)
Links quebrados: 1
Sync: branch main ↔ origin/main (git@github.com:voce/atlas.git)
  Último sync: nunca
  Commits não enviados: 0 · do remoto, ainda não integrados: 0
  Mudanças feitas fora do Cabeção, esperando o sync: 0
Conflitos pendentes: nenhum
Saúde: ok
```

`status` updates the local index before counting, so it also rebuilds the database if `.cabecao/` was deleted.

**Exit:** `0`, even with warnings (conflicts, broken links); `1` if it cannot find the brain.

## cabecao doctor

Full diagnosis, with the suggested fix for each problem.

```text
cabecao doctor [--offline]
```

| Option | What it does |
| --- | --- |
| `--offline` | Does not contact the remote (nor run the public repository check) |

It checks: Node.js and git; whether the folder is a brain and the schema version; the machine configuration; the git identity; `commit.gpgsign`; the remote (reachable, and with credentials that work without a terminal, with a short timeout) and, for HTTPS on a known provider, whether the repository looks public; `.gitignore` and `.gitattributes`; the local database; orphaned locks and interrupted operations; pending conflicts; on Windows, the path length; and the MCP server registration in the AI clients (it only reads the files, it does not run anything).

```text
$ cabecao doctor --offline
Diagnóstico do Cabeção: ~/cabecao

ok     Node.js                  v24.21.0
ok     git                      2.54.0
ok     Cérebro                  ~/cabecao (esquema 1)
ok     Configuração da máquina  máquina "notebook"
ok     Identidade do git        Ana Exemplo <ana@exemplo.invalid>
ok     Assinatura de commits    commit.gpgsign desligado
ok     Remoto                   origin (git@github.com:voce/atlas.git); não consultado (--offline)
aviso  .gitignore               faltam 1 linha(s)
                                - .cabecao-*.tmp
                                Correção: Acrescente ao .gitignore do cérebro, e faça um commit (ou rode "cabecao sync"):
ok     .gitattributes           tem as linhas que o Cabeção precisa
ok     Banco local              em dia com o último commit (25 nota(s), varrido em 2026-11-12 23:50)
ok     Travas                   nenhuma trava órfã
ok     Operações interrompidas  nenhuma
ok     Conflitos                nenhum pendente
aviso  Clientes MCP             4 de 4 cliente(s) sem o registro deste cérebro
                                - Claude Code: ~/.claude.json: não registrado
                                - Codex: ~/.codex/config.toml: não registrado
                                - VS Code: ~/.copilot/mcp-config.json: não registrado
                                - Gemini CLI: ~/.gemini/settings.json: não registrado
                                Correção: Rode "cabecao install-client claude-code codex vscode gemini" e reinicie o cliente.

12 ok, 2 avisos, 0 falhas.
```

Each item comes out as `ok`, `aviso` (warning), or `falha` (failure). With `--json`, each item has `id`, `title`, `status`, `message` and, when present, `fix` and `items`.

**Exit:** `1` if there is any failure; `0` with warnings or when everything is fine.

## cabecao sync

Syncs the brain with the remote.

```text
cabecao sync [--session <id>]
```

| Option | What it does |
| --- | --- |
| `--session <id>` | Session of the agent that requested the sync, for the commits. Used by the MCP server |

It commits what was edited outside Cabeção, receives what came from the remote, integrates without discarding anything (the same note edited on both sides produces a `nota.conflict-<máquina>-<data>.md` copy next to it), and pushes. Before committing and before pushing, it looks for secrets: if it finds any, it blocks and shows the file, line, and rule, never the value.

```text
$ cabecao sync
Sync: ok. 3 commits enviados.
Recebidos: 0 commits · enviados: 3 · criados neste sync: 0
```

**Exit:** `0` when it finished, when another sync was already running, and in a brain with no remote (with a warning); `1` when it was blocked, hit an error, or the remote did not respond (the changes stay in local commits and go out on the next sync).

The full details are in [How sync works](../conceitos/sync.md).

## cabecao search

Keyword search.

```text
cabecao search "<pergunta>" [--type <tipo>...] [--scope <escopo>] [--limit <n>] [--as-of <data>]
```

| Option | What it does |
| --- | --- |
| `--type <tipo>` | Only notes of this type. Repeat it or separate with commas: `--type decision,gotcha` |
| `--scope <escopo>` | `global` or `project:<nome>` (which also includes global) |
| `--limit <n>` | Maximum number of results, from 1 to 100 (default: 10) |
| `--as-of <data>` | `AAAA-MM-DD` date on which validity is calculated (default: today) |

Each result shows the title, path, snippet, and whether the note is current, expired, or not yet valid on that date. Notes that are not valid appear further down, never hidden. At the end, a separate block lists up to 5 notes linked in the graph to the top results, with the reason.

```text
$ cabecao search "deploy blog"
1 resultado(s) para "deploy blog", com todos os termos (validade em 2026-11-12):

1. Deploy do blog só às sextas  [preference · global]  vigente
   memory/preferences/deploy-do-blog-so-as-sextas.md
   Prefiro publicar o «blog» às sextas, depois das 18h, para revisar com calma durante a semana.
```

**Exit:** `0`, even with no results; `2` without the query or with an invalid option.

More examples in [Search](../guias/buscar.md).

## cabecao graph

Neighbors of a note in the graph.

```text
cabecao graph "<nota>" [--depth 1|2] [--type <tipo>...] [--as-of <data>]
```

| Option | What it does |
| --- | --- |
| `"<nota>"` | Title, path, or id of the note |
| `--depth <n>` | Hops: `1` (default) or `2` |
| `--type <tipo>` | Only these links. Repeat it or separate with commas: `uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to` (and your own), `supersedes`, `wikilink`, `fact`, `mention` |
| `--as-of <data>` | `AAAA-MM-DD` date for validity (default: today) |

It shows the linked notes: typed relations from the frontmatter, wikilinks, facts, version chains (`supersedes`), and unlinked mentions, each with its direction and whether it is valid on that date. For a heavily linked node, the response is cut short, with a warning.

```text
$ cabecao graph "Projeto Atlas" --type uses,part_of --depth 1
```

**Exit:** `0`; `1` when the note does not exist; `2` with an invalid option.

```text
$ cabecao graph "Kafka"
cabecao: nenhuma nota corresponde a "Kafka" ("node")
Use search para achar a nota e passe o caminho ou o id dela.
```

## cabecao facts

Facts and whether they are valid on a date.

```text
cabecao facts [--subject <nota>] [--predicate <p>] [--object <nota>] [--as-of <data>] [--limit <n>]
```

| Option | What it does |
| --- | --- |
| `--subject <nota>` | Subject: title, path, or id of the note |
| `--predicate <p>` | Predicate, such as `uses_queue` or `led_by` |
| `--object <nota>` | Object: title, path, or id (or a value) |
| `--as-of <data>` | `AAAA-MM-DD` date for validity (default: today) |
| `--limit <n>` | Maximum number of facts, from 1 to 200 (default: 50) |

It lists the fact notes (`memory/facts/`) that match the filters, with the validity period, whether they are valid on that date, and the chain: which fact each one replaces and which one replaced it. Expired facts appear last.

```text
$ cabecao facts --subject "Projeto Atlas" --predicate led_by --as-of 2026-03-01
2 fato(s), validade em 2026-03-01:

1. Projeto Atlas · led_by · Ana Prado  vigente
   de 2026-01-12 até 2026-09-01   memory/facts/fato-ana-lidera-atlas.md
   substituído por: memory/facts/fato-bruno-lidera-atlas.md

2. Projeto Atlas · led_by · Bruno Tavares  AINDA NÃO VIGENTE
   de 2026-09-01 até em aberto   memory/facts/fato-bruno-lidera-atlas.md
   substitui: memory/facts/fato-ana-lidera-atlas.md
```

**Exit:** `0`, even with no facts; `2` with an invalid option.

## cabecao undo

Undoes the last operation, a specific operation, or a session.

```text
cabecao undo
cabecao undo --op <id>
cabecao undo --session <id>
cabecao undo --list [--session <id>] [--limit <n>]
```

| Option | What it does |
| --- | --- |
| `--op <id>` | Undoes this operation: the identifier or its beginning, with at least 8 characters |
| `--session <id>` | Undoes everything this agent session wrote that is still in place, in a single commit |
| `--list` | Shows the operations that can be undone |
| `--limit <n>` | With `--list`: how many to show (default: 20) |

It undoes with a revert commit, without rewriting history. The undo is also an operation: undoing it redoes what had been undone. It only reaches Cabeção operations, not edits made outside it. Run `cabecao sync` afterward to take the undo to your other machines.

**Exit:** `0` when it undid something (or listed); `1` when there is nothing to undo, the operation does not exist, or the revert would conflict; `2` with an identifier that is too short.

Examples in [Undo](../guias/desfazer.md).

## cabecao mcp

The MCP server over stdio.

```text
cabecao mcp [--brain <pasta>]
```

You do not run this by hand: the AI client starts this command and talks to it over standard input and output. Standard output carries only JSON-RPC messages; diagnostics go to standard error. Register it with `cabecao install-client`.

The server speaks the two current generations of the MCP protocol (`2025-11-25` and `2026-07-28`). The tools, resources, and instructions are in the [MCP reference](./mcp.md).

**Exit:** `0` when the client closes the connection.

## cabecao install-client

Registers the MCP server in the AI clients.

```text
cabecao install-client <cliente...> [--npx]
cabecao install-client --all [--npx]
cabecao install-client --print [cliente...]
cabecao install-client --remove <cliente...> | --remove --all
```

| Option | What it does |
| --- | --- |
| `<cliente...>` | One or more of: `claude-code`, `claude-desktop`, `codex`, `cursor`, `vscode`, `gemini` |
| `--all` | All clients detected on this machine |
| `--print` | Only shows the configuration; does not write anything |
| `--remove` | Removes the registration instead of creating it |
| `--npx` | Registers as `npx -y cabecao mcp` instead of the direct path |

The server is registered as `cabecao mcp --brain <pasta>`. With a stable installation (global or local), the registration points directly to Node and to the Cabeção file, which avoids 0.5 to 1.4 s of `npx` on every session. The other servers and keys in the client's file are preserved, and the first change leaves a `.bak` copy of the original.

```text
$ cabecao install-client claude-code cursor
Claude Code: registrado
  ~/.claude.json: registrado
Cursor: registrado
  ~/.cursor/mcp.json: registrado
Reinicie o cliente para ele enxergar a mudança.
```

**Exit:** `0`; `2` with an unknown client, or with no client and no `--all`.

More in [Connect to AI clients](../comecar/conectar-clientes.md).

## Environment variables

| Variable | What it does |
| --- | --- |
| `CABECAO_BRAIN` | Brain folder, like `--brain` |
| `CABECAO_CONFIG_DIR` | Machine configuration folder (default: `~/.config/cabecao`; on Windows, `%APPDATA%\cabecao`) |
| `CABECAO_DEBUG` | With `1`, errors include the stack trace |
| `XDG_CONFIG_HOME` | When set, the configuration lives in `$XDG_CONFIG_HOME/cabecao` |
