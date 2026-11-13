---
"cabecao": minor
---

Ciclo de vida da memória: o agente passa a deixar a passagem de bastão com `handoff_save`, o `remember` deixa de repetir memórias e substitui fatos que mudaram, fontes de fora entram com `ingest`, e você ganha `cabecao lint`, `cabecao forget` (arquiva com confirmação, nunca apaga) e `cabecao consolidate` (manutenção com ponto de restauração que um `undo` desfaz inteira).
