---
id: 01KFB5J5989ZJ2Q184GYZJQGS7
type: concept
title: Fila de mensagens
scope: global
tags: [arquitetura, mensageria]
sources: ["[[raw/articles/filas-gerenciadas-vs-autogeridas]]"]
trust: medium
origin: agent:claude-code
created: 2026-01-20
updated: 2026-05-04
confirmed: 2026-05-04
related_to: ["[[Idempotência]]"]
---
# Fila de mensagens

Uma fila desacopla quem produz uma mensagem de quem a consome.

## Garantias de entrega

- **No máximo uma vez:** a mensagem pode se perder.
- **Pelo menos uma vez:** a mensagem pode chegar repetida. É o caso do [[SQS]] padrão.
- **Exatamente uma vez:** na prática, "pelo menos uma vez" com um consumidor que aplica [[Idempotência]].

## Exemplos

O [[RabbitMQ]] e o [[SQS]] são filas. O [[Kafka]] é um log, e não uma fila: esta nota ainda não existe no cérebro.

Um link dentro de código não conta como link:

```md
[[Isto não é um link]]
```

O mesmo vale para `[[código na linha]]`.
