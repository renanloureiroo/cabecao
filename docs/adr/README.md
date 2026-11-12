# Registro de decisões de arquitetura

Cada decisão traz o motivo e a evidência. Os números e os detalhes estão em [11 · Evidências](../11-evidencias.md). Uma decisão nova substitui a anterior, que fica riscada na lista.

| # | Decisão | Motivo | Alternativa descartada |
|---|---|---|---|
| 01 | Markdown + git são a fonte da verdade | Legível, portátil, auditável, reversível | Banco como fonte da verdade |
| 02 | Cérebro pessoal: um usuário, várias máquinas | Escopo definido pelo dono do projeto | Camadas de time, permissões, revisão |
| 03 | Qualquer remoto git; nenhuma API de provedor | Funcionar em GitHub, GitLab, Bitbucket, Gitea e servidor próprio | `gh`, Pull Request, GitHub Actions |
| 04 | Instalação só com a URL do repositório | Facilidade; cinco casos tratados automaticamente | Assistente com várias perguntas |
| 05 | TypeScript em Node `^22.16 \|\| >=24` | SDK de MCP de primeira linha; `npx`; FTS5 embutido a partir da 22.16 | Python, Rust, Go |
| 06 | `node:sqlite` embutido como banco local | Passou em 15 combinações de sistema e Node, sem dependência nativa | `better-sqlite3` (fica como plano B) |
| 07 | Busca vetorial por força bruta em JavaScript | 31–70 ms em 100 mil vetores; mesma velocidade do `sqlite-vec` | `sqlite-vec`, LanceDB |
| 08 | O usuário escolhe o modelo de embeddings ao ativar a busca por significado; o projeto documenta sugestões testadas | Não impor uma licença de modelo a ninguém; o melhor modelo em português (EmbeddingGemma 300m) não tem licença de código aberto reconhecida | Um modelo padrão fixo |
| 09 | Runtime de embeddings opcional, baixado sob demanda | Mantém o pacote em ~160 KB | Embutir `transformers.js` (470 MB) |
| 10 | Vetores em `int8` com escala por vetor | Mesma qualidade do `float32`, um quarto do tamanho | `float16`, binário, truncamento |
| 11 | Fusão convexa com cobertura (α = 0,5) | RRF derrubou paráfrases de 67% para 15% | RRF, reranker |
| 12 | Embeddings em segmentos imutáveis numa branch do mesmo repositório | Sem conflito por construção | JSONL com merge por união, Git LFS, segundo repositório |
| 13 | Branch de índice manipulada sem `git worktree` | O worktree quebrou em cinco situações | `git worktree`, refs fora de `refs/heads` |
| 14 | Integração em memória e aplicação única | Sem estado intermediário se o processo morrer | `pull --rebase` na pasta de trabalho |
| 15 | Conteúdo e índice no mesmo envio atômico | Evita recalcular embeddings em dobro | Dois envios |
| 16 | Gerações da branch de índice para reduzir histórico | Funciona onde reescrita é proibida | Reescrita com envio forçado |
| 17 | Conflito de nota preserva as duas versões | Nunca perde dado, nunca trava o repositório | Marcadores de conflito, resolução automática |
| 18 | Sem daemon; processos autossuficientes e agendador do sistema | Menos coisa para instalar e manter | Serviço permanente |
| 19 | Parser de Markdown próprio | 12 vezes mais rápido e mais correto nos casos testados | `remark`, `markdown-it` |
| 20 | Varredura incremental para detectar mudanças | Menos de 1 s em 30 mil notas; o aviso do sistema perde eventos | Depender só do aviso de arquivos |
| 21 | MCP nas duas gerações, com o SDK v2 | Clientes negociam uma ou outra; testado com o Claude Code real | Só a geração antiga ou só a nova |
| 22 | O servidor não tem LLM; quem raciocina é o agente | A especificação retirou o recurso; sem chave de API | LLM embutido |
| 23 | Sem a extensão Tasks | O Claude Code não usa; o lado do servidor seria escrito à mão | Tasks para operações longas |
| 24 | Confirmação destrutiva em duas chamadas, com elicitação quando houver | O modo não interativo cancela toda elicitação | Só elicitação |
| 25 | Wiki com grafo, e não GraphRAG | O grafo ajudou pouco no ranking; a navegação pelo agente empatou com a expansão no servidor | Extração por LLM, comunidades, PageRank |
| 26 | Validade no tempo como recurso de primeira classe | Versão vencida acima da correta caiu de 50–70% para 0% | Só a data de atualização |
| 27 | Relações tipadas: uma propriedade de lista por relação | Lista de objetos aparece como JSON cru no Obsidian | `relations: [{type, target}]` |
| 28 | Identificadores do esquema em inglês; conteúdo no idioma do usuário | Projeto público; tools em inglês | Tudo em português |
| 29 | Manutenção direta, com ponto de restauração e `undo` | Sem Pull Request, por requisito | Revisão por PR |
| 30 | Commits no estilo do Obsidian Git (`vault backup: <data e hora com milissegundos>`), com a operação no corpo e rodapés de operação, sessão, máquina e cliente | Histórico uniforme com o do Obsidian; auditar e desfazer por operação e por sessão pelos rodapés | Assunto no estilo de commit semântico; um commit por sync |
| 31 | Regras de uso no hook de início e nas instruções do servidor | 5 de 5 sessões usaram o cérebro; só com as tools, 1 de 5 | Só skill |
| 32 | Plugin com o servidor embutido | 0,05 s por execução, contra 1,4 s com `npx` | Plugin chamando `npx` |
| 33 | pnpm, tsdown, Vitest, Biome, Changesets | Build e testes passaram nos três sistemas | — |
| 34 | CI e publicação do **projeto** no GitHub Actions; o produto continua sem depender dele (decisão 03) | O repositório do projeto já está no GitHub; a matriz de três sistemas e três versões do Node sai de graça | Outro serviço de CI; publicar sempre à mão |
