---
"cabecao": minor
---

Plugin do Claude Code e sync automático: `/plugin marketplace add renanloureiroo/cabecao` e `/plugin install cabecao@cabecao` trazem o servidor MCP embutido (sem `npx`), o briefing do cérebro no início de cada sessão (`cabecao recall --hook`) e o sync em segundo plano no fim (`cabecao sync --hook`), sem capturar a conversa; `cabecao schedule on|off|status` registra o sync periódico no agendador do sistema (LaunchAgent, systemd de usuário ou crontab, Agendador de Tarefas), sem administrador. Comandos e opções novos: `recall`, `schedule`, `sync --detach` e `sync --log`; o `doctor` passa a verificar o agendamento.
