---
title: Sincronizar entre máquinas
description: Use o mesmo cérebro em várias máquinas, com um sync a cada sessão.
sidebar_position: 2
---

Cada máquina tem uma cópia completa do cérebro e o próprio índice local. O remoto git é o ponto de encontro.

## Ligar uma máquina nova

Instale o Cabeção e rode o `init` com a mesma URL. Dê um nome à máquina para reconhecê-la nos commits e nas cópias de conflito:

```bash
npm i -g cabecao@beta
cabecao init git@github.com:voce/cerebro.git --machine trabalho
```

O `init` reconhece o cérebro existente e só baixa. Detalhes em [Criar ou conectar um cérebro](../comecar/init.md#segunda-máquina-cérebro-existente).

## O dia a dia

Rode `cabecao sync` quando começar e quando terminar de trabalhar numa máquina:

```text
$ cabecao sync
Sync: ok. 1 commit recebido.
Recebidos: 1 commit · enviados: 0 · criados neste sync: 0
```

O que os agentes gravam vira commit na hora, mas só vai para o remoto no próximo sync. O `status` mostra o que está esperando:

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
Saúde: ok
Próximo passo: Rode sync para enviar as mudanças.
```

Os agentes também podem sincronizar pela tool `sync`. Peça "sincronize o cérebro" no fim da sessão.

:::tip[Sincronizar sem pensar nisso]
O Cabeção ainda não sincroniza sozinho. Se quiser, agende `cabecao sync` no agendador do seu sistema (cron, launchd, Agendador de Tarefas). Ele sai com 0 quando outro sync já está rodando, então não há problema em chamá-lo com frequência.
:::

## Sem rede

Sem rede, o sync sai com código 1 e status `offline`. Nada se perde: as gravações continuam como commits locais e vão no próximo sync que alcançar o remoto.

## Quando duas máquinas editam a mesma nota

Edições em partes diferentes da nota são juntadas pelo git. Edições no mesmo trecho viram uma cópia de conflito, e nada é descartado. Veja [Resolver um conflito](./resolver-conflito.md).

## Tirar uma máquina

Na máquina que sai, tire o registro dos clientes e apague a pasta do cérebro e a configuração da máquina:

```bash
cabecao install-client --remove --all
```

Depois apague `~/cabecao` e `~/.config/cabecao` (no Windows, `%APPDATA%\cabecao`). O remoto e as outras máquinas não são afetados. Antes, rode um último `cabecao sync` se houver algo não enviado.
