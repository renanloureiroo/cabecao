---
title: Tipos de nota e frontmatter
description: Os 12 tipos de nota, para que serve cada um e o frontmatter que o Cabeção grava.
sidebar_position: 2
---

Toda nota é um arquivo `.md` com um bloco de frontmatter YAML no topo. O campo `type` diz o que a nota é e, portanto, em que pasta ela mora.

## Os 12 tipos

| `type` | Pasta | Para quê |
| --- | --- | --- |
| `source` | `wiki/sources/` | Resumo de uma fonte (uma reunião, um artigo), apontando para o original em `raw/` |
| `concept` | `wiki/concepts/` | Uma ideia ou técnica: idempotência, fila de mensagens |
| `entity` | `wiki/entities/` | Uma coisa concreta: pessoa, projeto, empresa, ferramenta |
| `decision` | `wiki/decisions/` | Uma decisão **e o porquê**, com a data em que passou a valer |
| `synthesis` | `wiki/syntheses/` | Um texto que junta várias notas numa visão geral |
| `rule` | `memory/rules/` | Uma regra que todo agente segue. **Só você cria.** |
| `preference` | `memory/preferences/` | Como você gosta que as coisas sejam feitas |
| `gotcha` | `memory/gotchas/` | Uma armadilha: o que deu errado e como evitar |
| `procedure` | `memory/procedures/` | Um passo a passo que se repete |
| `fact` | `memory/facts/` | Um fato atômico (sujeito, predicado, objeto) com período de validade |
| `episode` | `memory/episodes/AAAA/MM/` | O registro de algo que aconteceu numa data |
| `handoff` | `memory/handoffs/` | O fim de uma sessão: o que foi feito, o que falta, onde parou |

## Uma nota do wiki

Uma decisão do cérebro de exemplo, com relações tipadas e uma versão anterior que ela substitui:

```markdown
---
id: 01KNWQPCCGW9YN4PHGN519T4H6
type: decision
title: Usar SQS para filas
scope: project:atlas
tags: [infra, filas]
sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]
trust: high
origin: agent:claude-code
created: 2026-05-03
updated: 2026-11-10
confirmed: 2026-11-10
valid_from: 2026-05-03
valid_until:
supersedes: ["[[usar-rabbitmq-para-filas]]"]
superseded_by: []
expires_at:
uses: ["[[SQS]]"]
decided_by: ["[[Ana Prado]]", "[[Bruno Tavares]]"]
part_of: ["[[Projeto Atlas]]"]
depends_on: ["[[Idempotência]]"]
---
# Usar SQS para filas

O [[Projeto Atlas]] migrou do [[RabbitMQ]] para o [[SQS]] por custo de operação.
```

## Um fato

Fatos não precisam de título: o Cabeção mostra `sujeito predicado objeto`.

```markdown
---
id: 01KWE9TKFRS0SE22ZDN9SJEEPP
type: fact
subject: "[[Projeto Atlas]]"
predicate: led_by
object: "[[Bruno Tavares]]"
valid_from: 2026-09-01
valid_until:
supersedes: ["[[fato-ana-lidera-atlas]]"]
superseded_by: []
trust: high
origin: human
created: 2026-09-01
updated: 2026-09-01
---
Bruno Tavares lidera o Projeto Atlas desde setembro de 2026.
```

## Campos que o Cabeção cuida

Quando a gravação passa pelo Cabeção (um agente pelo MCP), `id`, `created`, `updated`, `origin` e `edited_by` são preenchidos por ele; o agente não escolhe esses valores. O `id` é um [ULID](https://github.com/ulid/spec): 26 caracteres, em maiúsculas, que não mudam se a nota for renomeada.

Numa nota que você escreve à mão (no Obsidian, por exemplo), o mais importante é o `type`: é ele que diz ao Cabeção o que a nota é. Sem `id`, a nota continua sendo indexada e buscada, identificada pelo caminho; o `status` a conta entre as notas "sem id". Uma nota sem `id` nem `type` é tratada como anotação solta, fora do esquema, e também aparece na busca.

Campos que o Cabeção não conhece são preservados. Você pode ter as suas próprias propriedades do Obsidian.

## Escopo

`scope` separa o que vale em todo lugar do que vale num projeto:

- `global`: vale sempre (padrão das notas gravadas por agentes);
- `project:<nome>`: vale num projeto, como `project:atlas`.

Uma busca ou um `recall` com `project:atlas` traz as notas do projeto **e** as globais.

A lista de todos os campos, com o formato de cada um, está na [referência do frontmatter](../referencia/frontmatter.md).
