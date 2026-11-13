# 10 · Roadmap

Cada marco entrega uma versão instalável e útil. Tudo em TypeScript.

## M0 · Fundação ✅ falta só publicar o nome no npm
- [x] Provas de conceito de todas as decisões de arquitetura ([evidências](11-evidencias.md))
- [x] Plano e documentação reescritos com base nos resultados
- [x] Monorepo pnpm + tsdown + Vitest + Biome + Changesets, com os pacotes `core`, `server`, `cli` e `embeddings`
- [x] CLI `cabecao --version`, com a checagem da versão do Node antes de tudo
- [x] CI do projeto: Linux, macOS e Windows × Node 22, 24 e 26 ([como funciona](13-publicacao.md#ci))
- [x] Vault de exemplo para testes ([`fixtures/vault`](../fixtures/README.md))
- [ ] Reservar `cabecao` no npm: o pacote `0.0.1` está pronto e validado com `npm publish --dry-run`; falta a [primeira publicação](13-publicacao.md#primeira-publicação-reserva-do-nome)
- [ ] Ligar a publicação pelo GitHub Actions (depois da primeira publicação)

## M1 · Núcleo: instalar com a URL e sincronizar (`0.1`) ✅ implementado, em revisão
Ao final: `npx cabecao init <url>` funciona em duas máquinas, com busca por palavra-chave, no Claude Code.

O código está na branch `feat/m1-nucleo` e ainda não foi publicado no npm. Os itens abaixo estão implementados e cobertos por testes automatizados (1.181 testes e o teste de ponta a ponta com duas máquinas). O que não foi validado está nas linhas em aberto e em "O que ainda precisa de prova".

- [x] Parser próprio de Markdown e frontmatter
- [x] Vault: escrita atômica, ULIDs, validação de esquema, `.cabecao.json`
- [x] Banco local com `node:sqlite` + FTS5 e varredura incremental
- [x] `init` com os cinco casos de repositório, mais o cérebro só local
- [x] Sync de conteúdo: integração em memória, cópia de conflito, trava, recuperação após interrupção. Sincroniza tudo o que o git não ignora ([ADR 35](adr/README.md))
- [ ] Autenticação sem terminal: implementada (`GIT_TERMINAL_PROMPT=0`, `ssh -o BatchMode=yes`, tempo limite) e testada só com remoto local e HTTP local; falta com provedores reais, SSH e gerenciadores de credencial
- [x] Padrão de commits + `undo` (commits sempre sem assinatura)
- [x] Scanner de segredos (14 regras, em toda escrita e antes de todo envio). Mediu 53 de 53 segredos sintéticos e 0 falsos positivos no cérebro de exemplo e em `docs/`; nunca foi medido contra segredos reais
- [x] Servidor MCP nas duas gerações, com 9 tools: `recall`, `search`, `read`, `status`, `remember`, `write_page`, `patch_page`, `sync`, `undo`. As outras 8 do plano vêm em marcos futuros ([05](05-mcp.md))
- [x] Instruções do servidor
- [x] CLI: `init`, `status`, `doctor`, `sync`, `search`, `undo`, `mcp`, `install-client`
- [x] Revisão de segurança e correções: um agente não cria nem edita regras, não escreve em arquivos de controle e, ao alterar uma nota do usuário, rebaixa a confiança e se registra em `edited_by` ([ADR 36](adr/README.md)); limites de tamanho de entrada; escrita que nunca segue link simbólico
- [x] Teste de ponta a ponta com duas máquinas sobre o bundle (`pnpm e2e`), no CI
- [ ] **Validar em GitHub, GitLab, Bitbucket e Gitea reais**
- [ ] **Validar com clientes MCP reais** (Claude Code, Claude Desktop, Codex, Cursor): nenhum foi testado contra o servidor do marco 1

## M2 · Busca por significado, sincronizada (`0.2`)
- [ ] Runtime opcional de embeddings, baixado sob demanda
- [ ] Escolha do modelo pelo usuário, com configurações prontas para as sugestões testadas e suporte a modelo próprio
- [ ] Prefixo de contexto nos trechos
- [ ] Segmentos imutáveis na branch de índice + envio atômico com o conteúdo
- [ ] Vetores em memória e fusão convexa com cobertura
- [ ] `compact` e gerações do índice
- [ ] Alternativa em WebAssembly para sistemas sem runtime nativo
- [ ] `cabecao eval`
- [ ] **Medir a busca com vetores calculados em máquinas diferentes**

## M3 · Wiki com grafo e validade no tempo (`0.3`) 🚧 implementado na branch `feat/m3-grafo`, em revisão
- [x] Datas de validade e `as_of` na busca, com marcação de vigente, vencido ou ainda não vigente (rebaixados, nunca escondidos). A substituição pelo encadeamento `supersedes`/`superseded_by` também vence a nota antiga, mesmo sem `valid_until`
- [x] Relações tipadas: uma propriedade por relação (`remember`, `write_page`, `relate`), indexadas com `valid_from`/`valid_until`
- [x] Notas de fato e tool `facts`, com a cadeia de versões nos dois sentidos
- [x] Arestas no SQLite, tool `graph` (CTE recursiva de 1 ou 2 saltos, com teto e orçamento) e `relate` (pelo fluxo de escrita, com as restrições de agente)
- [x] Bloco `related` na busca: até 5 vizinhos dos melhores resultados, separado do ranking e sem menções
- [x] Menções sem link, por dicionário de títulos e `aliases` (campo opcional novo). Precisão e cobertura de 0,93 num conjunto de 15 menções montado sobre o cérebro de exemplo
- [x] CLI: `graph`, `facts` e `search --as-of`
- [ ] Grafo exportado na branch de índice: a função que gera `nodes.jsonl` e `edges.jsonl` (determinística) existe e tem teste; a gravação na branch depende da branch de índice do M2
- [ ] **Medir o `related` e as menções num cérebro real** (os números acima são do cérebro de exemplo e do spike 12)

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
- [ ] `install-client` para Codex, Cursor, VS Code e Gemini CLI: o comando já existe desde o M1 para os seis clientes; falta validar com os clientes reais
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
| Sync em Windows e Linux | O CI roda os testes e o teste de ponta a ponta nos dois, só com remoto local | M1 |
| Scanner de segredos | Implementado; 53 de 53 sintéticos e 0 falsos positivos, nunca medido contra segredos reais | M1 |
| Clientes MCP reais | Nenhum cliente real (Claude Code, Claude Desktop, Codex, Cursor) foi testado contra o servidor do marco 1 | M1 |
| Cérebro real grande | Medido só com notas sintéticas (2 mil notas) | M1 |
| Vetores de arquiteturas diferentes na mesma busca | Não medido | M2 |
| Modelos fora da lista de sugestões | Não medidos; o usuário compara com `cabecao eval` | M2 |
| Busca medida num cérebro real | Só conjuntos sintéticos e públicos | M2 |
| Plugin instalado a partir do repositório público | Só marketplace local | M4 |
| Sessões interativas do Claude Code | Só modo não interativo | M4 |
| Instalação do `.mcpb` no Claude Desktop | Só gerado e validado | M5 |
| Modelo do Web Clipper na extensão | Não importado | M5 |
| macOS com processador Intel e Windows 10 | Sem máquina de teste | 1.0 |
| Publicação pelo GitHub Actions com proveniência | Só `--dry-run`; nunca executada | M0 |

## Ideias para depois do 1.0
- Ingestão de áudio e imagem com transcrição local.
- Plugin nativo do Obsidian com o painel "o que o Cabeção sabe".
- Acesso remoto ao servidor.
