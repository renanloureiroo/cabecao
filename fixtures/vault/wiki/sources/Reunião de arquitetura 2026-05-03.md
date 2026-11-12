---
id: 01KEKWE4G0QTTYTFP1D44M7DX8
type: source
title: Reunião de arquitetura 2026-05-03
scope: project:atlas
tags: [reuniao, filas]
sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]
trust: medium
origin: ingest:meeting
created: 2026-05-03
updated: 2026-05-03
confirmed: 2026-05-03
part_of: ["[[Projeto Atlas]]"]
related_to: ["[[RabbitMQ]]", "[[SQS]]"]
---
# Reunião de arquitetura 2026-05-03

Resumo da ata em [[raw/meetings/2026-05-03-arquitetura]].

[[Ana Prado]] e [[Bruno Tavares]] discutiram o custo de operar o [[RabbitMQ]] e decidiram migrar para o [[SQS|serviço de filas gerenciado]]. O resultado está em [[usar-sqs-para-filas]].

O risco de entrega duplicada levou ao conceito de [[Idempotência]].
