---
title: Frontmatter
description: Todos os campos do frontmatter de uma nota, com o formato e quem preenche cada um.
sidebar_position: 4
---

O frontmatter é o bloco YAML entre `---` no topo da nota. O Cabeção grava os campos nesta ordem; campos que ele não conhece são preservados.

## Identidade e tipo

| Campo | Formato | Notas |
| --- | --- | --- |
| `id` | ULID: 26 caracteres em maiúsculas | Preenchido pelo Cabeção numa gravação. Não muda se a nota for renomeada. Opcional numa nota escrita à mão |
| `type` | um dos 12 tipos | `source`, `concept`, `entity`, `decision`, `synthesis`, `rule`, `preference`, `gotcha`, `procedure`, `fact`, `episode`, `handoff` |
| `title` | texto | Obrigatório, menos em `fact` |
| `aliases` | lista de textos | Outros nomes da nota, como no Obsidian. Também servem para achar menções sem link |

## Fatos

Só em `type: fact`, e obrigatórios nele.

| Campo | Formato | Exemplo |
| --- | --- | --- |
| `subject` | wikilink | `"[[Projeto Atlas]]"` |
| `predicate` | identificador em minúsculas, com `_` | `led_by`, `uses_queue` |
| `object` | wikilink ou valor simples (texto, número, booleano) | `"[[Bruno Tavares]]"` |

## Organização

| Campo | Formato | Notas |
| --- | --- | --- |
| `scope` | `global` ou `project:<nome>` | Recomendado. Uma busca com `project:x` traz também as notas globais |
| `tags` | lista de textos | |
| `sources` | lista de wikilinks | De onde veio o conteúdo: `["[[raw/meetings/2026-05-03-arquitetura]]"]` |

## Proveniência

| Campo | Formato | Notas |
| --- | --- | --- |
| `origin` | `human`, `agent:<cliente>` ou `ingest:<fonte>` | Numa gravação de agente, o Cabeção preenche e ignora o valor enviado |
| `trust` | `high`, `medium` ou `low` | Padrão pela origem: `human` → `high`, agente → `medium`, `ingest` → `low`. Um agente não grava `high` |
| `edited_by` | `agent:<cliente>` | O último agente que alterou uma nota que não foi criada por agente |
| `private` | `true` | A nota nunca é enviada a um provedor de respostas do [`ask`](../guias/respostas-com-modelo.md), nem o nome dela quando outra nota a cita. Vale em qualquer caixa (`Private`) e com qualquer valor verdadeiro (`yes`, `on`, `sim`, `1`, `[true]`); a tag `private` em `tags` tem o mesmo efeito ([o que conta como nota privada](../guias/respostas-com-modelo.md#o-que-conta-como-nota-privada)). Não muda a busca nem o que um agente lê pelas tools |

Veja [Proveniência e confiança](../conceitos/proveniencia.md).

## Datas

Todas no formato ISO `AAAA-MM-DD` (hora opcional, que conta pelo dia).

| Campo | Significado |
| --- | --- |
| `created` | Quando a nota foi criada. Preenchido pelo Cabeção |
| `updated` | A última alteração. Preenchido pelo Cabeção |
| `confirmed` | A última vez que alguém conferiu que a nota ainda vale |
| `valid_from` | Passa a valer nesta data (inclusive). Recomendado em fatos |
| `valid_until` | Deixa de valer nesta data (exclusive) |
| `expires_at` | Vence nesta data. Útil em handoffs |

`valid_until` não pode vir antes de `valid_from`.

## Substituição

| Campo | Formato | Significado |
| --- | --- | --- |
| `supersedes` | lista de wikilinks | Esta nota substitui aquelas |
| `superseded_by` | lista de wikilinks | Esta nota foi substituída por aquelas |

Basta um dos lados. A nota substituída passa a contar como vencida a partir do `valid_from` (ou do `created`) da que a substitui. Uma regra sua só é substituída por outra regra sua.

## Relações tipadas

Listas de wikilinks, uma propriedade por relação: `uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to` e as que você declarar em `relations` no [`.cabecao.json`](./configuracao.md#relations).

```yaml
uses: ["[[SQS]]"]
part_of: ["[[Projeto Atlas]]"]
```

Uma propriedade única `relations:` com um mapa não é usada; cada relação é uma propriedade própria.

## O que é erro e o que é aviso

| Situação | |
| --- | --- |
| Frontmatter que não é YAML válido | Erro |
| `type` desconhecido; `id` que não é ULID; data inválida ou fora de ordem; `scope`, `trust` ou `origin` fora do formato; relação que não é lista de wikilinks; `rule` com `origin` diferente de `human` | Erro |
| Faltando `scope`, `trust`, `origin`, `created` ou `updated` (ou `valid_from` num fato) | Aviso |
| Nota sem `id` nem `type` | Aviso: é uma anotação solta, fora do esquema, mas continua na busca |
| Arquivo em `raw/` sem `id` | Aceito como está |

Uma gravação de agente com erro é recusada (`invalid_note`), sem gravar nada. Uma nota sua com erro continua no disco e no índice, como você deixou.
