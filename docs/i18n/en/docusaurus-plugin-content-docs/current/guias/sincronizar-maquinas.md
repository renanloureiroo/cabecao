---
title: Sync across machines
description: Use the same brain on several machines, with a sync each session.
sidebar_position: 2
---

Each machine has a full copy of the brain and its own local index. The git remote is the meeting point.

## Connect a new machine

Install Cabeção and run `init` with the same URL. Give the machine a name so you can recognize it in commits and conflict copies:

```bash
npm i -g cabecao
cabecao init git@github.com:voce/cerebro.git --machine trabalho
```

`init` recognizes the existing brain and only downloads it. Details in [Create or connect a brain](../comecar/init.md#second-machine-existing-brain).

## Day to day

Run `cabecao sync` when you start and when you finish working on a machine:

```text
$ cabecao sync
Sync: ok. 1 commit recebido.
Recebidos: 1 commit · enviados: 0 · criados neste sync: 0
```

What agents write becomes a commit right away, but it only goes to the remote on the next sync. `status` shows what is waiting:

```text
$ cabecao status
Cérebro: ~/cabecao (máquina notebook, esquema 1)
Notas: 1 (preference 1)
Links quebrados: 0
Sync: branch main ↔ origin/main (git@github.com:voce/meu-cerebro.git)
  Último sync: nunca
  Commits não enviados: 1 · do remoto, ainda não integrados: 0
  Mudanças feitas fora do Cabeção, esperando o sync: 0
Conflitos pendentes: nenhum
Busca por significado: desativada ("cabecao embeddings on" ativa)
Respostas (ask): opcional, desligado; nada sai da máquina ("cabecao llm on" ativa)
Saúde: ok
Próximo passo: Rode o sync para enviar as mudanças.
Opcional (rode quando quiser):
  ...
```

Agents can also sync through the `sync` tool. Ask "sync the brain" at the end of the session.

:::tip[Sync without thinking about it]
Turn on [automatic sync](./sync-automatico.md): `cabecao schedule on` registers `cabecao sync` in the system scheduler, which runs it at every interval. Sync exits with 0 when another one is already running, so it is fine to call it often.
:::

## Offline

Without a network, sync exits with code 1 and status `offline`. Nothing is lost: writes stay as local commits and go out on the next sync that reaches the remote.

## When two machines edit the same note

Edits to different parts of the note are merged by git. Edits to the same passage become a conflict copy, and nothing is discarded. See [Resolve a conflict](./resolver-conflito.md).

## Remove a machine

On the machine that is leaving, remove Cabeção (the client registrations, the skills, the scheduled sync, the machine configuration, and the cache) and then delete the brain folder:

```bash
cabecao uninstall
```

Then delete `~/cabecao`. The remote and the other machines are not affected. Before that, run one last `cabecao sync` if anything has not been pushed. More in [Update and uninstall](./atualizar.md#uninstall).
