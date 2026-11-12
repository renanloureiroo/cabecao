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

## Contexto

O cluster próprio pedia cerca de 6 horas de operação por mês. A discussão está em [[Reunião de arquitetura 2026-05-03]].

## Consequência

Os consumidores passaram a depender de [[Idempotência]], porque o SQS padrão pode entregar a mesma mensagem mais de uma vez.
