---
id: 01KG2EP62GVDPTHW9YNVM4C445
type: concept
title: Idempotência
scope: global
tags: [arquitetura]
sources: []
trust: medium
origin: agent:claude-code
created: 2026-05-04
updated: 2026-05-04
confirmed: 2026-05-04
related_to: ["[[Fila de mensagens]]"]
---
# Idempotência

Uma operação é idempotente quando repeti-la não muda o resultado.

É o que torna segura a entrega "pelo menos uma vez". Veja [[Fila de mensagens#Garantias de entrega]].

No [[projeto atlas]], cada consumidor guarda o identificador da mensagem já processada.
