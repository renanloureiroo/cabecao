---
id: 01KRSW6FHG33DDQD64ZMW36MRW
type: gotcha
title: Testes de integração falham sem limpar o banco
scope: project:atlas
tags: [testes]
sources: []
trust: medium
origin: agent:claude-code
created: 2026-03-18
updated: 2026-03-18
confirmed: 2026-08-22
part_of: ["[[Projeto Atlas]]"]
---
Os testes de integração do [[Projeto Atlas]] falham de forma intermitente quando o banco local guarda dados de uma execução anterior.

Rode `make db-reset` antes de `make test-integration`.
