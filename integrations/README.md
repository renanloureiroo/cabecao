# Integrações

Cada pasta empacota o Cabeção para um cliente.

| Pasta | O que tem | Estado |
|---|---|---|
| [`claude-code/`](claude-code/) | Plugin do Claude Code: servidor MCP embutido, hook de início (briefing) e de fim de sessão (sync em segundo plano) e a skill `cabecao:memory`. O marketplace fica em [`/.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Pronto (M4) |
| [`mcpb/`](mcpb/) | Manifesto do pacote `.mcpb` para o Claude Desktop | M5 |
| [`obsidian/`](obsidian/) | Configuração do grafo, painéis `.base`, tipos de propriedade e modelo do Web Clipper | M5 |

Os outros clientes (Claude Desktop, Codex, Cursor, VS Code, Gemini CLI) já funcionam hoje com `cabecao install-client <cliente>`, que registra o servidor MCP sem os hooks.
