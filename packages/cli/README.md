# 🧠 cabecao

Segundo cérebro pessoal em Markdown e git, para você e seus agentes de IA, servido por MCP.

*Personal second brain in Markdown and git, served to AI agents over MCP. Documentation in Portuguese for now.*

> **Status:** em construção, ainda antes da `0.1`. O que está abaixo já funciona; o plano completo está no repositório.

Suas notas são arquivos Markdown numa pasta, versionados num repositório git seu, em qualquer provedor (GitHub,
GitLab, Bitbucket, Gitea, servidor próprio ou uma pasta local). O Obsidian abre a mesma pasta. Os agentes de IA
(Claude Code, Claude Desktop, Codex, Cursor, VS Code, Gemini CLI) leem e gravam nela pelo servidor MCP do `cabecao`.

## Começar

```bash
npx cabecao init git@github.com:voce/meu-cerebro.git
```

O `init` não pergunta nada. Ele clona para `~/cabecao` (mude com `--dir`) e decide pelo que encontra no repositório:

| O repositório tem | O que acontece |
|---|---|
| Nada (acabou de ser criado) | Cria a estrutura do cérebro, faz o primeiro commit e envia |
| Um cérebro do Cabeção | Só baixa: é a segunda máquina |
| Um vault do Obsidian ou Markdown | Adota: acrescenta a configuração do Cabeção sem mover nenhum arquivo |
| Outra coisa (código, por exemplo) | Recusa e explica; nada fica para trás |

Depois ele monta o índice local, registra o servidor MCP nos clientes de IA que encontrar e roda o `doctor`. Numa
segunda máquina, rode o mesmo comando com a mesma URL. Sem URL, `cabecao init` cria um cérebro só local.

Use um repositório **privado**: em HTTPS de um provedor conhecido, o `init` e o `doctor` avisam se ele parecer público.
O `cabecao` usa as credenciais que o seu git já usa (chave SSH, token salvo) e nunca pede senha.

## Comandos

| Comando | O que faz |
|---|---|
| `cabecao init [url]` | Instala ou conecta esta máquina a um cérebro |
| `cabecao status` | Notas por tipo, último sync, envios pendentes, conflitos, links quebrados |
| `cabecao doctor` | Diagnóstico com a correção sugerida para cada problema (`--offline` não consulta o remoto) |
| `cabecao sync` | Sincroniza com o remoto, sem descartar nada |
| `cabecao search "<pergunta>"` | Busca por palavra-chave, com `--type`, `--scope` e `--limit` |
| `cabecao undo` | Desfaz a última operação; `--op <id>`, `--session <id>`, `--list` |
| `cabecao install-client <cliente>` | Registra o servidor MCP num cliente de IA (`--all`, `--print`, `--remove`) |
| `cabecao mcp` | O servidor MCP por stdio, que os clientes de IA iniciam |

`cabecao <comando> --help` mostra as opções de cada um. Todos aceitam `--json` (saída estruturada para scripts) e
`--brain <pasta>`. Sem `--brain`, o cérebro é o de `CABECAO_BRAIN`, senão o padrão gravado pelo `init`, senão a pasta
atual, se ela for um cérebro.

### Sync

O `sync` põe num commit o que você editou fora do Cabeção (no Obsidian, por exemplo), recebe o que veio do remoto e
envia. Se a mesma nota foi editada em duas máquinas, as duas versões ficam: a nota com a do remoto e a sua numa cópia
`nota.conflict-<máquina>-<data>.md` ao lado, que o `status` e o `doctor` listam até você juntar e apagar. Antes de
enviar, ele procura segredos (tokens, chaves) e, se achar, bloqueia e mostra arquivo, linha e regra, nunca o valor.

### Desfazer

Cada gravação feita pelo Cabeção (por um agente, pelo MCP) é um commit com o identificador da operação e da sessão.
`cabecao undo` desfaz por `git revert`, sem reescrever histórico; o próprio undo também pode ser desfeito.

## Requisitos

- Node.js 22.16 ou superior (recomendado: 24).
- git 2.38 ou superior.

Plano, arquitetura e roadmap: <https://github.com/renanloureiroo/cabecao>

## Licença

[MIT](LICENSE)
