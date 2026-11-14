---
title: Sincronizar entre máquinas
description: Use o mesmo cérebro em várias máquinas, com um sync a cada sessão.
sidebar_position: 2
---

Cada máquina tem uma cópia completa do cérebro e o próprio índice local. O remoto git é o ponto de encontro.

## Ligar uma máquina nova

Instale o Cabeção e rode o `init` com a mesma URL. Dê um nome à máquina para reconhecê-la nos commits e nas cópias de conflito:

```bash
npm i -g cabecao
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
Busca por significado: desativada ("cabecao embeddings on" ativa)
Respostas (ask): opcional, desligado; nada sai da máquina ("cabecao llm on" ativa)
Saúde: ok
Próximo passo: Rode o sync para enviar as mudanças.
Opcional:
  ...
```

Os agentes também podem sincronizar pela tool `sync`. Peça "sincronize o cérebro" no fim da sessão.

:::tip[Sincronizar sem pensar nisso]
Ligue o [sync automático](./sync-automatico.md): `cabecao schedule on` registra o `cabecao sync` no agendador do sistema, que o roda a cada intervalo. O sync sai com 0 quando outro já está rodando, então não há problema em chamá-lo com frequência.
:::

## Sem rede

Sem rede, o sync sai com código 1 e status `offline`. Nada se perde: as gravações continuam como commits locais e vão no próximo sync que alcançar o remoto.

## Quando duas máquinas editam a mesma nota

Edições em partes diferentes da nota são juntadas pelo git. Edições no mesmo trecho viram uma cópia de conflito, e nada é descartado. Veja [Resolver um conflito](./resolver-conflito.md).

## Tirar uma máquina

Na máquina que sai, tire o Cabeção (os registros nos clientes, as skills, o sync agendado, a configuração da máquina e o cache) e depois apague a pasta do cérebro:

```bash
cabecao uninstall
```

Depois apague `~/cabecao`. O remoto e as outras máquinas não são afetados. Antes, rode um último `cabecao sync` se houver algo não enviado. Mais em [Atualizar e desinstalar](./atualizar.md#desinstalar).
