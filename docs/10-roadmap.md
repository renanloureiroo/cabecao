# 10 · Roadmap

Cada marco entrega uma versão instalável e útil. Tudo em TypeScript.

## M0 · Fundação ✅ quase completa
- [x] Provas de conceito de todas as decisões de arquitetura ([evidências](11-evidencias.md))
- [x] Plano e documentação reescritos com base nos resultados
- [ ] Monorepo pnpm + tsdown + Vitest + Biome + Changesets
- [ ] CI do projeto: Linux, macOS e Windows × Node 22, 24 e 26
- [ ] Reservar `cabecao` no npm
- [ ] Vault de exemplo para testes

## M1 · Núcleo: instalar com a URL e sincronizar (`0.1`)
Ao final: `npx cabecao init <url>` funciona em duas máquinas, com busca por palavra-chave, no Claude Code.

- [ ] Parser próprio de Markdown e frontmatter
- [ ] Vault: escrita atômica, ULIDs, validação de esquema, `.cabecao.json`
- [ ] Banco local com `node:sqlite` + FTS5 e varredura incremental
- [ ] `init` com os cinco casos de repositório
- [ ] Sync de conteúdo: integração em memória, cópia de conflito, trava, recuperação após interrupção
- [ ] Autenticação sem terminal
- [ ] Padrão de commits + `undo`
- [ ] Scanner de segredos
- [ ] Servidor MCP nas duas gerações: `recall`, `search`, `read`, `remember`, `write_page`, `patch_page`, `status`, `sync`, `undo`
- [ ] Instruções do servidor
- [ ] CLI: `init`, `status`, `doctor`, `sync`, `search`, `undo`, `mcp`, `install-client`
- [ ] **Validar em GitHub, GitLab, Bitbucket e Gitea reais**

## M2 · Busca por significado, sincronizada (`0.2`)
- [ ] Runtime opcional de embeddings, baixado sob demanda
- [ ] EmbeddingGemma 300m q4 com prefixo de contexto
- [ ] Segmentos imutáveis na branch de índice + envio atômico com o conteúdo
- [ ] Vetores em memória e fusão convexa com cobertura
- [ ] `compact` e gerações do índice
- [ ] Alternativa em WebAssembly para sistemas sem runtime nativo
- [ ] `cabecao eval`
- [ ] **Medir a busca com vetores calculados em máquinas diferentes**

## M3 · Wiki com grafo e validade no tempo (`0.3`)
- [ ] Datas de validade e `as_of` na busca, com marcação de vigente ou vencido
- [ ] Relações tipadas: uma propriedade por relação
- [ ] Notas de fato e tool `facts`
- [ ] Arestas no SQLite, tool `graph` e `relate`
- [ ] Bloco `related` na busca
- [ ] Menções sem link, por dicionário de títulos
- [ ] Grafo exportado na branch de índice

## M4 · Ciclo de vida e plugin do Claude Code (`0.4`)
- [ ] Plugin: servidor embutido, hook de início, hook de fim, skill
- [ ] `session_handle`, episódios e `handoff_save`
- [ ] Tratamento de duplicatas e contradições no `remember`
- [ ] `ingest` e os roteiros (prompts)
- [ ] `lint`
- [ ] `consolidate` com ponto de restauração
- [ ] `forget` com confirmação em duas chamadas e elicitação quando houver
- [ ] `schedule` nos três sistemas

## M5 · Obsidian e distribuição (`0.5`)
- [ ] `cabecao obsidian setup` com mesclagem segura
- [ ] Painéis `.base` e modelo do Web Clipper
- [ ] `export canvas`
- [ ] Pacote `.mcpb` para o Claude Desktop
- [ ] `install-client` para Codex, Cursor, VS Code e Gemini CLI
- [ ] `upgrade` com migrações
- [ ] Publicação no npm com proveniência

## M6 · Extras (`0.6`)
- [ ] Resumos por tema na consolidação
- [ ] Explorador do grafo dentro do Claude (MCP Apps)
- [ ] Modo HTTP local (`cabecao serve`)
- [ ] Provedor de embeddings via Ollama

## 1.0
- [ ] Documentação em inglês
- [ ] Testes com cérebros reais acima de 10 mil notas
- [ ] Guia de migração a partir de um vault existente e de arquivos `CLAUDE.md`

## O que ainda precisa de prova

Estes pontos estão no plano com base em documentação ou em teste parcial. Cada um está ligado ao marco em que será validado.

| Ponto | Situação | Marco |
|---|---|---|
| Provedores git reais | Só simulado com remoto local | M1 |
| Falha de chave SSH e gerenciadores de credencial | Não testado | M1 |
| Commits assinados | Não testado | M1 |
| Sync em Windows e Linux | A PoC de sync rodou só no macOS | M1 |
| Scanner de segredos | Não implementado | M1 |
| Vetores de arquiteturas diferentes na mesma busca | Não medido | M2 |
| Licença do modelo padrão | Decisão sua; há alternativa Apache-2.0 | M2 |
| Busca medida num cérebro real | Só conjuntos sintéticos e públicos | M2 |
| Plugin instalado a partir do repositório público | Só marketplace local | M4 |
| Sessões interativas do Claude Code | Só modo não interativo | M4 |
| Instalação do `.mcpb` no Claude Desktop | Só gerado e validado | M5 |
| Modelo do Web Clipper na extensão | Não importado | M5 |
| macOS com processador Intel e Windows 10 | Sem máquina de teste | 1.0 |

## Ideias para depois do 1.0
- Ingestão de áudio e imagem com transcrição local.
- Plugin nativo do Obsidian com o painel "o que o Cabeção sabe".
- Acesso remoto ao servidor.
