---
title: Arquivos e diretórios
description: Onde o Cabeção guarda cada coisa, na máquina e no cérebro, e o que pode ser apagado.
sidebar_position: 5
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
| `agent` | Opcional. O agente que o `cabecao consolidate --run` usa sem `--agent`: `claude-code` ou `codex`. Você grava à mão; o `init` o mantém |

Onde fica a pasta:

| Sistema | Pasta |
| --- | --- |
| macOS e Linux | `$XDG_CONFIG_HOME/cabecao`, ou `~/.config/cabecao` |
| Windows | `%APPDATA%\cabecao` |
| Qualquer um | `CABECAO_CONFIG_DIR`, se definida, vale acima das outras |

O `init` cria o arquivo. Se ele quebrar, apague-o e rode `cabecao init` de novo: num cérebro que já existe, o `init` só grava o nome da máquina.

## Provedor de respostas: `llm.json`

Só existe se você ativou as [respostas com um modelo de linguagem](../guias/respostas-com-modelo.md) (`cabecao llm on`). Fica na pasta de configuração padrão do seu usuário (`~/.config/cabecao`; no Windows, `%APPDATA%\cabecao`), com permissão `0600`, e **nunca guarda a chave**, só onde ela está. Desviada por variável de ambiente, vale só para você no terminal, nunca para um agente (veja [Onde fica a configuração](../guias/respostas-com-modelo.md#onde-fica-a-configuração)):

```json
{
  "version": 1,
  "enabled": true,
  "providers": {
    "anthropic": { "kind": "http", "preset": "anthropic", "model": "claude-haiku-5-5", "key": "keychain", "consented_at": "2026-11-13T12:00:00.000Z", "consent": "9f2c…" },
    "claude-code": { "kind": "agent", "agent": "claude-code", "model": null, "consented_at": "2026-11-13T12:05:00.000Z", "consent": "41ab…" }
  },
  "roles": { "answer": ["anthropic", "claude-code"] },
  "limits": { "context_tokens": 3000, "max_output_tokens": 2048, "timeout_ms": 60000, "max_calls_per_hour": 30, "max_calls_per_session": 20 }
}
```

| Campo | O que é |
| --- | --- |
| `enabled` | `false` depois de `cabecao llm off`: nada sai, e o resto continua |
| `providers` | Cada provedor: `kind` (`http` ou `agent`), `preset` ou `agent`, `model`, `base_url` (só em `compatible`, `ollama` e `lmstudio`; conferido a cada leitura), `key` (`env:NOME`, `keychain`, `file` ou `none`), `consented_at` e `consent` (a sua confirmação, assinada com o segredo local; sem ela, ou se destino, modelo ou chave mudarem, o provedor não é usado) |
| `roles.answer` | A ordem de uso: se o primeiro não estiver disponível ou falhar, o seguinte responde |
| `limits` | Contexto por pergunta (500 a 8000 tokens), saída e tempo limite de cada chamada; o teto de gasto: `max_calls_per_hour` (padrão 30) e `max_calls_per_session` (padrão 20, por sessão do servidor MCP) |

Junto dele: `llm-consent.key` (o segredo que assina as confirmações, `0600`), `ask-usage.json` (as horas das perguntas recentes, para o teto por hora), e, quando é o caso: `credentials.json` (chaves guardadas com `--store file`, ou num Linux sem `secret-tool`; permissão `0600`) e, no Windows, `credentials.dpapi.json` (as chaves cifradas com a DPAPI do seu usuário). O log das perguntas, `ask.log`, fica na pasta de cache (`~/.cache/cabecao`; no Windows, `%LOCALAPPDATA%\cabecao`): uma linha por pergunta, com a pergunta cortada, o provedor, o tempo e as contagens, sem trechos do cérebro e sem chave. O `cabecao uninstall` apaga tudo isso, e as chaves no cofre do sistema.

## O cérebro

A pasta do cérebro (padrão `~/cabecao`) é um repositório git comum. A estrutura está em [Estrutura do cérebro](../conceitos/estrutura.md).

| Arquivo | Vai para o git? | Pode editar à mão? |
| --- | --- | --- |
| Notas em `wiki/`, `memory/`, `raw/` | Sim | Sim |
| `.cabecao.json` | Sim | Sim, com cuidado; veja [.cabecao.json](./configuracao.md) |
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

Só os arquivos de configuração dos clientes de IA, quando você roda `init` ou `install-client`, e só a entrada `cabecao` dentro deles. A primeira alteração em cada arquivo deixa uma cópia `.bak` ao lado. A lista de arquivos por cliente está em [Conectar aos clientes de IA](../comecar/conectar-clientes.md).

O `cabecao consolidate --run` cria uma pasta temporária (a configuração de MCP do agente e o diretório de trabalho dele), apagada no fim, e guarda a saída do agente em `~/.cache/cabecao/consolidate-runs/<id>.log` (no Windows, `%LOCALAPPDATA%\cabecao\consolidate-runs`). Ele não altera a configuração dos clientes.
