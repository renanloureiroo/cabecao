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

## cabecao recall

The brain's briefing for a task: what the agent receives at the start of it.

```text
cabecao recall "<task>" [--scope <scope>] [--budget <tokens>]
cabecao recall --hook
```

| Option | What it does |
| --- | --- |
| `"<task>"` | What is about to be done; it is the query for the relevant memories |
| `--scope <scope>` | `global` or `project:<name>` (which also includes global). Default: all |
| `--budget <tokens>` | Approximate size of the briefing, from 100 to 50000 (default: 2000) |
| `--hook` | Claude Code hook mode (see below) |

It shows, in this order of priority, your rules (`memory/rules`), the latest handoff, preferences, gotchas, and the memories that match the task, plus a new `session_handle`. It only reads: nothing is written. With `--json`, it returns the same output as the `recall` tool.

```text
$ cabecao recall "filas do atlas" --scope project:atlas --budget 600
Briefing para "filas do atlas" (escopo: project:atlas)
session_handle: 01M7AEF0EN7E1MQVSGJ5ZFYJFS

Regras do usuário (memory/rules: valem logo abaixo do pedido atual do usuário):
  Nunca commitar segredos  (memory/rules/nunca-commitar-segredos.md · rule · global · trust high · origem human)
    Nunca grave chaves, tokens ou senhas em arquivos versionados, nem neste cérebro. Em caso de dúvida, pergunte antes.

Último handoff:
  Atlas, consumidores em lote  (memory/handoffs/2026-11-10-atlas-consumidores.md · handoff · project:atlas · trust medium · origem agent:claude-code)
    # Atlas, consumidores em lote
    ...

Preferências do usuário:
  Respostas em português  (memory/preferences/respostas-em-portugues.md · preference · global · trust high · origem agent:claude-code)
    Responda em português do Brasil. Mantenha termos técnicos e identificadores de código no original.

4 itens ficaram de fora pelo orçamento de 600 tokens (aumente com --budget).
```

**`--hook`** is what the [Claude Code plugin](../guias/claude-code.md) runs when a session starts. It reads the session JSON from standard input (with a size cap; anything invalid is ignored), derives the `project:<folder>` scope from the project folder, and writes to standard output exactly the JSON the `SessionStart` hook expects: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`, with the usage rules and the briefing, under 10,000 characters, and with the brain's content marked as data. Without `--brain` or `CABECAO_BRAIN`, it uses the plugin's `brain_dir` option (the `CLAUDE_PLUGIN_OPTION_BRAIN_DIR` variable) and, without it, the default brain.

**Exit:** `0`. With `--hook`, always `0`: with no brain, a busy database, after 5 s, or on any error, the output is `{}` and the reason goes to standard error. Without `--hook`, `1` when the brain is not found and `2` without the task.

## cabecao doctor

Full diagnosis, with the suggested fix for each problem.

```text
cabecao doctor [--offline]
```

| Option | What it does |
| --- | --- |
| `--offline` | Does not contact the remote (nor run the public repository check) |

It checks: Node.js and git; whether the folder is a brain and the schema version; the machine configuration; the git identity; `commit.gpgsign`; the remote (reachable, and with credentials that work without a terminal, with a short timeout) and, for HTTPS on a known provider, whether the repository looks public; `.gitignore` and `.gitattributes`; the local database; orphaned locks and interrupted operations; pending conflicts; on Windows, the path length; the MCP server registration in the AI clients (it only reads the files, it does not run anything); and the scheduled sync (it only queries the scheduler when `cabecao schedule on` registered something).

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
ok     Sync agendado            desligado (opcional: "cabecao schedule on" sincroniza sozinho a cada 30 min)

13 ok, 2 avisos, 0 falhas.
```

Each item comes out as `ok`, `aviso` (warning), or `falha` (failure). With `--json`, each item has `id`, `title`, `status`, `message` and, when present, `fix` and `items`.

**Exit:** `1` if there is any failure; `0` with warnings or when everything is fine.

## cabecao sync

Syncs the brain with the remote.

```text
cabecao sync [--session <id>] [--log]
cabecao sync --detach
cabecao sync --hook
```

| Option | What it does |
| --- | --- |
| `--session <id>` | Session of the agent that requested the sync, for the commits. Used by the MCP server |
| `--log` | Also appends the result to `<brain>/.cabecao/logs/sync.log`. This is what the scheduled sync runs |
| `--detach` | Starts the sync in a background process and returns right away; the result goes to the log |
| `--hook` | Claude Code session end: like `--detach`, but it never fails |

It commits what was edited outside Cabeção, receives what came from the remote, integrates without discarding anything (the same note edited on both sides produces a `nota.conflict-<máquina>-<data>.md` copy next to it), and pushes. Before committing and before pushing, it looks for secrets: if it finds any, it blocks and shows the file, line, and rule, never the value.

```text
$ cabecao sync
Sync: ok. 3 commits enviados.
Recebidos: 0 commits · enviados: 3 · criados neste sync: 0
```

`--detach` returns in milliseconds and leaves `cabecao sync --log` running in a detached process, which keeps going after the terminal (or Claude Code) closes:

```text
$ cabecao sync --detach
Sync disparado em segundo plano (processo 5114). O resultado vai para ~/cabecao/.cabecao/logs/sync.log.
```

If another sync is already running, the new one ends as "outro sync em andamento" (another sync in progress) and does nothing. `--hook` does the same for the session-end hook of the [Claude Code plugin](../guias/claude-code.md): it reads the session JSON from standard input, writes nothing to standard output and, if it cannot start the sync (no brain, for example), only warns on standard error.

**Exit:** `0` when it finished, when another sync was already running, and in a brain with no remote (with a warning); `1` when it was blocked, hit an error, or the remote did not respond (the changes stay in local commits and go out on the next sync). With `--detach`, `0` when the background sync started and `1` when it could not start. With `--hook`, always `0`.

The full details are in [How sync works](../conceitos/sync.md).

## cabecao schedule

Periodic sync through the operating system's scheduler.

```text
cabecao schedule on [--interval <min>]
cabecao schedule off
cabecao schedule status
```

| Option | What it does |
| --- | --- |
| `--interval <min>` | With `on`: minutes between syncs, from 5 to 1440 (default: 30) |

It registers `cabecao sync --log` with the scheduler, for your user only and without administrator rights: a LaunchAgent on macOS, a `systemd --user` timer on Linux (your `crontab` when there is no user systemd), and Task Scheduler on Windows. The scheduled sync uses this machine's default brain (the one from `init`; `--brain` with another folder is refused) and needs a stable installation (`npm i -g cabecao`): when run through `npx`, the command refuses.

```text
$ cabecao schedule on
Sync periódico registrado: a cada 30 min, pelo LaunchAgent do macOS.
Comando: /usr/local/bin/node ~/.npm-global/lib/node_modules/cabecao/dist/cabecao.mjs sync --log
Cérebro: ~/cabecao
Log: ~/cabecao/.cabecao/logs/sync.log
Arquivo: ~/Library/LaunchAgents/dev.cabecao.sync.plist
Para desligar: cabecao schedule off
```

`on` is idempotent: when nothing changed, it answers "já estava registrado assim" (already registered like this) without touching the scheduler. `off` removes only what Cabeção created, and `status` shows what is registered and what the scheduler reports about the task. The details for each system are in [Automatic sync](../guias/sync-automatico.md).

**Exit:** `0`; `1` when there is no default brain, the installation is not stable, something with the same name that is not Cabeção's already exists, or the scheduler refused; `2` with an invalid action or interval.

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
| `CLAUDE_PLUGIN_OPTION_BRAIN_DIR` | Set by Claude Code for the plugin's hooks: the brain folder from the `brain_dir` option. Only used by `recall --hook` and `sync --hook`, and only when there is no `--brain` or `CABECAO_BRAIN` |
