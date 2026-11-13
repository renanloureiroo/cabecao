---
title: Conectar aos clientes de IA
description: Registre o servidor MCP do Cabeção no Claude Code, Claude Desktop, Codex, Cursor, VS Code, Antigravity e Gemini CLI.
sidebar_position: 3
---

O `init` já registra o servidor MCP em todo cliente de IA que encontrar nesta máquina. Use `cabecao install-client` quando instalar um cliente depois, quando quiser ver a configuração antes de gravar, ou para tirar o registro.

Há três jeitos de um agente usar o seu cérebro, e eles se combinam:

| Jeito | Para quem | Como |
| --- | --- | --- |
| **Servidor MCP** | Qualquer cliente MCP, inclusive os sem terminal (Claude Desktop) | `cabecao install-client` (esta página) |
| **Skills** | Agentes com shell que leem skills: Claude Code, Codex, Cursor, VS Code, Antigravity, Gemini CLI | `cabecao install-skills` ([Usar o Cabeção com skills](../guias/skills.md)) |
| **Plugin** | Só o Claude Code: servidor embutido, briefing no início, sync no fim e as skills | `/plugin install cabecao@cabecao` ([Plugin do Claude Code](../guias/claude-code.md)) |

As skills não precisam do servidor: o agente roda `cabecao` no shell, sob as mesmas regras. Com o servidor também registrado, as skills mandam o agente preferir as tools.

## Clientes aceitos

| Cliente | Identificador | Onde o registro fica |
| --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude.json` (escopo do usuário), pelo comando `claude mcp add-json` quando ele existe |
| Claude Desktop | `claude-desktop` | `claude_desktop_config.json` na pasta de dados do aplicativo |
| Codex | `codex` | `~/.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/mcp.json` |
| VS Code | `vscode` | `~/.copilot/mcp-config.json` (e o `mcp.json` antigo do perfil, se a pasta existir) |
| Antigravity (CLI `agy`, IDE e App) | `antigravity` | `~/.gemini/config/mcp_config.json` (e o caminho antigo `~/.gemini/antigravity/mcp_config.json`, se a pasta existir) |
| Gemini CLI (legado) | `gemini` | `~/.gemini/settings.json` |

Um cliente conta como "detectado" quando o executável dele está no `PATH` ou a pasta de configuração dele existe. A pasta `~/.gemini` é dividida entre o Antigravity e o Gemini CLI: o Antigravity é detectado pelo `agy` ou pelas pastas `antigravity-cli`, `antigravity`, `antigravity-ide` ou `config` dentro dela; o Gemini CLI, pelo `gemini` ou pelo `~/.gemini/settings.json`.

## Antigravity e Gemini CLI

O Google trocou o Gemini CLI pelo **Antigravity CLI** (`agy`), que faz parte da plataforma Antigravity (CLI, IDE e App). Desde 18 de junho de 2026, o Gemini CLI não atende mais contas pessoais (gratuitas, Google AI Pro e Ultra); ele continua para licenças Gemini Code Assist Standard ou Enterprise e chaves pagas de API. O Antigravity guarda os servidores MCP num arquivo próprio, separado do `settings.json` do Gemini CLI:

```text
$ cabecao install-client antigravity
Antigravity: registrado
  ~/.gemini/config/mcp_config.json: registrado
Reinicie o cliente para ele enxergar a mudança.
```

O `agy mcp list` mostra o servidor `cabecao` em seguida. O IDE e o App do Antigravity leem o mesmo arquivo. Usar o Cabeção numa sessão do Antigravity é o uso normal do produto; o que o Cabeção não faz é chamar o Antigravity sozinho, pelo `consolidate --run`, porque os termos do plano pessoal não permitem (veja [Consolidar com um agente](../guias/consolidar-com-agente.md#agentes)). Na atualização para a versão 2.0, o caminho antigo (`~/.gemini/antigravity/mcp_config.json`) virou um link para o novo; o Cabeção grava pelo link, sem trocá-lo por um arquivo.

Se você ainda usa o Gemini CLI, `gemini` continua funcionando, com um aviso:

```text
$ cabecao install-client gemini
Gemini CLI: registrado
  aviso: o Gemini CLI deixou de atender contas pessoais em 18/06/2026 e foi substituído pelo Antigravity: se é o seu caso, use "cabecao install-client antigravity"
  ~/.gemini/settings.json: registrado
Reinicie o cliente para ele enxergar a mudança.
```

Quem já tinha registrado o `gemini` não perde nada: o registro fica onde estava, e `cabecao install-client --remove gemini` o tira.

## Conectar ao Claude Code

:::tip[Plugin ou registro direto: um ou outro]
No Claude Code, o [plugin do Cabeção](../guias/claude-code.md) faz mais do que o registro abaixo: traz o servidor embutido, põe o briefing do cérebro no início de cada sessão e sincroniza no fim. Use um ou outro, não os dois: as tools apareceriam em dobro. O `init` registra o servidor direto mesmo com o plugin instalado, e então avisa; o `cabecao doctor` também avisa e diz como tirar o registro direto (`cabecao install-client --remove claude-code`).
:::

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

Os caminhos dependem da sua instalação. O servidor sempre é registrado como `cabecao mcp --brain <pasta>`. Com uma instalação global, o registro aponta direto para o Node e para o arquivo do Cabeção, o que evita de 0,5 a 1,4 s de `npx` a cada sessão. Com `--npx` (ou quando você rodou o Cabeção por `npx`), o registro usa `npx -y cabecao@<versão> mcp`, com a versão fixada: sem ela, o `npx` poderia baixar outra versão a cada sessão.

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
ok     Clientes MCP             2 clientes registrados
                                - Codex: ~/.codex/config.toml: registrado para este cérebro
                                - Cursor: ~/.cursor/mcp.json: registrado para este cérebro
```

Ele também acusa, como falha, um registro que aponta para um Node (ou um arquivo do Cabeção) que não existe mais, por exemplo depois de remover uma versão do Node com o nvm, o fnm ou o Volta: rode `cabecao install-client --all` de novo. E avisa quando o plugin do Claude Code e o registro direto estão ativos juntos.

Todas as opções estão na [referência da CLI](../referencia/cli.md#cabecao-install-client).
