---
title: Sync automático
description: Sincronize o cérebro sozinho, no fim de cada sessão do Claude Code e de tempos em tempos pelo agendador do sistema.
sidebar_position: 10
---

O Cabeção não tem um serviço rodando o tempo todo. O sync acontece quando alguém pede: você (`cabecao sync`), o agente (tool `sync`) ou, se você ligar, duas formas automáticas:

| Quando | Como ligar |
| --- | --- |
| No fim de cada sessão do Claude Code | Instale o [plugin do Claude Code](./claude-code.md) |
| A cada N minutos, mesmo sem nenhuma sessão aberta | `cabecao schedule on` |

As duas usam o mesmo `cabecao sync`, com a mesma trava: se um sync já estiver rodando, o outro sai como "outro sync em andamento" e não faz nada. Elas gravam o resultado em `<cérebro>/.cabecao/logs/sync.log` (a pasta `.cabecao/` fica fora do git).

## Sync periódico com `schedule`

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

O `schedule on` registra o sync no agendador do seu sistema, só para o seu usuário e sem pedir administrador:

| Sistema | Onde fica |
| --- | --- |
| macOS | LaunchAgent em `~/Library/LaunchAgents/dev.cabecao.sync.plist` |
| Linux | Timer do `systemd --user` em `~/.config/systemd/user/cabecao-sync.service` e `.timer`. Sem systemd de usuário (WSL antigo, contêiner), uma linha no seu `crontab` |
| Windows | Tarefa "Cabecao Sync" no Agendador de Tarefas (`schtasks`) |

Escolha o intervalo com `--interval`, em minutos, de 5 a 1440 (o padrão é 30):

```bash
cabecao schedule on --interval 60
```

Rodar `on` de novo não duplica nada: com tudo igual, ele diz "já estava registrado assim"; com um intervalo novo, atualiza o registro.

### O que ele precisa

- **Uma instalação estável.** O agendador guarda o caminho do Node e o do programa `cabecao`. Rodando por `npx`, esse caminho fica numa pasta temporária, então o comando recusa:

  ```text
  $ npx cabecao schedule on
  cabecao: o agendamento precisa de uma instalação estável do cabecao: rodando por npx (ou pelo código-fonte), o caminho do programa muda e o agendador ficaria apontando para nada
  Instale com "npm i -g cabecao@latest" e rode "cabecao schedule on" de novo depois de instalar.
  ```

  Instale com `npm i -g cabecao` e rode `cabecao schedule on`. Se o Node vier de um gerenciador de versões (nvm, fnm, volta...) e você remover aquela versão, rode `on` de novo.
- **O cérebro padrão desta máquina.** O comando agendado é curto (`node cabecao.mjs sync --log`) e não leva a pasta do cérebro: ela vem da configuração que o `cabecao init` gravou. No Windows isso é obrigatório, porque o Agendador de Tarefas aceita no máximo 261 caracteres no comando.

### Ver e desligar

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

O `off` remove só o que o Cabeção criou. Um arquivo, uma tarefa ou uma linha do crontab com o mesmo nome que não tem a marca do Cabeção fica como está, e o `on` se recusa a sobrescrevê-lo. O `cabecao doctor` também mostra o agendamento e avisa se o Node ou o programa agendado sumiram.

### Particularidades de cada sistema

- **macOS:** o primeiro sync agendado pode fazer o sistema pedir permissão, se o cérebro estiver numa pasta protegida (como `~/Documents`).
- **Linux:** sem *linger*, o timer do systemd só roda enquanto você tem uma sessão aberta; o `on` avisa. Para rodar mesmo sem login: `loginctl enable-linger` (pode pedir sua senha). No crontab, o intervalo é arredondado para o que o cron consegue repetir (divisões da hora ou do dia).
- **Windows:** a tarefa roda só com você logado ("Interactive only"), o que dispensa senha e administrador. Uma janela de console pode piscar a cada execução.

## O log

Cada sync automático acrescenta um bloco a `<cérebro>/.cabecao/logs/sync.log`, com o início, o fim, o código de saída e o resultado. Quando o arquivo passa de 1 MB, ele vira `sync.log.1` e um novo começa. Se o processo agendado falhar antes de chegar ao log (o Node sumiu, por exemplo), o erro vai para `.cabecao/logs/schedule-stderr.log` (no macOS e no crontab) ou para o diário do systemd (`journalctl --user -u cabecao-sync`).

Para rodar um sync à mão e também registrar no log, use `cabecao sync --log`. Para disparar um em segundo plano e voltar na hora, `cabecao sync --detach`. A referência completa está na [CLI](../referencia/cli.md#cabecao-schedule).
