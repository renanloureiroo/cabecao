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
| An Obsidian vault or a folder of Markdown | Adopts it: adds the Cabeção configuration without moving any file |
| Something else (a code project, for example) | Refuses and explains; nothing is left behind |

Then it builds the local index, registers the MCP server in the AI clients it finds (like `cabecao install-client --all`) and runs [`doctor`](../referencia/cli.md#cabecao-doctor).

The brain lives in `~/cabecao`. For another folder, use `--dir`. The machine name comes from the computer name; to choose it, use `--machine`. It shows up in commits and in the names of conflict copies.

## Empty repository

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
Pasta do cérebro: ~/cabecao (máquina notebook)

Repositório: Repositório vazio: estrutura do cérebro criada na branch main e enviada para git@github.com:voce/cerebro.git.

Índice local: 0 notas indexadas em 2 ms.

Clientes de IA:
  Claude Code: registrado
    ~/.claude.json: registrado
  Reinicie o cliente para ele enxergar a mudança.

Diagnóstico (cabecao doctor, sem consultar o remoto de novo):
  ok     Node.js                  v24.21.0
  ok     git                      2.54.0
  ok     Cérebro                  ~/cabecao (esquema 1)
  ok     Configuração da máquina  máquina "notebook"
  ok     Identidade do git        Ana Exemplo <ana@exemplo.invalid>
  ok     Assinatura de commits    commit.gpgsign desligado
  ok     Remoto                   origin (git@github.com:voce/cerebro.git); não consultado (--offline)
  ok     .gitignore               tem as linhas que o Cabeção precisa
  ok     .gitattributes           tem as linhas que o Cabeção precisa
  ok     Banco local              em dia com o último commit (0 nota(s), varrido em 2026-11-13 00:03)
  ok     Travas                   nenhuma trava órfã
  ok     Operações interrompidas  nenhuma
  ok     Conflitos                nenhum pendente
  ok     Clientes MCP             1 cliente(s) registrado(s)
                                  - Claude Code: ~/.claude.json: registrado para este cérebro

  14 ok, 0 avisos, 0 falhas.

Próximos passos:
  - Em outra máquina, rode cabecao init git@github.com:voce/cerebro.git.
```

The lines that start with `cabecao:` show progress and go to standard error. The structure it creates is described in [Brain structure](../conceitos/estrutura.md).

## Second machine (existing brain)

On the other machine, install Cabeção and run the same command, with the same URL (start of the output; the diagnostics come after):

```text
$ cabecao init git@github.com:voce/cerebro.git --machine trabalho
cabecao: consultando o remoto...
cabecao: baixando o repositório...
cabecao: vendo o que há no repositório...
cabecao: gravando a configuração desta máquina...
cabecao: montando o índice local...
Pasta do cérebro: ~/cabecao (máquina trabalho)

Repositório: Cérebro existente: clonado em ~/cabecao (branch main).

Índice local: 3 notas indexadas em 41 ms.

Clientes de IA:
  Claude Code: registrado
    ~/.claude.json: registrado
  Reinicie o cliente para ele enxergar a mudança.
```

Nothing in the repository changes. The local index is built from the notes, and the memories saved on the first machine are already visible to the agents on this one. To keep both up to date, see [Sync between machines](../guias/sincronizar-maquinas.md).

## Obsidian vault or Markdown folder

If the repository already has notes, Cabeção adopts what is there. No file is moved or renamed (start of the output):

```text
$ cabecao init git@github.com:voce/vault-obsidian.git --dir ~/Obsidian/Notas --machine notebook --no-clients
Pasta do cérebro: ~/Obsidian/Notas (máquina notebook)

Repositório: Vault adotado sem mover nenhum arquivo: .cabecao.json, .gitattributes, .gitignore, AGENTS.md, CLAUDE.md acrescentados ou completados e enviados na branch main.

Índice local: 3 notas indexadas em 7 ms.
```

The folders that already have notes are added to the list of note folders in `.cabecao.json`, next to `wiki`, `memory` and `raw`, where Cabeção saves new notes. The details are in [Adopt an existing vault](../guias/adotar-vault.md).

## This machine only

Without a URL, the brain is created locally only, with no remote (start of the output):

```text
$ cabecao init --machine notebook --no-clients
Pasta do cérebro: ~/cabecao (máquina notebook)

Repositório: Cérebro criado só nesta máquina, em ~/cabecao (branch main). Nenhum remoto foi ligado.
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
