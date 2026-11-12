# 08 · Instalação e operação

> 🚧 Tudo abaixo é o **comportamento planejado**. Os comandos ainda não existem.

## Pré-requisitos
| Item | Obrigatório? | Observação |
|---|---|---|
| Node.js ≥ 22 | ✅ | `node --version` |
| git | ✅ | |
| GitHub CLI (`gh`) | opcional | para criar o repo privado e abrir PRs de consolidação |
| Obsidian | opcional (recomendado) | para visualizar |
| Ollama | opcional | para embeddings maiores ou LLM local |

## Caminho 1: `npx` (recomendado)

```bash
npx cabecao@latest init
```

O assistente pergunta:
1. **Onde fica o cérebro?** Pasta nova (padrão `~/cabecao`) ou um **vault do Obsidian já existente** (o Cabeção adota sem mover nada).
2. **Sincronizar com o GitHub?** → `gh repo create <nome> --private` + *remote* + primeiro push.
3. **Embeddings:** local (padrão) / Ollama / API.
4. **Clientes:** detecta Claude Code, Claude Desktop, Codex e Cursor e registra o MCP nos que você escolher.
5. **Obsidian:** aplica a configuração recomendada (cores do grafo, dashboards).
6. **Daemon:** instalar como serviço do sistema? (launchd no macOS, systemd `--user` no Linux, Task Scheduler no Windows)

No fim, roda `cabecao doctor`.

### Instalação global (opcional)
```bash
npm install -g cabecao
cabecao init
```

## Caminho 2: plugin do Claude Code

```text
/plugin marketplace add renanloureiroo/cabecao
/plugin install cabecao@cabecao
```
O plugin inclui:
- o **servidor MCP** (`.mcp.json` com `npx -y cabecao mcp`);
- **hooks:** `SessionStart` (injeta o briefing com `cabecao recall --hook`) e `SessionEnd` (`cabecao sync`);
- **skills:** `/cabecao:ingest`, `/cabecao:review`, `/cabecao:consolidate`.

Na primeira execução, se não existir um cérebro, o plugin sugere rodar `cabecao init`.

## Caminho 3: Claude Desktop (MCPB)
Baixe `cabecao.mcpb` na página de *Releases* e dê dois cliques. O `manifest.json` declara um `user_config` para escolher a pasta do cérebro numa tela gerada pelo Claude Desktop.

## Outros clientes
```bash
cabecao install-client codex
cabecao install-client cursor
cabecao install-client --print   # só mostra o JSON para colar manualmente
```

## Comandos do dia a dia

| Comando | O que faz |
|---|---|
| `cabecao status` | Resumo: notas, último sync, conflitos, backlog de embeddings |
| `cabecao doctor` | Diagnóstico completo com sugestão de correção para cada problema |
| `cabecao sync` | Sincroniza tudo (ver [04](04-sincronizacao.md)) |
| `cabecao search "<consulta>"` | Busca pelo terminal |
| `cabecao ingest <arquivo>` | Registra uma fonte em `raw/` |
| `cabecao lint` | Relatório de saúde |
| `cabecao consolidate` | Chama um agente não interativo (ex.: `claude -p`) para preparar um PR de consolidação |
| `cabecao purge <id>` | Apaga definitivamente, reescrevendo o histórico |
| `cabecao reindex [--full]` | Reconstrói os índices |
| `cabecao compact` | Limpa embeddings órfãos e duplicados |
| `cabecao snapshot [--push]` | Snapshot do índice (local ou Release) |
| `cabecao serve` | Roda o daemon em primeiro plano |
| `cabecao mcp` | Adaptador MCP stdio (usado pelos clientes) |
| `cabecao upgrade` | Atualiza e aplica migrações do schema |
| `cabecao uninstall` | Remove serviço e registros dos clientes, sem **nunca** apagar o cérebro |

## `cabecao doctor` verifica
- versões de Node, git e gh;
- se a pasta é um repo git, se tem *remote* e se o *remote* é **privado**;
- se os *merge drivers* e o `.gitattributes` estão instalados;
- se o schema está na versão atual;
- se o índice está consistente (`last_indexed_commit` igual a `HEAD`);
- se o modelo de embeddings está disponível;
- se o daemon está rodando e se há lock órfão;
- se os clientes MCP estão registrados e respondem a `server/discover`;
- se o `AGENTS.md` cabe no orçamento recomendado;
- se há conflitos pendentes.

## Atualização e manutenção
- `cabecao upgrade` atualiza o pacote, roda as **migrações** em ordem (um commit por migração), faz `reindex --incremental` e por fim `doctor`.
- Antes de cada migração, faz `snapshot` automático.
- Política de versões: **SemVer**. Mudanças de schema só em *minor* (com migração automática) ou *major*.

## Onde ficam as coisas
| Item | Caminho |
|---|---|
| Cérebro | onde você escolher (ex.: `~/cabecao`) |
| Config da máquina | `~/.config/cabecao/machine.json` (Windows: `%APPDATA%\cabecao`) |
| Token do daemon | `~/.config/cabecao/token` (permissão 600) |
| Logs | `<cérebro>/.cabecao/cache/logs/` |
| Índice | `<cérebro>/.cabecao/cache/cabecao.db` |
| Modelos de embedding | `~/.cache/cabecao/models/` |

## Backup
O cérebro **é** um repositório git: o *remote* já é o backup. Para segurança extra, `cabecao snapshot --push` guarda o índice numa Release do repo privado.
