---
"cabecao": minor
---

A CLI passa a rodar como agente, sob as mesmas regras do servidor MCP, sempre que não há terminal controlador ou há sinal de agente no ambiente (mudança de comportamento: script sem terminal grava como agente, `forget --yes` sem terminal é recusado e `embeddings on/off/switch` e `compact` só rodam no seu terminal), ganha os comandos `read`, `remember`, `write`, `patch`, `relate` e `handoff`, e regras, arquivos de controle, `raw/`, `trust: high` e o undo de operação do usuário passam a ser permitidos ao agente com o seu pedido explícito, confirmado por token e registrado (decisão 37).
