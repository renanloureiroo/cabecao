---
title: Arquivos e diretórios
description: Onde o Cabeção guarda cada coisa, na máquina e no cérebro, e o que pode ser apagado.
sidebar:
  order: 5
---

## Configuração da máquina

`~/.config/cabecao/config.json` guarda o que é só desta máquina. Não vai para o git.

```json
{
  "machine": "notebook",
  "defaultBrain": "/Users/voce/cabecao"
}
```

| Campo | O que é |
| --- | --- |
| `machine` | O nome desta máquina: minúsculas, dígitos e hífen, até 32 caracteres. Aparece nos commits (`Cabecao-Machine`) e nas cópias de conflito |
| `defaultBrain` | O cérebro usado quando nenhum é informado (`--brain` ou `CABECAO_BRAIN`) |

Onde fica a pasta:

| Sistema | Pasta |
| --- | --- |
| macOS e Linux | `$XDG_CONFIG_HOME/cabecao`, ou `~/.config/cabecao` |
| Windows | `%APPDATA%\cabecao` |
| Qualquer um | `CABECAO_CONFIG_DIR`, se definida, vale acima das outras |

O `init` cria o arquivo. Se ele quebrar, apague-o e rode `cabecao init` de novo: num cérebro que já existe, o `init` só grava o nome da máquina.

## O cérebro

A pasta do cérebro (padrão `~/cabecao`) é um repositório git comum. A estrutura está em [Estrutura do cérebro](/cabecao/conceitos/estrutura/).

| Arquivo | Vai para o git? | Pode editar à mão? |
| --- | --- | --- |
| Notas em `wiki/`, `memory/`, `raw/` | Sim | Sim |
| `.cabecao.json` | Sim | Sim, com cuidado; veja [.cabecao.json](/cabecao/referencia/configuracao/) |
| `AGENTS.md`, `CLAUDE.md` | Sim | Sim (agentes, não) |
| `.gitignore`, `.gitattributes` | Sim | Sim, mantendo as linhas do Cabeção (o `doctor` avisa se faltar alguma) |
| `index.md` | Sim | Não: é regenerado |
| `log.md` | Sim | Não: só recebe linhas no fim |
| `*.conflict-*` | Sim | Sim: junte e apague |
| `.cabecao/` | Não | Não |

## `.cabecao/`: o banco local

Pasta de cada máquina, fora do git:

| Caminho | O que é |
| --- | --- |
| `.cabecao/cabecao.db` | O banco local (SQLite): índice de busca, grafo, fatos e menções |
| `.cabecao/locks/` | Travas entre processos (sync, escritas) |
| `.cabecao/sync/` | Estado do último sync, o diário de um sync em andamento e o cache do catálogo |

Tudo ali é derivado das notas e do git. Se o banco der problema, apague a pasta `.cabecao/` e rode `cabecao status`: o banco é refeito a partir das notas.

## O que o Cabeção escreve fora do cérebro

Só os arquivos de configuração dos clientes de IA, quando você roda `init` ou `install-client`, e só a entrada `cabecao` dentro deles. A primeira alteração em cada arquivo deixa uma cópia `.bak` ao lado. A lista de arquivos por cliente está em [Conectar aos clientes de IA](/cabecao/comecar/conectar-clientes/).
