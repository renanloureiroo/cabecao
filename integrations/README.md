# Integrações

Cada pasta empacota o Cabeção para um cliente.

| Pasta | O que tem | Estado |
|---|---|---|
| [`claude-code/`](claude-code/) | Plugin do Claude Code: servidor MCP embutido, hook de início (briefing) e de fim de sessão (sync em segundo plano) e as skills do Cabeção, copiadas de `skills/` no passo de versão. O marketplace fica em [`/.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Pronto |
| [`skills/`](skills/) | As skills do Cabeção (fonte única): ensinam o agente a usar o cérebro pela CLI, sem o servidor MCP. Embutidas na CLI (`cabecao install-skills`) pelo build e copiadas para o plugin no passo de versão | Pronto |
| [`mcpb/`](mcpb/) | Manifesto do pacote `.mcpb` do Claude Desktop, com o servidor embutido; `pnpm build:mcpb` gera o pacote, e cada release do GitHub o traz anexado | Pronto; instalação no aplicativo não testada |
| [`obsidian/`](obsidian/) | Onde vive a integração com o Obsidian: `cabecao obsidian setup` (grafo, tipos de propriedade, painéis `.base`, modelo do Web Clipper) e `cabecao export canvas` | Pronto |

Os outros clientes (Claude Desktop sem o pacote, Codex, Cursor, VS Code, Antigravity, Gemini CLI) funcionam com `cabecao install-client <cliente>`, que registra o servidor MCP sem os hooks.
