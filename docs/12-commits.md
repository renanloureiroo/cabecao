# 12 · Padrão de commits do cérebro

Os commits que o Cabeção faz no repositório do cérebro seguem o mesmo estilo do plugin **Obsidian Git**: um assunto com data e hora. Assim o histórico fica uniforme, venha o commit do Cabeção ou do Obsidian.

> Este documento trata dos commits **no repositório do seu cérebro**. Os commits do código do projeto seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat`, `fix`, `docs`...).

## Formato

```
vault backup: 2026-11-12 14:32:10.482

add gotcha: testes de integração falham sem limpar o banco

Cabecao-Op: 01JD3K8Y6Z9W2T4N5P7Q8R0S1V
Cabecao-Session: 01JD3K7M2A8B4C6D9E1F3G5H7J
Cabecao-Machine: macbook
Cabecao-Client: claude-code
```

| Parte | Conteúdo |
|---|---|
| **Assunto** | `vault backup: ` + data e hora local, com milissegundos. É o padrão do Obsidian Git (`vault backup: {{date}}`), acrescido dos milissegundos |
| **Corpo** | Uma linha por mudança: ação, tipo da nota e título |
| **Rodapés** | Identificadores que o git sabe filtrar |

### Assunto configurável

O modelo do assunto fica no `.cabecao.json` e aceita os mesmos marcadores do Obsidian Git, mais alguns:

```json
{ "commit": { "message": "vault backup: {{date}}", "dateFormat": "YYYY-MM-DD HH:mm:ss.SSS" } }
```

| Marcador | Valor |
|---|---|
| `{{date}}` | Data e hora, no formato de `dateFormat` |
| `{{hostname}}` | Nome da máquina |
| `{{numFiles}}` | Quantidade de arquivos alterados |
| `{{action}}` | Ação principal do commit (`add`, `update`, `sync`...) |
| `{{session}}` | Início do identificador da sessão |

Se você já usa o Obsidian Git com outro modelo de mensagem, copie o mesmo para cá.

### Ações no corpo

| Ação | Quando |
|---|---|
| `init` | Primeira linha do corpo do primeiro commit de um cérebro (`init: cérebro criado`, `init: cérebro criado só nesta máquina` ou `init: vault adotado; nenhum arquivo foi movido`), seguida de um arquivo por linha. Sem `Cabecao-Session`. Para o marcador `{{action}}` do assunto, vale `add` |
| `add` | Nota nova |
| `update` | Nota existente alterada |
| `supersede` | Nota nova que substitui outra |
| `archive` | `forget` (marco 4) |
| `ingest` | Fonte registrada em `raw/` |
| `edit` | Mudanças feitas fora do Cabeção (Obsidian, editor), gravadas pelo sync com `Cabecao-Client: manual` e sem `Cabecao-Session` |
| `lint`, `consolidate`, `migrate` | Manutenção (marcos 4 e 5) |
| `sync`, `conflict` | Integração entre máquinas |
| `revert` | `undo` |

### Rodapés

| Rodapé | Conteúdo |
|---|---|
| `Cabecao-Op` | ULID da operação; também embute o instante em milissegundos e ordena cronologicamente |
| `Cabecao-Session` | ULID da sessão do agente. Ausente em edições manuais |
| `Cabecao-Machine` | Nome da máquina, definido no `init` |
| `Cabecao-Client` | Quem gravou: `claude-code`, `claude-desktop`, `codex`, `cli`, `manual` |
| `Cabecao-Reverts` | Em commits de `undo`: a operação desfeita |

Os rodapés são o que permite desfazer por operação ou por sessão. Eles não dependem do texto do assunto, então você pode mudar o modelo à vontade.

## Granularidade

- **Um commit por operação de escrita**, feito localmente na hora.
- O envio ao remoto acontece só no sync.
- Uma operação que toca várias notas (uma ingestão, uma consolidação) é um commit, com uma linha por nota no corpo.
- Edições feitas no Obsidian entram num commit só, criado no próximo sync.

## Exemplos

O primeiro commit de um cérebro novo usa a ação `init` no corpo:

```
vault backup: 2026-11-12 14:00:00.000

init: cérebro criado
- .cabecao.json
- AGENTS.md
- ...
```

(a lista traz um arquivo por linha, sem as reticências)

```
vault backup: 2026-11-12 14:32:10.482

add gotcha: testes de integração falham sem limpar o banco
```

```
vault backup: 2026-11-12 18:05:44.019

edit: 3 notas alteradas fora do Cabeção
- wiki/concepts/arquitetura-hexagonal.md
- wiki/decisions/usar-sqs-para-filas.md
- memory/preferences/gerenciador-de-pacotes.md
```

```
vault backup: 2026-11-16 09:00:02.771

consolidate: semana 46
- add fact: Projeto Atlas usa SQS para filas
- supersede decision: usar SQS para filas
- archive gotcha: fila do RabbitMQ trava com mensagens grandes
```

Na branch de índice o assunto é `vault index: <data>`, com a geração e a quantidade de vetores no corpo.

## Consultas úteis

```bash
git log --grep "Cabecao-Session: 01JD3K7M"        # tudo de uma sessão
git log --grep "Cabecao-Client: claude-desktop"   # tudo de um cliente
git log --grep "^consolidate"                     # consolidações
git log --since "2026-11-12 14:00" --until "2026-11-12 15:00"
```

## Autoria

O autor é a sua identidade do git. O Cabeção **não** acrescenta linhas de coautoria nem de atribuição a IA. `Cabecao-Client` registra de qual programa veio a mudança, para auditoria.

## Detalhes de implementação

- Os commits automáticos usam `--no-verify`, para não depender de hooks do seu git.
- **Os commits do Cabeção saem sempre sem assinatura** (`--no-gpg-sign`), mesmo com `commit.gpgsign` ligado no seu git: uma chave com senha poderia travar um processo sem terminal. O `doctor` detecta `commit.gpgsign` e avisa. Não foi testado com um provedor que exija commits assinados.
- A data do assunto usa o fuso da máquina, como o Obsidian Git. O ULID do rodapé é sempre em UTC.
