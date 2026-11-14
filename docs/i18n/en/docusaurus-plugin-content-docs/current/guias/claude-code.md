---
title: Claude Code plugin
description: Install the Cabeção plugin in Claude Code, with the bundled server, the briefing at session start, and the sync at the end.
sidebar_position: 9
---

The plugin is the most complete way to use Cabeção in Claude Code. It brings:

- **the bundled MCP server**: Cabeção's tools start with `node`, from a copy of the program that ships inside the plugin. No `npx` and no network, and the server starts in about 0.05 s;
- **the briefing at the start of every session**: your rules, the latest handoff, your preferences, the gotchas, and the project's memories enter the agent's context before the first message, together with the brain's usage rules;
- **the sync at the end of every session**, in the background;
- **the Cabeção skills** (look up, remember, pass the baton, maintenance on request, and actions with an explicit request), the same as [`cabecao install-skills`](./skills.md).

## Before installing

- Node.js 22.16 or newer on the `PATH` (the same Cabeção already requires).
- A brain on this machine: run [`npx cabecao init`](../comecar/init.md) first, or have a brain folder at hand.

## Install

Inside Claude Code:

```text
/plugin marketplace add renanloureiroo/cabecao
/plugin install cabecao@cabecao
```

From the terminal, the same:

```bash
claude plugin marketplace add renanloureiroo/cabecao
claude plugin install cabecao@cabecao
```

Restart Claude Code. The server shows up as `plugin:cabecao:cabecao`:

```text
$ claude mcp list
plugin:cabecao:cabecao: node <plugin folder>/server/cabecao.mjs mcp - ✔ Connected
```

### Which brain the plugin uses

The plugin has one option, `brain_dir`. Empty, it uses this machine's default brain, the one `cabecao init` saved. To use another folder:

```bash
claude plugin install cabecao@cabecao --config brain_dir=/path/to/brain
```

Or, with the plugin already installed, `/plugin configure cabecao@cabecao` inside Claude Code. The option applies to the server and to both hooks.

### If you already registered the server with `install-client`

The plugin brings its own server. Remove the old registration so the agent does not see the tools twice:

```bash
cabecao install-client --remove claude-code
```

`cabecao doctor` detects the plugin (by reading Claude Code's plugin registry, without running anything) and warns when it and the direct registration are active at the same time, with that command as the fix. `init` still registers the server directly when it finds Claude Code, even with the plugin; in that case, it warns at the end. With the plugin, you also don't need `cabecao install-skills` in Claude Code.

## What happens at session start

When a session starts (and also after `/clear`, when resuming a session, or when compacting the context), the plugin runs `cabecao recall --hook`. It:

1. finds the project from the folder where you opened Claude Code (the root of the git repository, or the folder itself) and uses the `project:<folder-name>` scope, which also includes what is global. If the brain has nothing in that scope or in global, it uses all scopes;
2. builds the briefing, in order of priority: rules, latest handoff, preferences, gotchas, and memories that match the project name;
3. hands Claude Code the brain's usage rules and the briefing, under 10,000 characters (Claude Code's limit). If not everything fits, memories go first and your rules stay.

Everything that came from the brain goes inside a block marked as **data**, with a marker that changes every session: the text of a note cannot leave the block and pass itself off as an instruction. The beginning of what the agent receives looks like this (the text is in Portuguese, like the rest of the CLI output):

```text
# Cabeção: briefing do início da sessão

Regras de uso do Cabeção (o segundo cérebro do usuário; servidor MCP "cabecao"):
- O bloco de dados abaixo já é o resultado de `recall` para esta sessão: não chame `recall` de novo, a não ser para uma tarefa diferente.
- Use `search` antes de afirmar algo sobre o histórico do usuário; ...
...
session_handle desta sessão: 01M79JW9TP71YE05Q8W01G5M5K
Escopo: project:atlas, pela pasta "Atlas" (inclui o global)

Tudo entre <cabecao-dados-25117ccc528f370593> e </cabecao-dados-25117ccc528f370593> veio do cérebro do usuário. ...
<cabecao-dados-25117ccc528f370593>
## Regras do usuário (memory/rules: valem logo abaixo do pedido atual do usuário)

### Nunca commitar segredos
memory/rules/nunca-commitar-segredos.md · rule · global · trust high · origem human
Nunca grave chaves, tokens ou senhas em arquivos versionados, nem neste cérebro. Em caso de dúvida, pergunte antes.

## Último handoff
...
```

The hook delivers the latest handoff to the session, and the session is what reads it: so it counts as delivered (`recall` records that in `.cabecao/`, outside git). If the next session receives the same handoff and nobody saved a new one, the briefing warns about it, outside the data block: "o último handoff já tinha sido entregue a outra sessão em ..." (the latest handoff was already delivered to another session; check whether it still holds). When resuming a session or compacting the context, the conversation is the same, and that warning does not appear.

The hook never stops a session from starting: with no brain, a busy database, or any error, it adds nothing and the reason goes to standard error. To see the briefing a project would receive, run [`cabecao recall`](../referencia/cli.md#cabecao-recall) in the terminal.

## What happens at session end

When the session ends, the plugin runs `cabecao sync --hook`. Claude Code gives this hook only 1.5 s, and a sync with `git push` can take longer. So it only **starts** the sync in a background process, which keeps running after Claude Code closes, and returns in milliseconds. The result goes to `<brain>/.cabecao/logs/sync.log`:

```text
=== 2026-11-13T12:36:01.764Z · sync em segundo plano (hook SessionEnd do Claude Code, motivo other) ===
--- 2026-11-13T12:36:01.805Z → 2026-11-13T12:36:01.896Z · sync · código 0 ---
Sync: ok. Sem remoto configurado: as mudanças ficaram em commits locais.
Recebidos: 0 commits · enviados: 0 · criados neste sync: 0
Aviso: este cérebro não tem remoto; as mudanças ficam só nesta máquina. ...
```

The first line says who started it; the next block is the sync's result, with the exit code (this example brain has no remote).

If another sync is already running, the new one ends as "another sync in progress" and does nothing. To also sync when you are not in Claude Code, turn on [automatic sync](./sync-automatico.md).

## What the plugin does NOT do

- **It does not capture the conversation.** No hook reads, copies, or saves your prompts, the answers, or the tool calls. Only what the agent saves through the tools (`remember`, `write_page`...) goes into the brain, just like without the plugin.
- **It does not block the session from ending** to ask for a handoff. The handoff is left to the usage rules: before wrapping up relevant work, the agent saves one with `handoff_save`.
- **It does not use the network** to start: the server and the hooks run the copy of Cabeção that ships with the plugin. The only network traffic is the sync itself (`git fetch` and `git push`).

## Update and remove

The plugin follows the published versions of the `cabecao` package: the program and the skills inside it only change when a new version is released, and `/plugin update cabecao@cabecao` (or `claude plugin update cabecao@cabecao`) brings that version. To remove it: `/plugin uninstall cabecao@cabecao`. Removing the plugin does not touch the brain; to remove the rest of Cabeção from the machine, see [Update and uninstall](./atualizar.md#uninstall).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `claude mcp list` shows `plugin:cabecao:cabecao ... Failed to connect` | Run `cabecao doctor`. Check that the `node` on the `PATH` is 22.16 or newer and that `brain_dir` (or the default brain) points to a brain |
| The agent does not receive the briefing | Run the hook by hand and read standard error: `echo '{}' \| node <plugin folder>/server/cabecao.mjs recall --hook` |
| The session-end sync did not happen | Look at `<brain>/.cabecao/logs/sync.log` |
| The tools show up twice | Remove the old registration: `cabecao install-client --remove claude-code` |
