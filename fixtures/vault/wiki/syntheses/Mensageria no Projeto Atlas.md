---
id: 01KPM0TD5RMERCMY41F0XWCMFE
type: synthesis
title: Mensageria no Projeto Atlas
scope: project:atlas
tags: [filas, visao-geral]
sources: ["[[Reunião de arquitetura 2026-05-03]]", "[[raw/articles/filas-gerenciadas-vs-autogeridas]]"]
trust: medium
origin: agent:claude-code
created: 2026-05-10
updated: 2026-11-10
confirmed: 2026-11-10
part_of: ["[[Projeto Atlas]]"]
related_to: ["[[usar-sqs-para-filas]]", "[[usar-rabbitmq-para-filas]]", "[[Fila de mensagens]]"]
---
# Mensageria no Projeto Atlas

Linha do tempo:

1. **Janeiro de 2026:** [[usar-rabbitmq-para-filas]].
2. **Maio de 2026:** [[usar-sqs-para-filas]], por custo de operação.
3. **Novembro de 2026:** migração dos consumidores para leitura em lote, registrada em [[2026-11-10-migracao-dos-consumidores]].

O que vale hoje:

![[usar-sqs-para-filas#Consequência]]
