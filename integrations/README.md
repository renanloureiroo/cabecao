# Integrações

Cada pasta empacota o Cabeção para um cliente.

| Pasta | O que tem | Estado |
|---|---|---|
| [`claude-code/`](claude-code/) | Plugin do Claude Code: servidor MCP embutido, hook de início (briefing) e de fim de sessão (sync em segundo plano) e a skill `cabecao:memory`. O marketplace fica em [`/.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Pronto (M4) |
| [`mcpb/`](mcpb/) | Manifesto do pacote `.mcpb` do Claude Desktop, com o servidor embutido; `pnpm build:mcpb` gera o pacote, e cada release do GitHub o traz anexado | Pronto (M5); instalação no aplicativo não testada |
| [`obsidian/`](obsidian/) | Onde vive a integração com o Obsidian: `cabecao obsidian setup` (grafo, tipos de propriedade, painéis `.base`, modelo do Web Clipper) e `cabecao export canvas` | Pronto (M5) |

Os outros clientes (Claude Desktop sem o pacote, Codex, Cursor, VS Code, Gemini CLI) funcionam com `cabecao install-client <cliente>`, que registra o servidor MCP sem os hooks.
