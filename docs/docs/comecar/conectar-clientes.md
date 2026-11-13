---
title: Conectar aos clientes de IA
description: Registre o servidor MCP do Cabeção no Claude Code, Claude Desktop, Codex, Cursor, VS Code e Gemini CLI.
sidebar_position: 3
---

O `init` já registra o servidor MCP em todo cliente de IA que encontrar nesta máquina. Use `cabecao install-client` quando instalar um cliente depois, quando quiser ver a configuração antes de gravar, ou para tirar o registro.

## Clientes aceitos

| Cliente | Identificador | Onde o registro fica |
| --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude.json` (escopo do usuário), pelo comando `claude mcp add-json` quando ele existe |
| Claude Desktop | `claude-desktop` | `claude_desktop_config.json` na pasta de dados do aplicativo |
| Codex | `codex` | `~/.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/mcp.json` |
| VS Code | `vscode` | `~/.copilot/mcp-config.json` (e o `mcp.json` antigo do perfil, se a pasta existir) |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` |

Um cliente conta como "detectado" quando o executável dele está no `PATH` ou a pasta de configuração dele existe.

## Conectar ao Claude Code

```bash
cabecao install-client claude-code
```

```text
Claude Code: registrado
  ~/.claude.json: registrado
Reinicie o cliente para ele enxergar a mudança.
```

Reinicie o Claude Code. O servidor aparece com o nome `cabecao` e as tools descritas na [referência MCP](../referencia/mcp.md).

## Todos os clientes detectados

```bash
cabecao install-client --all
```

Rodar de novo não duplica nada:

```text
Claude Code: já estava registrado
  ~/.claude.json: já estava registrado
Cursor: já estava registrado
  ~/.cursor/mcp.json: já estava registrado
```

## Ver antes de gravar

`--print` mostra a configuração e não grava nada. É útil para configurar à mão um cliente que o Cabeção não conhece:

```text
$ cabecao install-client --print codex
# Codex
# ~/.codex/config.toml
[mcp_servers.cabecao]
command = "/caminho/do/node"
args = ["/caminho/do/cabecao/dist/cabecao.mjs", "mcp", "--brain", "~/cabecao"]
```

Os caminhos dependem da sua instalação. O servidor sempre é registrado como `cabecao mcp --brain <pasta>`. Com uma instalação global, o registro aponta direto para o Node e para o arquivo do Cabeção, o que evita de 0,5 a 1,4 s de `npx` a cada sessão. Com `--npx` (ou quando você rodou o Cabeção por `npx`), o registro usa `npx -y cabecao mcp`.

## Tirar o registro

```text
$ cabecao install-client --remove claude-code
Claude Code: registro removido
  ~/.claude.json: registro removido (original guardado em ~/.claude.json.bak)
Reinicie o cliente para ele enxergar a mudança.
```

O Cabeção só mexe na entrada `cabecao`. Os outros servidores e chaves do arquivo ficam como estavam, e a primeira alteração guarda uma cópia do arquivo original ao lado, com o sufixo `.bak`.

## Conferir

O `doctor` lê os arquivos dos clientes (sem executar nada) e diz quais têm o registro deste cérebro:

```text
ok     Clientes MCP             1 cliente(s) registrado(s)
                                - Claude Code: ~/.claude.json: registrado para este cérebro
```

Todas as opções estão na [referência da CLI](../referencia/cli.md#cabecao-install-client).
