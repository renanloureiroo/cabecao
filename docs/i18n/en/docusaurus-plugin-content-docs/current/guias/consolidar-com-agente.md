---
title: Consolidate with an agent
description: Let Cabeção call Claude Code or Codex to consolidate the memory on its own, with nobody watching, and undo it if you do not like the result.
sidebar_position: 11
---

Consolidation turns repeated episodes into a fact, a procedure, or a gotcha, merges duplicate notes, and fixes what `lint` finds. An AI agent does the reasoning: Cabeção has no model of its own. With `cabecao consolidate --run`, Cabeção calls the agent by itself, in non-interactive mode, and checks the result.

```bash
cabecao consolidate --run
```

## What happens

1. Cabeção creates the restore point (the `cabecao/restore/<date>-<id>` tag) and gathers the material: similar episodes, similar notes, and `lint` findings.
2. It calls the agent with a script and that material. The agent reads the brain, writes through Cabeção's tools, and ends by calling `consolidate` with `action: "finish"`.
3. When the agent exits, Cabeção looks at git:
   - **closed:** it shows one line per note touched and how to undo;
   - **finished without writing anything:** it says so, and nothing changes;
   - **not closed** (error, time limit, Ctrl+C, or it left without `finish`): it undoes what the agent wrote, says why, and exits with code `1`. Closing half of it in a commit would leave a half-done merge (the new note without the leftover archived, for example) that nobody looked at; undoing is the reversible path.

A real run, on the sample brain (Cabeção's output is in Portuguese):

```text
$ cabecao consolidate --run --agent claude-code --timeout 5
cabecao: Claude Code (escolhido com --agent) vai consolidar o cérebro sem ninguém olhando; tempo limite 5 min 0 s. Ponto de restauração: cabecao/restore/2026-11-13-104416-388-01M7AJDQ796TP2A9ZCSAV7R9VT.
Agente: Claude Code (escolhido com --agent), 13 s, 9 turno(s), US$ 0.0069.
Consolidação 01M7AJDQ796TP2A9ZCSAV7R9VT fechada no commit ce3fb9fee3:
  - update fact: Projeto Atlas uses_queue SQS
  - update concept: Fila de mensagens

Para desfazer: cabecao undo --session 01M7AJDQ796TP2A9ZCSAV7R9VT
Ponto de restauração: cabecao/restore/2026-11-13-104416-388-01M7AJDQ796TP2A9ZCSAV7R9VT (git reset --hard cabecao/restore/2026-11-13-104416-388-01M7AJDQ796TP2A9ZCSAV7R9VT volta a ele, descartando o que veio depois).
```

The agent replaced the broken `[[Kafka]]` link with plain text and added the missing link on "RabbitMQ", the two `lint` findings of that brain. When the agent finishes cleanly with nothing to change, the output says "o agente terminou sem gravar nada; o cérebro está como antes" (it wrote nothing; the brain is as before) and the exit code is `0`.

The agent's full output is kept in `~/.cache/cabecao/consolidate-runs/<id>.log`, for your user only.

## Undo

```bash
cabecao undo --session 01M7AJDQ796TP2A9ZCSAV7R9VT
```

undoes the whole consolidation with a revert commit; undoing that undo redoes everything. The restore point stays on the machine: `git reset --hard <tag>` goes back to it, discarding everything that came after (including what is not part of the consolidation). More in [Undo](./desfazer.md).

## Agents {#agentes}

Cabeção only calls an agent on its own when two things hold, checked against the official source: the agent's **terms** allow another program to run it with the credential in use, and it can be **restricted** to Cabeção's tools in non-interactive mode.

| Agent | `--agent` | MCP registration (`install-client`) | `--run` | Why |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | yes | yes | The terms allow running the unmodified `claude` binary with your own subscription or API key ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)); it can load only Cabeção's server and drop every built-in tool |
| Codex | `codex` | yes | only with an API key | OpenAI says to use an API key for programmatic use ([Authentication](https://learn.chatgpt.com/docs/auth)): `--run` requires `CODEX_API_KEY` or `OPENAI_API_KEY` and does not use the ChatGPT login. It can ignore your configuration, drop the shell, and lock writes in a read-only sandbox |
| Antigravity (`agy`) | `antigravity` | yes | no | The [Antigravity FAQ](https://antigravity.google/docs/faq/) says that wrapping `agy` inside other agents or applications "is not supported under consumer plans" and that using third-party software to access it violates the terms, with a risk of account suspension. Consolidate in a session of Antigravity itself: ask it to follow Cabeção's `consolidate` prompt, with the server registered by `cabecao install-client antigravity` |
| Gemini CLI | `gemini` | yes | no | It stopped serving personal accounts on June 18, 2026 and was replaced by Antigravity, with the same terms |
| Cursor Agent | `cursor` | yes | no | In non-interactive mode it has access to every tool, including shell and writes, and the documentation does not say what happens to an action that was not allowed when nobody is watching |
| GitHub Copilot CLI, OpenCode | `copilot`, `opencode` | VS Code: yes | no | They have options to restrict tools, but their terms and restrictions have not been checked with Cabeção yet |
| VS Code, Claude Desktop | `vscode`, `claude-desktop` | yes | no | They have no non-interactive mode |

Without `--agent`, Cabeção uses the `"agent"` in the machine's `config.json` (`~/.config/cabecao/config.json`; on Windows, `%APPDATA%\cabecao\config.json`) and, without it, the first one available in the order `claude-code`, `codex` (the latter only with an API key). The output says which one it picked and why. To pin one:

```json
{
  "machine": "my-mac",
  "defaultBrain": "/Users/you/cabecao",
  "agent": "codex"
}
```

The agent must be installed with its credential ready: Claude Code uses the login it already has (or `ANTHROPIC_API_KEY`), without Cabeção touching its configuration; Codex uses the API key from the environment. The default model is the cheapest one the agent lets you pick (`haiku` in Claude Code; `low` effort in Codex); change it with `--model`.

## What the agent can and cannot do

It can, only through Cabeção's tools: `recall`, `search`, `read`, `graph`, `facts`, `status`, `lint`, `remember`, `write_page`, `patch_page`, `relate`, and `consolidate` with `action: "finish"`.

It cannot:

- run commands, read or edit files by other means, or reach the network (each agent with the options in the table below);
- create or change rules (`memory/rules/`): a rule can only be **proposed**, in a note in `wiki/syntheses/`;
- write to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `index.md`, `log.md`, or outside the brain;
- push to the remote (`sync`), undo (`undo`), leave a note for the next session (`handoff_save`), or bring in outside content (`ingest`);
- archive notes (`forget`), unless you pass `--allow-forget`;
- write outside the consolidation's session: every write carries its id, which is why `undo --session` reaches everything.

The usual agent restrictions still apply; these come on top. How each agent is contained:

| Agent | How |
| --- | --- |
| Claude Code | `--strict-mcp-config --mcp-config <temporary>` (only Cabeção's server), `--tools ""` (no built-in tools), `--allowedTools mcp__cabecao__*`, `--permission-mode dontAsk --permission-prompts none` (any other request is denied), `--restricted` (none of your settings), `--no-session-persistence` |
| Codex | `CODEX_API_KEY` (the API key, which takes precedence over the ChatGPT login), `codex exec --ignore-user-config --ignore-rules --ephemeral --sandbox read-only`, `approval_policy = "never"`, `web_search = "disabled"`, without the shell, browser, screen, image, subagent, apps, and plugin tools; the server comes in through `-c mcp_servers.cabecao.*`, with its tools approved |

The details, with what is left out for each one, are in [Security](../seguranca.md#o-que-roda-sem-voce-olhando).

## See before running

`--dry-run` shows the command, the temporary configuration, and the script, without running anything or creating a restore point:

```text
$ cabecao consolidate --run --agent codex --dry-run
Agente: Codex (~/.local/bin/codex; escolhido com --agent).
Simulação (--dry-run): nada foi executado, nenhum ponto de restauração foi criado.
Aviso: o Codex só é chamado com chave de API (CODEX_API_KEY ou OPENAI_API_KEY): a OpenAI orienta usar chave de API em uso programático, e o login do ChatGPT não é usado. Fonte: https://learn.chatgpt.com/docs/auth

Diretório de trabalho: <pasta temporária> (vazia, apagada no fim)
Tempo limite: 20 min 0 s
Comando: ~/.local/bin/codex exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox read-only --cd '<pasta temporária>' --json --color never -c 'approval_policy="never"' -c 'web_search="disabled"' -c 'model_reasoning_effort="low"' --disable shell_tool --disable unified_exec ...
O roteiro vai pela entrada padrão.
Ambiente do agente (só os nomes; os valores não são mostrados): HOME, LANG, LOGNAME, PATH, TMPDIR, USER
```

Then come the restrictions, the temporary configuration, and the whole script.

Asking for an agent that is not part of `--run` answers with the reason and creates nothing:

```text
$ cabecao consolidate --run --agent antigravity
cabecao: o Cabeção não chama o agente "antigravity" sozinho: os termos do Antigravity não permitem: "Wrapping agy inside third-party coding agents or applications [...] is not supported under consumer plans", e usar software de terceiros para acessar o Antigravity viola os termos e pode suspender a conta (https://antigravity.google/docs/faq/). Para consolidar com o Antigravity, abra uma sessão nele e peça para seguir o prompt "consolidate" do Cabeção (ou os passos de "cabecao consolidate"), com as tools do servidor MCP registrado por "cabecao install-client antigravity".
Agentes que o Cabeção pode chamar: claude-code, codex.
```

## Schedule {#agendar}

`cabecao schedule` only schedules the sync. To consolidate periodically, use the system scheduler with Cabeção's full path and a `PATH` where the agent can be found (cron's is minimal). In a `crontab` (macOS and Linux), every Sunday at 3 a.m.:

```text
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/you/.local/bin
0 3 * * 0  cabecao consolidate --run --agent claude-code --timeout 20 >> /Users/you/cabecao-consolidate.log 2>&1
```

Run the same command by hand first. Each agent's login inside a scheduled task has not been tested: on macOS, a credential kept in the Keychain may not be available outside the graphical session, and then the run fails (without writing anything). The result of each run is in the log and in `~/.cache/cabecao/consolidate-runs/`. The consolidation does not push anything to the remote: the next sync (yours or the scheduled one) takes the commit.
