---
title: Automatic sync
description: Sync the brain on its own, at the end of every Claude Code session and periodically through the system scheduler.
sidebar_position: 10
---

Cabeção has no service running all the time. A sync happens when someone asks for it: you (`cabecao sync`), the agent (the `sync` tool) or, if you turn them on, two automatic ways:

| When | How to turn it on |
| --- | --- |
| At the end of every Claude Code session | Install the [Claude Code plugin](./claude-code.md) |
| Every N minutes, even with no session open | `cabecao schedule on` |

Both use the same `cabecao sync`, with the same lock: if a sync is already running, the other ends as "another sync in progress" and does nothing. They write the result to `<brain>/.cabecao/logs/sync.log` (the `.cabecao/` folder stays out of git).

## Periodic sync with `schedule`

```bash
cabecao schedule on
```

```text
Sync periódico registrado: a cada 30 min, pelo LaunchAgent do macOS.
Comando: /usr/local/bin/node ~/.npm-global/lib/node_modules/cabecao/dist/cabecao.mjs sync --log
Cérebro: ~/cabecao
Log: ~/cabecao/.cabecao/logs/sync.log
Arquivo: ~/Library/LaunchAgents/dev.cabecao.sync.plist
Para desligar: cabecao schedule off
```

`schedule on` registers the sync with your system's scheduler, for your user only and without asking for administrator rights:

| System | Where it lives |
| --- | --- |
| macOS | LaunchAgent at `~/Library/LaunchAgents/dev.cabecao.sync.plist` |
| Linux | A `systemd --user` timer at `~/.config/systemd/user/cabecao-sync.service` and `.timer`. Without user systemd (old WSL, containers), a line in your `crontab` |
| Windows | The "Cabecao Sync" task in Task Scheduler (`schtasks`) |

Choose the interval with `--interval`, in minutes, from 5 to 1440 (the default is 30):

```bash
cabecao schedule on --interval 60
```

Running `on` again does not duplicate anything: when nothing changed, it says "já estava registrado assim" (already registered like this); with a new interval, it updates the registration.

### What it needs

- **A stable installation.** The scheduler stores the path to Node and to the `cabecao` program. When run through `npx`, that path is in a temporary folder, so the command refuses:

  ```text
  $ npx cabecao schedule on
  cabecao: o agendamento precisa de uma instalação estável do cabecao: rodando por npx (ou pelo código-fonte), o caminho do programa muda e o agendador ficaria apontando para nada
  Instale com "npm i -g cabecao@beta" e rode "cabecao schedule on" de novo depois de instalar.
  ```

  Install with `npm i -g cabecao@beta` and run `cabecao schedule on`. If Node comes from a version manager (nvm, fnm, volta...) and you remove that version, run `on` again.
- **This machine's default brain.** The scheduled command is short (`node cabecao.mjs sync --log`) and does not carry the brain folder: it comes from the configuration `cabecao init` saved. On Windows this is mandatory, because Task Scheduler accepts at most 261 characters in the command.

### Check and turn off

```text
$ cabecao schedule status
Sync periódico: ligado, a cada 30 min, pelo LaunchAgent do macOS.
Comando: /usr/local/bin/node ~/.npm-global/lib/node_modules/cabecao/dist/cabecao.mjs sync --log
Cérebro: ~/cabecao
Log: ~/cabecao/.cabecao/logs/sync.log
No agendador: estado not running, último código 0

$ cabecao schedule off
Sync periódico removido do LaunchAgent do macOS.
Removido: ~/Library/LaunchAgents/dev.cabecao.sync.plist
```

`off` removes only what Cabeção created. A file, a task, or a crontab line with the same name that does not carry Cabeção's marker stays as it is, and `on` refuses to overwrite it. `cabecao doctor` also shows the schedule and warns if the scheduled Node or program is gone.

### Details for each system

- **macOS:** the first scheduled sync may make the system ask for permission, if the brain is in a protected folder (such as `~/Documents`).
- **Linux:** without *linger*, the systemd timer only runs while you have a session open; `on` warns about it. To run even without logging in: `loginctl enable-linger` (it may ask for your password). With crontab, the interval is rounded to what cron can repeat (divisions of the hour or the day).
- **Windows:** the task only runs while you are logged in ("Interactive only"), which avoids passwords and administrator rights. A console window may flash on each run.

## The log

Each automatic sync appends a block to `<brain>/.cabecao/logs/sync.log`, with the start, the end, the exit code, and the result. When the file goes over 1 MB, it becomes `sync.log.1` and a new one starts. If the scheduled process fails before reaching the log (Node is gone, for example), the error goes to `.cabecao/logs/schedule-stderr.log` (on macOS and with crontab) or to the systemd journal (`journalctl --user -u cabecao-sync`).

To run a sync by hand and also record it in the log, use `cabecao sync --log`. To start one in the background and return right away, `cabecao sync --detach`. The full reference is in the [CLI](../referencia/cli.md#cabecao-schedule).
