<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/marca/banner-escuro.png">
    <img src="assets/marca/banner.png" alt="Cabeção: a second brain in Markdown and git, served over MCP">
  </picture>
</p>

<p align="center">
  Your second brain in Markdown and git, for you and your AI agents, served over MCP.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cabecao"><img src="https://img.shields.io/npm/v/cabecao/beta?label=npm%40beta&color=14121c" alt="npm version (beta)"></a>
  <a href="https://github.com/renanloureiroo/cabecao/actions/workflows/ci.yml"><img src="https://github.com/renanloureiroo/cabecao/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/renanloureiroo/cabecao?color=14121c" alt="MIT license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/cabecao/beta?color=14121c" alt="Node.js"></a>
</p>

<!-- README-I18N:START -->

[Português](./README.md) | **English**

<!-- README-I18N:END -->

Your notes are Markdown files in a git repository you own, on any host. AI agents (Claude Code, Codex, Cursor and others) read and write them over MCP, and every write becomes a commit you can undo with one command. The name is a nod to Cabeção ("big head") from the Brazilian TV show *Malhação*.

> **Beta.** The current version is `0.1.0-beta.1`. It works day to day, but commands and formats may still change before 1.0. The CLI prints its messages in Portuguese for now; the MCP tools that agents use are described in English.

## What it looks like

```text
$ cabecao init git@github.com:voce/cerebro.git
Pasta do cérebro: ~/cabecao (máquina notebook)

Repositório: Repositório vazio: estrutura do cérebro criada na branch main e enviada para git@github.com:voce/cerebro.git.

Índice local: 0 notas indexadas em 2 ms.

Clientes de IA:
  Claude Code: registrado
    ~/.claude.json: registrado
  Reinicie o cliente para ele enxergar a mudança.
...
  14 ok, 0 avisos, 0 falhas.
```

In a Claude Code session you say "remember that the payment tests only pass with `TZ=UTC`", and the agent calls the `remember` tool:

```json
{
  "op": "01M79DRQR9648E1JZ60MF0EBNN",
  "path": "memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md",
  "action": "add",
  "commit": "1af64e1dc48f5627dd086474c571b22326eaa3c0"
}
```

The note is a plain `.md` file. In the next session, on any machine, it comes back in the agent's `recall`. And from the terminal:

```text
$ cabecao search "testes pagamento"
1 resultado(s) para "testes pagamento", com todos os termos (validade em 2026-11-13):

1. Testes de pagamento precisam do fuso fixo  [gotcha · project:pagamentos]  vigente
   memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md
   Os «testes» do serviço de pagamentos falham perto da meia-noite se o fuso não for fixo. Rode com `TZ=UTC npm test`.
```

## Why

- **Your data, in your format.** Markdown in a git repository you control. It opens in Obsidian or any editor, and stays yours if you stop using Cabeção.
- **Any host.** GitHub, GitLab, Bitbucket, Gitea, your own server, or just your machine. Only git, no provider API.
- **Memory across sessions and machines.** What you teach in one conversation comes back in the next, in any MCP client.
- **Everything is reversible.** Every write is an identified commit; `cabecao undo` reverts one operation or a whole agent session.
- **Agents with limits.** They cannot create rules, edit instruction files or store secrets, and they leave a trace when they change one of your notes.

## Install

Requires Node.js 22.16+ (24 recommended) and git 2.38+. Create an **empty, private** repository first.

```bash
npm i -g cabecao@beta
cabecao init git@github.com:voce/cerebro.git
cabecao doctor
```

`init` also adopts an existing Obsidian vault without moving files, and without a URL it creates a local-only brain.

## Connect to Claude Code

`init` already registers the MCP server in the clients it finds. To register later:

```bash
cabecao install-client claude-code
```

Restart Claude Code. It also works with Claude Desktop, Codex, Cursor, VS Code and Gemini CLI (`cabecao install-client --all`).

## Features

| Today (`0.1.0-beta.1`) | Coming soon |
| --- | --- |
| `init` on any git remote, adopting Obsidian vaults | Search by meaning, with a local model |
| `sync` that never loses data: a conflict copy instead of an overwrite | Claude Code plugin with hooks |
| Keyword search with validity over time (`--as-of`) | Review, consolidation and "forget" for memories |
| Graph: wikilinks, typed relations, facts and unlinked mentions | Obsidian integration |
| MCP server with 12 tools and agent restrictions | Claude Desktop package |
| `undo` per operation or session; secret scanner | |

## Documentation

Everything is on the site: **[renanloureiroo.github.io/cabecao/en](https://renanloureiroo.github.io/cabecao/en/)**, in English and Portuguese. Quick start, concepts, guides (Obsidian, conflicts, undo, rules), CLI and MCP tool reference, security and troubleshooting.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) (in Portuguese) for how to run the project and the conventions. To report a vulnerability, use GitHub's private vulnerability reporting.

## License

[MIT](LICENSE) © Renan Pereira Loureiro
