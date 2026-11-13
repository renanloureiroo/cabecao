---
title: Criar ou conectar um cérebro
description: O que o cabecao init faz em cada tipo de repositório, numa máquina nova ou na segunda máquina.
sidebar_position: 2
---

`cabecao init` é o único comando de instalação. Você passa a URL do repositório e ele decide o resto pelo que encontra lá, sem perguntar nada:

```bash
cabecao init git@github.com:voce/cerebro.git
```

| O repositório tem | O que acontece |
| --- | --- |
| Nada (acabou de ser criado), ou só README e LICENSE | Cria a estrutura do cérebro, faz o primeiro commit e envia |
| Um cérebro do Cabeção (`.cabecao.json` na raiz) | Só baixa: é a segunda máquina |
| Um vault do Obsidian ou uma pasta de Markdown | Adota: clona numa pasta nova e acrescenta a configuração do Cabeção, sem mover nem renomear nenhuma nota |
| Outra coisa (um projeto de código, por exemplo) | Recusa e explica; nada fica para trás |

Depois ele monta o índice local, registra o servidor MCP nos clientes de IA que encontrar (como `cabecao install-client --all`), roda o [`doctor`](../referencia/cli.md#cabecao-doctor) e termina dizendo o que testar e o que mais dá para ligar.

O cérebro fica em `~/cabecao`. Para outra pasta, use `--dir`. O nome da máquina sai do nome do computador; para escolher, use `--machine`. Ele aparece nos commits e no nome das cópias de conflito.

## Repositório vazio

Saída real, numa máquina com o Codex e o Cursor instalados:

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

As linhas que começam com `cabecao:` mostram o progresso e vão para a saída de erro. A estrutura criada está em [Estrutura do cérebro](../conceitos/estrutura.md).

### Teste agora

O bloco "Teste agora" é o jeito mais rápido de ver o Cabeção funcionando: reinicie o agente, peça para ele guardar uma preferência e, numa conversa nova, pergunte por ela. O agente grava com `remember` e encontra com `recall` ou `search`, e você confere no terminal com `cabecao search`. Sem nenhum agente detectado, o primeiro passo diz para conectar um antes ([Conectar clientes](./conectar-clientes.md)).

### Os opcionais

O `init` não pergunta nada (só a URL decide). No fim, ele lista até três próximos passos **detectados** na sua máquina, cada um com o comando:

| Opcional | Aparece quando |
| --- | --- |
| `cabecao install-skills` | Há um agente que lê skills (Claude Code sem o plugin, Codex, Cursor, VS Code, Antigravity, Gemini CLI) e as skills do Cabeção ainda não estão nele. Veja [Usar o Cabeção com skills](../guias/skills.md) |
| `cabecao schedule on` | O cérebro tem remoto e o sync automático está desligado. Veja [Sync automático](../guias/sync-automatico.md) |
| `cabecao embeddings on` | A busca por significado está desligada, ou o cérebro já usa uma e falta ligar nesta máquina (aí ele diz o modelo). Veja [Buscar](../guias/buscar.md) |
| `cabecao obsidian setup` | O cérebro tem a pasta `.obsidian` e o setup ainda não rodou. Veja [Usar com o Obsidian](../guias/obsidian.md) |

`cabecao status` e `cabecao doctor` repetem, no fim, os opcionais que continuam pendentes. O diagnóstico do fim do `init` é curto: uma linha com a contagem e só os itens que não estão `ok`; o completo é o `cabecao doctor`.

## Segunda máquina (cérebro existente)

Na outra máquina, instale o Cabeção e rode o mesmo comando, com a mesma URL (início da saída, numa máquina com o Claude Code; o teste e os opcionais vêm depois):

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

Nada no repositório muda. O índice local é montado a partir das notas, e as memórias gravadas na primeira máquina já aparecem para os agentes desta. Para manter as duas em dia, veja [Sincronizar entre máquinas](../guias/sincronizar-maquinas.md).

## Vault do Obsidian ou pasta de Markdown

Se o repositório já tem notas, o Cabeção adota o que existe: clona o vault numa pasta nova e acrescenta a configuração dele, sem mover, renomear ou alterar nenhuma nota (início da saída):

```text
$ cabecao init git@github.com:voce/vault.git --machine notebook
Pronto. Seu cérebro está em ~/cabecao (máquina notebook) e em git@github.com:voce/vault.git.

Vault adotado: .cabecao.json, .gitattributes, .gitignore, AGENTS.md, CLAUDE.md acrescentados ou completados e enviados na branch main; nenhuma nota foi movida, renomeada ou alterada.
Índice local: 1 nota indexada em 4 ms.

Obsidian: O cérebro é a pasta ~/cabecao, um clone novo do vault. Se o Obsidian abre este vault de outra pasta, ele continua abrindo aquela cópia, que não recebe o que os agentes gravam aqui: no Obsidian, use "Abrir pasta como cofre" (Open folder as vault) e escolha ~/cabecao. Depois de conferir que está tudo aqui, apague a cópia antiga ou deixe de usá-la.
```

O cérebro é a pasta nova: abra ela no Obsidian.

As pastas que já têm notas entram na lista de pastas de notas do `.cabecao.json`, ao lado de `wiki`, `memory` e `raw`, onde o Cabeção grava as notas novas. Os detalhes estão em [Adotar um vault existente](../guias/adotar-vault.md).

## Só nesta máquina

Sem URL, o cérebro é criado só local, sem remoto (início da saída):

```text
$ cabecao init --machine notebook --no-clients
Pronto. Seu cérebro está em ~/cabecao (máquina notebook), só nesta máquina.

Cérebro criado só nesta máquina, em ~/cabecao (branch main). Nenhum remoto foi ligado.
```

Tudo funciona igual, inclusive o `undo`: o histórico é um repositório git local. O `sync` só avisa que não há remoto. Para ligar um depois, crie um repositório privado e vazio e, na pasta do cérebro:

```bash
git remote add origin git@github.com:voce/cerebro.git
git push -u origin main
cabecao sync
```

## Quando o init recusa

Um repositório com cara de projeto de código (`package.json`, `src/`, `Cargo.toml` e outros marcadores) não vira cérebro:

```text
$ cabecao init git@github.com:voce/projeto-codigo.git --no-clients
O cérebro não foi criado: git@github.com:voce/projeto-codigo.git não parece um cérebro nem um vault de notas: parece um projeto de código: tem package.json, src/. Nada foi criado nesta máquina nem alterado no remoto.
O que fazer: use um repositório vazio (de preferência privado) ou um vault de notas em Markdown. Ou comece só local: "cabecao init" sem a URL.
```

O código de saída é 1 e nada fica para trás, nem na máquina nem no remoto. Erros de endereço e de credencial estão em [Solução de problemas](../problemas.md).

## Opções

| Opção | O que faz |
| --- | --- |
| `--dir <pasta>` | Pasta do cérebro (padrão: `~/cabecao`) |
| `--machine <nome>` | Nome desta máquina (padrão: o nome do computador). Vira minúsculas, dígitos e hífen, até 32 caracteres: `"Meu PC"` fica `meu-pc` |
| `--no-clients` | Não registra o servidor MCP nos clientes de IA |

A lista completa, com as opções globais, está na [referência da CLI](../referencia/cli.md#cabecao-init).
