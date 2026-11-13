---
title: O que lembrar (e o que não)
description: Boas práticas para um cérebro que ajuda em vez de atrapalhar.
sidebar_position: 8
---

Um cérebro útil é pequeno e confiável. Cada memória ocupa espaço no briefing do `recall` e pode desviar um agente se estiver errada ou velha. O `AGENTS.md` do cérebro passa estas orientações aos agentes; elas valem para você também.

## Vale lembrar

| O quê | Tipo | Exemplo |
| --- | --- | --- |
| Uma preferência sua | `preference` | "Prefiro revisões de PR em tópicos curtos, por gravidade." |
| Uma correção que você fez ao agente | `preference` ou `gotcha` | "Neste projeto, os testes rodam com `pnpm test`, não `npm test`." |
| Uma decisão **e o porquê** | `decision` | "Migramos para SQS por custo de operação; a fila própria pedia 6 horas por mês." |
| Uma armadilha descoberta | `gotcha` | "Os testes de integração falham se o banco local não for limpo antes." |
| Um passo a passo que se repete | `procedure` | "Como publicar uma versão nova." |
| Um fato que muda com o tempo, com a data | `fact` | "Bruno lidera o Atlas desde 2026-09-01." |
| Onde a sessão parou | `handoff`, com a tool `handoff_save` | "Faltam três consumidores; comece pelo de faturamento." |
| Uma fonte de fora (artigo, ata) | em `raw/`, com `ingest` | "O artigo sobre custos de filas na AWS." |

## Não vale lembrar

- **O que já está no código, no git ou na documentação.** O agente lê na fonte, que está sempre atualizada.
- **Detalhes que só importam para a conversa atual.**
- **Segredos.** Senhas, tokens, chaves, o conteúdo de um `.env`. Nunca, nem resumidos. O Cabeção bloqueia os formatos conhecidos (veja [Segurança](../seguranca.md)), mas não reconhece tudo.
- **Dados pessoais de outras pessoas** sem necessidade.

## Hábitos que ajudam

- **Peça um handoff no fim.** "Antes de parar, deixe um handoff" faz o agente chamar `handoff_save`, e a próxima sessão começa de onde esta parou. O handoff vale 30 dias (`expires_at`) e o próximo do mesmo projeto substitui o anterior, porque um handoff velho só confunde.
- **Deixe o `remember` cuidar das repetições.** Antes de gravar, ele procura memórias parecidas no mesmo escopo e tipo: a igual não é gravada de novo, a que acrescenta atualiza a existente e um fato que mudou substitui o antigo, que fica no histórico. Quando a regra não decide, o agente recebe as candidatas e escolhe. Ainda assim, peça uma busca antes de gravar algo importante.
- **Rode o `lint` de vez em quando.** [`cabecao lint`](../referencia/cli.md#cabecao-lint) aponta fatos que se contradizem, links quebrados, memórias que ninguém confirma há meses e notas vencidas. Para as memórias velhas: confirme as que valem (`confirmed` com a data de hoje) e esqueça as que não valem com [`cabecao forget`](../referencia/cli.md#cabecao-forget). Uma memória velha nunca confirmada já perde peso na busca.
- **Não apague o que mudou: substitua.** Quando uma decisão muda, a nova nota leva `supersedes: ["[[decisão-antiga]]"]`. A antiga continua lá, vencida, e responde a perguntas sobre o passado com `--as-of`.
- **Use escopo de projeto.** O que só vale num projeto vai com `scope: project:<nome>`, para não aparecer nos outros.
- **Revise de vez em quando.** `cabecao undo --list` mostra o que os agentes gravaram. O que estiver errado, desfaça ou corrija.
- **Regras são poucas e suas.** Veja [Criar regras](./regras.md).
