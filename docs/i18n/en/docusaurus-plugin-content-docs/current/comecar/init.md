---
title: Create or connect a brain
description: What cabecao init does with each kind of repository, on a new machine or on a second machine.
sidebar_position: 2
---

`cabecao init` is the only setup command. You pass the repository URL and it decides the rest based on what it finds there, without asking anything:

```bash
cabecao init git@github.com:voce/cerebro.git
```

| The repository has | What happens |
| --- | --- |
| Nothing (it was just created), or only README and LICENSE | Creates the brain structure, makes the first commit and pushes |
| A Cabeção brain (`.cabecao.json` at the root) | Only downloads it: this is the second machine |
| An Obsidian vault or a folder of Markdown | Adopts it: clones it into a new folder and adds the Cabeção configuration, without moving or renaming any note |
| Something else (a code project, for example) | Refuses and explains; nothing is left behind |

Then it builds the local index, registers the MCP server in the AI clients it finds (like `cabecao install-client --all`), runs [`doctor`](../referencia/cli.md#cabecao-doctor), and ends by telling you what to test and what else you can turn on.

The brain lives in `~/cabecao`. For another folder, use `--dir`. The machine name comes from the computer name; to choose it, use `--machine`. It shows up in commits and in the names of conflict copies.

## Empty repository

Real output, on a machine with Codex and Cursor installed:

```text
$ cabecao init git@github.com:voce/cerebro.git --machine notebook
cabecao: consultando o remoto...
cabecao: baixando o repositório...
cabecao: vendo o que há no repositório...
cabecao: criando a estrutura do cérebro...
cabecao: fazendo o commit inicial...
cabecao: gravando a configuração desta máquina...
cabecao: enviando ao remoto...
cabecao: montando o índice local...
Pronto. Seu cérebro está em ~/cabecao (máquina notebook) e em git@github.com:voce/cerebro.git.

Repositório vazio: estrutura do cérebro criada na branch main e enviada para git@github.com:voce/cerebro.git.
Índice local: 0 notas indexadas em 2 ms.

Agentes:
  Codex   servidor MCP registrado em ~/.codex/config.toml
  Cursor  servidor MCP registrado em ~/.cursor/mcp.json
  Reinicie os agentes que estiverem abertos para eles enxergarem o Cabeção.

Teste agora:
  1. No Codex, peça: "guarde que eu prefiro respostas curtas, em tópicos"
  2. Numa conversa nova, pergunte: "como eu prefiro as respostas?"
  3. Ou confira aqui: cabecao search "respostas curtas"

Opcional (rode quando quiser):
  cabecao install-skills  ensina Codex e Cursor a usar o cérebro pela linha de
                          comando (skills)
  cabecao schedule on     sincroniza sozinho a cada 30 min; sem isso, o que o
                          agente grava só vai às outras máquinas com
                          "cabecao sync"
  cabecao embeddings on   busca por significado, que roda nesta máquina (baixa
                          um runtime e um modelo: centenas de MB)

Diagnóstico: 18 ok, 0 avisos, 0 falhas. Detalhes: cabecao doctor

Depois:
  - Em outra máquina, rode cabecao init git@github.com:voce/cerebro.git.
```

The lines that start with `cabecao:` show progress and go to standard error. The structure it creates is described in [Brain structure](../conceitos/estrutura.md).

### Test it now

The "Teste agora" block is the fastest way to see Cabeção working: restart the agent, ask it to remember a preference and, in a new conversation, ask about it. The agent saves with `remember` and finds it with `recall` or `search`, and you check in the terminal with `cabecao search`. With no agent detected, the first step tells you to connect one first ([Connect to AI clients](./conectar-clientes.md)).

### The optional steps

`init` asks nothing (only the URL decides). At the end, it lists up to three next steps **detected** on your machine, each with its command:

| Optional | Shows up when |
| --- | --- |
| `cabecao install-skills` | There is an agent that reads skills (Claude Code without the plugin, Codex, Cursor, VS Code, Antigravity, Gemini CLI) and the Cabeção skills are not in it yet. See [Use Cabeção with skills](../guias/skills.md) |
| `cabecao schedule on` | The brain has a remote and automatic sync is off. See [Automatic sync](../guias/sync-automatico.md) |
| `cabecao embeddings on` | Semantic search is off, or the brain already uses one and it still has to be turned on on this machine (then it names the model). See [Search](../guias/buscar.md) |
| `cabecao obsidian setup` | The brain has the `.obsidian` folder and the setup has not run yet. See [Using it with Obsidian](../guias/obsidian.md) |

`cabecao status` and `cabecao doctor` repeat, at the end, the optional steps that are still pending. The diagnostics at the end of `init` are short: one line with the count and only the items that are not `ok`; the full version is `cabecao doctor`.

## Second machine (existing brain)

On the other machine, install Cabeção and run the same command, with the same URL (start of the output, on a machine with Claude Code; the test and the optional steps come after):

```text
$ cabecao init git@github.com:voce/cerebro.git --machine trabalho
cabecao: consultando o remoto...
cabecao: baixando o repositório...
cabecao: vendo o que há no repositório...
cabecao: gravando a configuração desta máquina...
cabecao: montando o índice local...
Pronto. Seu cérebro está em ~/cabecao (máquina trabalho) e em git@github.com:voce/cerebro.git.

Cérebro existente: clonado em ~/cabecao (branch main).
Índice local: 0 notas indexadas em 2 ms.

Agentes:
  Claude Code  servidor MCP registrado (pelo comando "claude mcp", escopo user)
  Reinicie os agentes que estiverem abertos para eles enxergarem o Cabeção.
```

Nothing in the repository changes. The local index is built from the notes, and the memories saved on the first machine are already visible to the agents on this one. To keep both up to date, see [Sync between machines](../guias/sincronizar-maquinas.md).

## Obsidian vault or Markdown folder

If the repository already has notes, Cabeção adopts what is there: it clones the vault into a new folder and adds its configuration, without moving, renaming or changing any note (start of the output):

```text
$ cabecao init git@github.com:voce/vault.git --machine notebook
Pronto. Seu cérebro está em ~/cabecao (máquina notebook) e em git@github.com:voce/vault.git.

Vault adotado: .cabecao.json, .gitattributes, .gitignore, AGENTS.md, CLAUDE.md acrescentados ou completados e enviados na branch main; nenhuma nota foi movida, renomeada ou alterada.
Índice local: 1 nota indexada em 4 ms.

Obsidian: O cérebro é a pasta ~/cabecao, um clone novo do vault. Se o Obsidian abre este vault de outra pasta, ele continua abrindo aquela cópia, que não recebe o que os agentes gravam aqui: no Obsidian, use "Abrir pasta como cofre" (Open folder as vault) e escolha ~/cabecao. Depois de conferir que está tudo aqui, apague a cópia antiga ou deixe de usá-la.
```

The brain is the new folder: open it in Obsidian.

The folders that already have notes are added to the list of note folders in `.cabecao.json`, next to `wiki`, `memory` and `raw`, where Cabeção saves new notes. The details are in [Adopt an existing vault](../guias/adotar-vault.md).

## This machine only

Without a URL, the brain is created locally only, with no remote (start of the output):

```text
$ cabecao init --machine notebook --no-clients
Pronto. Seu cérebro está em ~/cabecao (máquina notebook), só nesta máquina.

Cérebro criado só nesta máquina, em ~/cabecao (branch main). Nenhum remoto foi ligado.
```

Everything works the same, including `undo`: the history is a local git repository. `sync` only warns that there is no remote. To connect one later, create an empty, private repository and, in the brain folder, run:

```bash
git remote add origin git@github.com:voce/cerebro.git
git push -u origin main
cabecao sync
```

## When init refuses

A repository that looks like a code project (`package.json`, `src/`, `Cargo.toml` and other markers) does not become a brain:

```text
$ cabecao init git@github.com:voce/projeto-codigo.git --no-clients
O cérebro não foi criado: git@github.com:voce/projeto-codigo.git não parece um cérebro nem um vault de notas: parece um projeto de código: tem package.json, src/. Nada foi criado nesta máquina nem alterado no remoto.
O que fazer: use um repositório vazio (de preferência privado) ou um vault de notas em Markdown. Ou comece só local: "cabecao init" sem a URL.
```

The exit code is 1 and nothing is left behind, neither on the machine nor on the remote. Address and credential errors are covered in [Troubleshooting](../problemas.md).

## Options

| Option | What it does |
| --- | --- |
| `--dir <pasta>` | Brain folder (default: `~/cabecao`) |
| `--machine <nome>` | Name of this machine (default: the computer name). Converted to lowercase letters, digits and hyphens, up to 32 characters: `"Meu PC"` becomes `meu-pc` |
| `--no-clients` | Does not register the MCP server in the AI clients |

The full list, with the global options, is in the [CLI reference](../referencia/cli.md#cabecao-init).
