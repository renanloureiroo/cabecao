# 10 · Roadmap

Cada marco gera uma versão **instalável e útil**. Só se avança quando o marco anterior estiver testado e documentado.

A ordem segue dois critérios: os requisitos principais (sincronizar e instalar fácil) entram cedo, e a peça mais arriscada (o daemon) entra só depois que o núcleo estiver estável.

## M0 · Fundação do projeto (`0.0.x`)
- [x] Visão, arquitetura, modelo de dados, sync, MCP, busca, segurança, instalação e guia do Obsidian
- [x] ADRs iniciais
- [ ] Monorepo pnpm + TypeScript + lint/format + Vitest
- [ ] CI no GitHub Actions (lint, typecheck, testes em macOS/Linux/Windows)
- [ ] Vault de *fixtures* para testes
- [ ] Reservar o nome `cabecao` no npm
- [ ] **Spike de validação** (ver "Riscos a validar" abaixo)

## M1 · Núcleo utilizável e sincronizado (`0.1`)
Objetivo: instalar com um comando, usar no Claude Code e sincronizar com o GitHub.
- [ ] `templates/vault` + `AGENTS.md`/`CLAUDE.md` padrão
- [ ] Parser: frontmatter (Zod), wikilinks, chunking por seções
- [ ] Vault: escrita atômica, ULIDs, validação de schema
- [ ] SQLite (WAL) + FTS5 + indexação incremental por `content_hash`
- [ ] MCP stdio **dual-era** (`serveStdio`), modo embutido: `recall`, `search` (keyword), `read`, `remember`, `write_page`, `patch_page`, `status`, `sync`
- [ ] Resources `schema`, `index`, `page/{path}`
- [ ] **Sync básico:** lock, commit, `pull --rebase`, reindex incremental, push, conflitos preservados
- [ ] Scanner de segredos bloqueante (antes de qualquer push)
- [ ] CLI: `init` (com `gh repo create --private`), `doctor`, `status`, `search`, `sync`, `mcp`
- [ ] Instalação: `npx cabecao init` + `claude mcp add`
- [ ] Testes e2e com cliente MCP nas gerações 2025 e 2026

## M2 · Busca semântica sincronizada (`0.2`)
- [ ] Interface de provedor de embeddings + `transformers.js` padrão
- [ ] Armazenamento T2 endereçado por conteúdo (shards JSONL, `merge=union`)
- [ ] `sqlite-vec` + busca híbrida RRF + orçamento de tokens
- [ ] Contextual retrieval (prefixo de seção)
- [ ] `compact` + medição do crescimento do repositório
- [ ] Provedores Ollama e API (*opt-in*)
- [ ] `cabecao eval` com perguntas douradas

## M3 · Grafo (`0.3`)
- [ ] Arestas de wikilinks, `relations` e fatos
- [ ] Fatos temporais (`as_of`, `supersedes`)
- [ ] Entidades + aliases + sugestão de fusão
- [ ] Tools `graph`, `facts`, `relate`
- [ ] Expansão por grafo na busca
- [ ] Export T3 (`nodes/edges.jsonl`) + *merge driver* `cabecao-regen`

## M4 · Ciclo de vida e integração com o Claude Code (`0.4`)
- [ ] Plugin do Claude Code (MCP + hooks + skills) + `marketplace.json`
- [ ] `session_handle`, episódios, `handoff_save`
- [ ] Dedupe ADD/UPDATE/SUPERSEDE/NOOP
- [ ] `ingest` (plano de ingestão) + prompts
- [ ] `lint` completo
- [ ] `consolidate` (start/finish) via branch + PR e modo sem GitHub
- [ ] `forget` com MRTR + fallback por token + arquivamento
- [ ] `trust`/`origin` em todo o pipeline + `instructions` no `server/discover`

## M5 · Daemon (`0.5`)
- [ ] `cabecao serve`: watcher, fila de embeddings, sync agendado
- [ ] MCP HTTP *stateless* em `127.0.0.1` + token + proxy no adaptador stdio
- [ ] Serviço do sistema (launchd/systemd/Task Scheduler)
- [ ] Extensão **Tasks** para `sync`/`lint`/`consolidate`
- [ ] `snapshot` local/Release + bootstrap em máquina nova
- [ ] Consolidação agendada via agente não interativo

## M6 · Distribuição e Obsidian (`0.6`)
- [ ] Bundle **MCPB** para o Claude Desktop (via Releases)
- [ ] `install-client` (Codex, Cursor, genérico)
- [ ] `cabecao obsidian setup` (grafo, Bases, templates, Web Clipper)
- [ ] `upgrade` com migrações + snapshot automático
- [ ] Publicação no npm com *provenance*

## M7 · Visual e avançado (`0.7`)
- [ ] **MCP App** `ui://cabecao/graph` e `ui://cabecao/inspector`
- [ ] Comunidades (Leiden) + resumos em `wiki/_communities/`
- [ ] Multi-salto (Personalized PageRank)
- [ ] Rerank local opcional
- [ ] `export canvas`
- [ ] Subscriptions (`subscriptions/listen`)

## 1.0 · Estável
- [ ] Documentação completa em inglês (`docs/en/`)
- [ ] Testes de carga (10k+ notas) e benchmarks publicados
- [ ] Guia de migração de outros sistemas (Obsidian puro, `CLAUDE.md`)
- [ ] Política de segurança e processo de *release* documentados

## Riscos a validar (spike no M0)

Estes pontos estão no desenho mas **ainda não foram testados**. Se algum falhar, o desenho muda antes de escrevermos o resto.

| Risco | Como validar | Plano B |
|---|---|---|
| `merge=union` em shards de embeddings durante `pull --rebase` com duas máquinas | Script com dois clones escrevendo em paralelo | Um arquivo por máquina por shard (sem linhas concorrentes) |
| Crescimento do repositório git com embeddings (histórico + `compact`) | Simular 6 meses de edições em 2 mil notas e medir o `.git` | Embeddings numa branch órfã com histórico achatado periodicamente |
| `sqlite-vec` + `better-sqlite3` com binários prontos em macOS/Linux/Windows via `npx` | Instalar em CI nas 3 plataformas | `node:sqlite` nativo, ou busca vetorial em memória para cérebros pequenos |
| Tempo de download e carga do modelo local de embeddings na primeira execução | Medir em máquina limpa | Iniciar só com busca por palavra-chave e gerar embeddings em segundo plano |
| Suporte real dos clientes à spec 2026-07-28, Tasks, MCP Apps e elicitação | Testar Claude Code, Claude Desktop, Codex e Cursor com um servidor mínimo | Tudo tem caminho 2025-era e fallback sem extensão |
| Qualidade da busca em português com modelo pequeno | `cabecao eval` com perguntas reais | Modelo maior via Ollama como padrão recomendado |

## Depois do 1.0 (ideias)
- Cérebro de **time** (escopos `org:`, permissões por pasta, revisão obrigatória)
- Acesso remoto com OAuth, conforme a spec MCP
- Ingestão de áudio e imagens (transcrição e OCR locais)
- Plugin nativo do Obsidian (painel "o que o Cabeção sabe")
