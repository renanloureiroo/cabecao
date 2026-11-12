# 11 · Evidências

Nenhuma decisão entrou no plano sem ser testada. Esta página resume cada prova de conceito e aponta para o relatório completo, em [`spikes/`](../spikes/).

Só os relatórios e três scripts pequenos são versionados. O código das provas, os modelos baixados e as saídas brutas ficaram fora do repositório.

## Resumo

| # | Prova | Veredito | Relatório |
|---|---|---|---|
| 01 | SQLite embutido do Node como índice de texto | Aprovado | [script](../spikes/01-node-sqlite.mjs) |
| 02 | Busca vetorial em JavaScript puro | Aprovado | [script](../spikes/02-vector-bruteforce.mjs) |
| 03 | Embeddings em segmentos imutáveis numa branch separada | Aprovado | [script](../spikes/03-git-segments.sh) |
| 10 | Protocolo MCP nas duas gerações | Aprovado; Tasks descartado | [RESULTS](../spikes/10-mcp-protocol/RESULTS.md) |
| 11 | Modelos de embedding e busca em português | Modelo e fusão trocados | [RESULTS](../spikes/11-embeddings-eval/RESULTS.md) |
| 12 | GraphRAG vale a pena? | Não; wiki com grafo | [RESULTS](../spikes/12-graph-rag/RESULTS.md) |
| 13 | Sync ponta a ponta | Aprovado, com quatro mudanças | [RESULTS](../spikes/13-sync-e2e/RESULTS.md) |
| 14 | Plataformas e escala | Aprovado em 15 combinações | [RESULTS](../spikes/14-platform/RESULTS.md) |
| 15 | Claude Code, Claude Desktop e Obsidian | Aprovado, com mudança no frontmatter | [RESULTS](../spikes/15-integrations/RESULTS.md) |

## O que cada prova mudou no plano

### Protocolo MCP (10)
121 verificações automáticas e teste com o Claude Code 2.1.322 real.

- **Confirmado:** SDK v2 2.4.0, um servidor para as duas gerações, estado por identificador de sessão, subida em 70 a 100 ms.
- **Mudou:** a extensão Tasks saiu; a confirmação de ações destrutivas passou a ter como base duas chamadas com um código; as orientações ao agente vão dentro do resultado estruturado.

### Embeddings e busca (11)
Treze modelos, 178 trechos e 138 perguntas em português, mais Belebele e parte do Quati.

- **Mudou o modelo:** o pequeno que estava no plano acertou 17% das paráfrases; o EmbeddingGemma 300m, 67%.
- **Mudou a fusão:** RRF piorou o resultado; entrou a fusão convexa com cobertura.
- **Confirmado:** vetores em `int8` não perdem qualidade; o prefixo de contexto ajuda.
- **Saiu:** reranker e `transformers.js` como runtime.

### GraphRAG (12)
296 notas e 100 perguntas com gabarito, em cinco categorias.

- **Entrou com prioridade:** validade no tempo, tool `graph`, bloco de relacionadas separado do ranking.
- **Saiu:** extração por LLM, relatórios de comunidade, PageRank, arestas por semelhança, banco de grafos.

### Sync (13)
170 verificações em 13 cenários, com até três máquinas simuladas.

- **Mudou:** sem `git worktree`; integração em memória; envio atômico de conteúdo e índice; gerações em vez de reescrita de histórico.
- **Confirmado:** nenhuma máquina recalcula o que outra enviou; instalação só com a URL; recuperação após 74 mortes forçadas; `undo` entre máquinas.

### Plataforma e escala (14)
Linux, macOS e Windows, em x64 e ARM, com Node 22, 24 e 26, mais Alpine.

- **Confirmado:** `node:sqlite` nas 15 combinações; 30 mil notas indexadas em 13 a 26 s; pacote de 158 KB.
- **Mudou:** parser próprio no lugar de `remark`; varredura incremental no lugar de depender do aviso de arquivos; `sqlite-vec` descartado.
- **Definiu:** Node mínimo 22.16.

### Integrações (15)
Claude Code real em modo não interativo e Obsidian 1.15 real em instância separada.

- **Confirmado:** plugin, hook de início injetando contexto, painéis, grafo colorido, mapa em Canvas, pacote `.mcpb`.
- **Mudou:** relações tipadas passaram a ser uma propriedade por relação; o servidor do plugin é embutido; o hook de fim só dispara o sync; as regras de uso vão no hook de início e nas instruções do servidor.

## Limites gerais

- Os conjuntos de teste de busca e de grafo são sintéticos, escritos pelos agentes que rodaram os testes. Valem como ordem de grandeza.
- Nenhum provedor git real foi usado.
- As provas rodaram em máquina sob carga; os tempos locais são pessimistas.
- O que não foi testado está listado em cada relatório e resumido em [10 · Roadmap](10-roadmap.md).

## Prova cancelada

Uma prova sobre uso em time foi iniciada e cancelada quando o escopo voltou a ser um cérebro pessoal.
