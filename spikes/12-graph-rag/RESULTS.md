# Spike 12 — é só uma wiki ou é um GraphRAG? É moderno?

Data: 12/nov/2026. Código e reprodução no [README.md](README.md). Saída bruta completa em [corpus/results.md](corpus/results.md).

## Resposta direta

**É uma wiki com grafo, não um GraphRAG, e os números dizem que deve continuar assim.**

- "GraphRAG" no sentido da Microsoft (um LLM extrai entidades de cada trecho e pré-escreve resumos de comunidades) não cabe num servidor sem LLM e não se pagou aqui: no corpus de 296 notas, a busca híbrida simples já cobre 0,88 dos termos das perguntas globais com 6.000 caracteres de contexto.
- O que se pagou foi mais barato do que isso:
  1. **validade temporal dos fatos** (o maior efeito medido);
  2. **o grafo de wikilinks e relações exposto ao agente para navegar** e como bloco de "notas relacionadas";
  3. **resumos escritos pelo agente como notas comuns**, para perguntas globais com pouco contexto.
- É moderno? Sim, no sentido que a literatura de 2025–2026 aponta: busca híbrida, grafo determinístico barato, fatos com validade, e o agente navegando arquivos. A extração pesada por LLM em cada trecho é a parte do GraphRAG que os estudos comparativos mostram perder para RAG simples em perguntas factuais.

Tudo abaixo vem de um corpus sintético escrito por quem escreveu os métodos. Os tamanhos de efeito valem como ordem de grandeza, não como previsão para um vault real (ver [Limitações](#limitações)).

## Números principais

| pergunta | resultado medido |
|---|---|
| O grafo melhora multi-salto? | Sim, pouco. recall@10 sobe de 0,54 (híbrido) para 0,61–0,68, conforme o grafo e o método (56 perguntas; Δ do melhor: +0,14, IC 95% [0,08; 0,21]). |
| Wikilinks bastam? | Dão cerca de metade do ganho: 0,61. Wikilinks ∪ relações do agente com PageRank personalizado: 0,68. Grafo sem LLM (wikilinks + dicionário de títulos): 0,60–0,66. |
| Relações tipadas do agente rendem mais que o grafo sem LLM? | No ranqueamento, não deu para distinguir (0,65–0,68 contra 0,60–0,66; a ordem troca entre execuções). Na navegação, sim: a cadeia completa da resposta existe no grafo em 93% dos casos com wikilinks ∪ relações, contra 54% só com wikilinks e 71% com wikilinks + dicionário. |
| Similaridade de embedding como aresta ajuda? | Sozinha, não: 0,53–0,59 contra 0,54 do híbrido. |
| O filtro `as_of` funciona? | Sim. Versão vencida acima da correta: de 50–70% das perguntas para 0%. Primeiro resultado correto: de 30–40% para 70%. |
| E se o servidor filtrar sempre por "hoje"? | Perguntas sobre o passado zeram (recall@5 de 0,85 para 0,00). A data tem de ser parâmetro. |
| Resumos de comunidade ajudam em perguntas globais? | Os escritos pelo agente, sim: cobertura 0,81 contra 0,61 com 1.500 caracteres; 1,00 contra 0,88 com 6.000. Os extrativos sem LLM atrapalham: 0,21. |
| Expandir no servidor ou deixar o agente navegar? | Seguir links (3 chamadas, escolha por título) empata com a expansão no servidor (0,63–0,67 contra 0,58–0,61). Um agente que refaz a busca com a entidade-ponte chega a 0,81 em 2,4 chamadas (teto com oráculo). |
| O grafo prejudica outras categorias? | Misturado ao ranking, sim: em termo exato o recall@10 cai de 0,83 para 0,72–0,78, e o PageRank derruba o MRR temporal de 0,59 para 0,40. Como bloco separado, não. |
| JS puro dá conta? | Sim. Em 20k nós / 100k arestas: Louvain 87 ms, PageRank personalizado 6 ms, CTE recursiva de 2 saltos 1,6 ms. |

Achado lateral, fora do tema do grafo: o RRF simples **piora** termo exato em relação ao BM25 puro (recall@10 de 1,00 para 0,83; MRR de 1,00 para 0,56). Dar peso 3× ao BM25 quando a pergunta tem token com cara de código recupera só parte (0,89 / 0,75). Isso merece tratamento no plano de busca.

## Parte 1 — Estado da arte

Pesquisa feita por um subagente com acesso à web em 12/nov/2026. Os números são os publicados pelas próprias fontes. Itens marcados com (nv) não foram confirmados na fonte primária.

| abordagem | o que resolve | custo de indexar | o que funciona sem LLM |
|---|---|---|---|
| [Microsoft GraphRAG](https://arxiv.org/abs/2404.16130) | Perguntas globais sobre o corpus inteiro | LLM em cada trecho + resumos de comunidade. 115,5M tokens de entrada no MuSiQue, segundo a Tabela 12 do paper do HippoRAG 2 | Só a detecção de comunidades |
| [LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) | O mesmo, sem pagar a indexação | "Idêntico ao RAG vetorial e 0,1% do GraphRAG completo"; o LLM entra só na consulta | Sintagmas nominais por NLP, coocorrência, comunidades |
| [FastGraphRAG do graphrag](https://microsoft.github.io/graphrag/index/methods/) | Versão barata da indexação | LLM só nos relatórios de comunidade | Entidades por NLP; a doc avisa que o grafo fica bem mais ruidoso |
| [LightRAG](https://arxiv.org/abs/2410.05779) | Grafo + vetor, atualização incremental | LLM em cada trecho; 68,5M tokens de entrada na mesma tabela | Só o modo vetorial |
| [HippoRAG 2](https://arxiv.org/abs/2502.14802) | Multi-salto numa única recuperação | Extração de triplas por LLM; 9,2M tokens, cerca de 12× menos que o GraphRAG | PageRank personalizado (amortecimento 0,5), arestas de sinônimo por embedding |
| [Zep / Graphiti](https://arxiv.org/abs/2501.13956) | Fatos que mudam, com histórico | Várias chamadas de LLM por episódio | O modelo bitemporal e a regra de invalidação; busca por BM25, cosseno e BFS |
| [A-MEM](https://arxiv.org/abs/2502.12110) | Notas atômicas que se ligam e evoluem | 3 usos de LLM por escrita | Candidatos a link por cosseno |
| [Mem0 / Mem0g](https://arxiv.org/abs/2504.19413) | Fatos salientes de conversas | LLM por mensagem e por fato candidato | Busca vetorial |
| [Cognee](https://github.com/topoteretes/cognee) | Documentos e conversas viram grafo | LLM por padrão; desde a v1.6.0 roda sem chave, com NER local | NER (não relações ricas) |
| [RAPTOR](https://arxiv.org/abs/2401.18059) | Vários níveis de abstração | Resumo por cluster; o mais barato da tabela (1,7M tokens) | Embedding e clustering; os resumos não |
| [LLM Wiki (Karpathy)](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | Wiki em Markdown mantida pelo agente | O agente escreve ao ingerir; `index.md` como catálogo | Tudo no lado do servidor; diz dispensar embeddings até centenas de páginas |

O que os comparativos dizem:

- [Han et al., "RAG vs. GraphRAG"](https://arxiv.org/abs/2502.11371): RAG vence em fato único (NQ: 64,78 contra 61,03 do HippoRAG 2); grafo vence em multi-salto (HotpotQA: 63,01 contra 60,04). Integrar os dois dá +6,4%.
- [GraphRAG-Bench](https://arxiv.org/abs/2506.05690): em recuperação de fato simples, RAG com rerank faz 60,92 e o MS-GraphRAG 49,29. O grafo ganha em raciocínio complexo.
- No [próprio paper do Mem0](https://arxiv.org/abs/2504.19413), colocar a conversa inteira no contexto (72,90%) supera o Mem0 com grafo (68,44%) no LoCoMo. O argumento deles é custo e latência.
- [Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory): agente com `grep` e leitura de arquivos faz 74,0% no LoCoMo, acima do melhor Mem0 com grafo.
- [Auditoria do LoCoMo](https://github.com/dial481/locomo-audit): 6,4% do gabarito está errado e o juiz aceita respostas vagas. Números desse benchmark merecem desconfiança.
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493) (mai/2026): guardar trajetórias como arquivos e usar um agente de código fez 72,5%, contra 48,5% do melhor RAG.
- O time do Claude Code [trocou índice vetorial por busca agêntica](https://www.latent.space/p/claude-code); eles mesmos qualificam como impressão interna, não benchmark.

Os dois projetos mais próximos do Cabeção fazem a extração no cliente: o [servidor MCP oficial de memória](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) (entidades, relações e observações em JSONL) e o [Basic Memory](https://github.com/basicmachines-co/basic-memory) (Markdown com relações `- tipo [[Alvo]]`, SQLite, MCP; em Python).

Vistos só em resultado de busca (nv): réplica do Mem0 à Zep, Engram, Mandol, "In Defense of RAG".

**Leitura para o Cabeção.** O consenso é que grafo ajuda em multi-salto e sumarização e empata ou perde em fato único. A extração por LLM em cada trecho é a parte cara e a menos defensável. Sem LLM no servidor sobram exatamente as peças que os sistemas atuais usam por baixo: BM25, embeddings, grafo determinístico, PageRank personalizado, validade temporal e comunidades.

## Parte 2 — Medição

Corpus: 296 notas, 92 mil caracteres de corpo, 753 wikilinks, 824 relações tipadas em 223 notas, 60 fatos temporais. 100 perguntas de teste; parâmetros ajustados em 88 perguntas de dev separadas.

### Por categoria

Células: recall@5 / recall@10 / MRR da nota que contém a resposta.

| método | fato simples (22) | multi-salto (28) | temporal (20) | termo exato (18) |
|---|---|---|---|---|
| B0 BM25 (FTS5) | 0,82 / 0,91 / 0,78 | 0,53 / 0,64 / 0,19 | 0,82 / 0,97 / 0,66 | 1,00 / 1,00 / 1,00 |
| vetor sozinho (e5-base q8) | 0,91 / 0,95 / 0,86 | 0,43 / 0,51 / 0,07 | 0,70 / 0,85 / 0,43 | 0,39 / 0,50 / 0,23 |
| B1 híbrido RRF | 0,95 / 0,95 / 0,89 | 0,45 / 0,60 / 0,13 | 0,82 / 0,93 / 0,59 | 0,72 / 0,83 / 0,56 |
| G1 + vizinhos por wikilinks | 1,00 / 1,00 / 0,85 | 0,53 / 0,66 / 0,20 | 0,78 / 0,97 / 0,53 | 0,67 / 0,83 / 0,54 |
| G2 + vizinhos por relações e fatos | 0,95 / 0,95 / 0,65 | 0,53 / 0,68 / 0,19 | 0,90 / 0,97 / 0,67 | 0,56 / 0,78 / 0,41 |
| G2+ wikilinks ∪ relações | 0,95 / 1,00 / 0,84 | 0,47 / 0,68 / 0,11 | 0,88 / 0,97 / 0,57 | 0,61 / 0,72 / 0,42 |
| G3 PageRank personalizado, wikilinks | 0,95 / 0,95 / 0,93 | 0,56 / 0,68 / 0,14 | 0,82 / 0,97 / 0,40 | 0,72 / 0,78 / 0,56 |
| G3 PageRank personalizado, wikilinks ∪ relações | 0,95 / 0,95 / 0,88 | 0,49 / 0,75 / 0,18 | 0,82 / 0,97 / 0,40 | 0,72 / 0,78 / 0,58 |
| G3b B1 top-5 intacto + bloco de 5 por PageRank | 0,95 / 0,95 / 0,89 | 0,45 / 0,75 / 0,14 | 0,82 / 0,97 / 0,59 | 0,72 / 0,78 / 0,56 |
| G4 B1 + `as_of` informado pelo agente | 0,95 / 0,95 / 0,91 | 0,46 / 0,60 / 0,13 | 0,90 / 0,97 / 0,75 | 0,72 / 0,83 / 0,56 |
| G4 B1 + `as_of` fixo em hoje | 0,95 / 0,95 / 0,91 | 0,46 / 0,60 / 0,13 | 0,45 / 0,50 / 0,35 | 0,72 / 0,83 / 0,56 |

Latência: o híbrido custa 0,4–0,8 ms por consulta; a expansão acrescenta 0,03–0,07 ms e o PageRank 0,3 ms. Embutir a pergunta custa 13 ms (p50), comum a todos os métodos com vetor.

### Multi-salto (teste + extra, 56 perguntas)

| método | recall@10 | cadeia inteira no top-10 | Δ recall@10 contra B1 (IC 95%) |
|---|---|---|---|
| B1 híbrido | 0,54 | 0,21 | — |
| expansão, wikilinks (G1) | 0,61 | 0,32 | +0,07 [0,03; 0,12] |
| PageRank, wikilinks | 0,61 | 0,30 | +0,08 [0,03; 0,13] |
| expansão, wikilinks + dicionário | 0,60 | 0,27 | +0,06 [0,02; 0,10] |
| PageRank, wikilinks + dicionário | 0,66 | 0,38 | +0,12 [0,07; 0,18] |
| expansão, wikilinks + dicionário + kNN | 0,66 | 0,32 | +0,12 [0,06; 0,18] |
| expansão, só kNN de embeddings | 0,53 | 0,20 | −0,01 [−0,06; 0,04] |
| PageRank, só kNN de embeddings | 0,59 | 0,25 | +0,05 [0,00; 0,11] |
| PageRank, só relações do agente | 0,65 | 0,36 | +0,11 [0,06; 0,17] |
| PageRank, wikilinks ∪ relações | 0,68 | 0,38 | +0,14 [0,08; 0,21] |

O que dá para afirmar:

- Qualquer grafo feito de ligações explícitas melhora o multi-salto em relação ao híbrido. O ganho é modesto: 5 a 14 pontos de recall@10.
- A ordem entre as variantes não é confiável. Repetindo com embeddings recalculados em outro agrupamento de lotes, "PageRank sobre wikilinks + dicionário" oscilou entre 0,57 e 0,66. Diferenças menores que cerca de 0,08 entre variantes são ruído.
- Mesmo o melhor caso deixa a cadeia inteira fora do top-10 em 62% das perguntas. Em 3 saltos o recall@10 fica em 0,42–0,49 no conjunto de teste.

### De onde vem o ganho (G6)

| grafo | arestas | precisão / revocação das relações verdadeiras | cadeia do gabarito presente |
|---|---|---|---|
| wikilinks | 698 | 1,00 / 0,71 | 54% |
| wikilinks + dicionário de títulos e aliases | 967 | 0,94 / 0,91 | 71% |
| + coocorrência + kNN (tudo sem LLM) | 2.940 | — | 82% |
| relações do agente (frontmatter + fatos) | 822 | 0,87 / 0,72 | 63% |
| wikilinks ∪ relações do agente | 1.009 | 0,90 / 0,91 | 93% |

- O dicionário (casar títulos e aliases das notas no texto) recupera as menções não linkadas que são texto literal, com precisão 0,94 neste corpus.
- As relações do agente recuperam também as menções descritivas ("o relacional que o time já domina"), que texto literal não pega. É por isso que a união chega a 93%.
- O grafo só de kNN tem precisão 0,26 contra as relações verdadeiras e não ajuda sozinho.

Sensibilidade (multi-salto, 56 perguntas, recall@10; `sensitivity.out`). Cada célula de grafo é o melhor entre expansão e PageRank, o que é otimista:

| links no corpo / notas com relações | B1 | wikilinks | wikilinks + dicionário | só relações | wikilinks ∪ relações |
|---|---|---|---|---|---|
| 100% / 80% | 0,58 | 0,73 | 0,75 | 0,66 | 0,74 |
| 70% / 80% (padrão) | 0,54 | 0,61 | 0,66 | 0,65 | 0,68 |
| 40% / 80% | 0,55 | 0,59 | 0,66 | 0,73 | 0,64 |
| 70% / 30% | 0,57 | 0,72 | 0,69 | 0,61 | 0,78 |
| 70% / 100% | 0,57 | 0,73 | 0,72 | 0,75 | 0,72 |
| 40% / 100% | 0,54 | 0,67 | 0,64 | 0,75 | 0,71 |

Com o vault mal linkado (40%), só wikilinks rende menos (0,59–0,67) e as relações do agente passam a ser a melhor fonte (0,73–0,75). Com o vault bem linkado, wikilinks bastam.

### Temporal (G4)

| método | passado: 1º resultado correto | passado: obsoleto acima | atual: 1º resultado correto | atual: obsoleto acima |
|---|---|---|---|---|
| B0 BM25 | 0,50 | 0,50 | 0,40 | 0,60 |
| B1 híbrido | 0,40 | 0,50 | 0,30 | 0,70 |
| G3 PageRank, wikilinks ∪ relações | 0,10 | 0,40 | 0,20 | 0,60 |
| G4 B1 + `as_of` do agente | 0,70 | 0,00 | 0,70 | 0,00 |
| G4 B1 + `as_of` fixo em hoje | 0,00 | 1,00 | 0,70 | 0,00 |

- Sem validade, a busca não tem como separar "usa RabbitMQ" de 2025 de "usa SQS" de 2026: os dois textos casam igual.
- Nenhum grafo resolve isso. O PageRank piora, porque as versões da cadeia são vizinhas entre si.
- O filtro usa só `valid_from`, `valid_until` e `supersedes` do frontmatter. Para decisões, `valid_until` é derivado da data da decisão que a substitui.

### Perguntas globais (G5)

Cobertura dos termos do gabarito no contexto montado, por orçamento de caracteres (12 perguntas):

| método | 1.500 | 3.000 | 6.000 | 12.000 |
|---|---|---|---|---|
| B1 (notas) | 0,61 | 0,77 | 0,88 | 0,95 |
| G3 PageRank (notas) | 0,61 | 0,76 | 0,88 | 0,98 |
| relatórios extrativos sem LLM + B1 | 0,15 | 0,19 | 0,21 | 0,23 |
| resumos escritos pelo agente + B1 | 0,81 | 0,92 | 1,00 | 1,00 |

- Louvain sobre wikilinks ∪ relações achou 8 comunidades grandes, que seguem em boa parte as áreas do corpus (Plataforma saiu dividida em duas e o projeto Gávea ficou sozinho) (modularidade 0,54; 3 ms).
- Os 9 resumos foram escritos pelo agente do spike a partir de um extrato das notas: 9.633 caracteres para resumir 92 mil.
- Relatório extrativo (títulos centrais, relações mais frequentes, primeiras frases) ocupa o orçamento sem responder nada.
- Em 296 notas a vantagem dos resumos aparece com orçamento curto e nas perguntas que exigem agregar o corpus todo (ex.: "quais decisões foram substituídas": 0,30 com notas, 1,00 com resumo). Nas perguntas por área, as 4 notas de projeto já bastam.

### Busca agêntica simulada (A1/A2), 56 perguntas multi-salto

| estratégia | chamadas | recall@10 | recall@15 | cadeia inteira em 15 notas |
|---|---|---|---|---|
| B1 | 1 | 0,54 | 0,62 | 0,34 |
| expansão no servidor, wikilinks ∪ relações | 1 | 0,58 | 0,69 | 0,43 |
| expansão no servidor, grafo sem LLM | 1 | 0,61 | 0,70 | 0,41 |
| A1 segue wikilinks, escolhe pelo título | 3 | 0,63 | 0,68 | 0,39 |
| A1 segue wikilinks ∪ relações, escolhe pelo título | 3 | 0,67 | 0,72 | 0,43 |
| A1 oráculo, wikilinks (teto) | 3 | 0,69 | 0,78 | 0,57 |
| A1 oráculo, wikilinks ∪ relações (teto) | 3 | 0,75 | 0,89 | 0,75 |
| A2 refaz a busca com a entidade-ponte (oráculo) | 2,4 | 0,81 | 0,83 | 0,80 |

- Expandir no servidor e deixar um agente "ingênuo" seguir links dão o mesmo resultado. A diferença é o custo: 1 chamada contra 3.
- O teto do agente é bem mais alto que o de qualquer ranqueamento no servidor, e o grafo com relações sobe esse teto (0,57 para 0,75).
- A2 mostra que um agente que lê a nota certa e refaz a busca resolve 80% das cadeias sem grafo nenhum. É um teto, não uma medição de um LLM real.
- O ponto de entrada (a primeira nota da cadeia) está no top-5 do híbrido em 84% das perguntas; é o limite de todas as estratégias de navegação.

### Bibliotecas e escala (20k nós, 100k arestas, Node 24)

| item | resultado |
|---|---|
| graphology: construir o grafo | 238 ms, cerca de 37 MB |
| graphology-communities-louvain | 87 ms |
| graphology-metrics pagerank (global; não tem personalização) | 160 ms |
| ngraph.leiden 0.3.0 (Leiden em JS puro) | 744 ms; funciona, mas tem um mantenedor e adoção mínima |
| ngraph.louvain 2.0.0 | devolveu 1 comunidade no meu uso; parado desde 2022 |
| graphology-communities-leiden | não existe no npm (404) |
| PageRank personalizado próprio, CSR em `Uint32Array` | 6,4 ms por consulta; 0,9 MB; construção 8 ms |
| PageRank personalizado próprio, adjacência em `Map` | 24,6 ms por consulta |
| SQLite, CTE recursiva de 1 / 2 / 3 saltos, 10 sementes | 0,22 / 1,57 / 15,0 ms |
| SQLite: carregar as 100k arestas | 24 ms |
| nodes.jsonl / edges.jsonl | 1,4 MB / 10,8 MB |

Nenhuma dessas bibliotecas tem dependência nativa. A CTE recursiva basta para vizinhança de 1 e 2 saltos. PageRank personalizado precisa do grafo em memória, o que custa 24 ms para carregar e 8 ms para montar.

### Custo de construção (296 notas)

| etapa | tempo |
|---|---|
| ler Markdown e frontmatter | 16–37 ms |
| FTS5 | 2 ms |
| embeddings (e5-base q8, CPU) | 11–26 ms por texto; 6,5–15,5 s para 592 textos |
| grafo de wikilinks, relações, coocorrência | menos de 1 ms cada |
| dicionário de menções (regex ingênuo, um por título) | 235–310 ms; precisa de Aho-Corasick para escalar |
| kNN de embeddings | 93–118 ms |
| Louvain | 3 ms |

Artefatos: `nodes.jsonl` 28 KB; `edges.jsonl` 160 KB (753 wikilinks + 997 relações); arestas deriváveis sem LLM 215 KB, que não precisam ir para o git.

Custo para o agente: as relações no frontmatter somam 197 caracteres por nota (cerca de 56 tokens), 48% do tamanho dos corpos neste corpus de notas curtas.

## Recomendação de arquitetura

### O que entra, por prioridade

1. **Fatos e decisões com validade.** `valid_from`, `valid_until`, `supersedes` no frontmatter; parâmetro `as_of` na busca; cada resultado marcado como vigente ou vencido. Foi o maior efeito do spike e custa um filtro.
   - O padrão deve rebaixar ou marcar, nunca esconder: com filtro fixo em hoje as perguntas sobre o passado zeraram.
   - O servidor deriva `valid_until` a partir de `supersedes`; o agente só precisa escrever o link.
2. **Grafo determinístico em SQLite.** Tabela de arestas com wikilinks do corpo, links do frontmatter, relações tipadas e sujeito/objeto dos fatos. Reconstruível do Markdown a qualquer momento; nada extra no git.
3. **Ferramenta `graph` para o agente** (vizinhos tipados de uma nota, 1 ou 2 saltos, por CTE). É onde as relações tipadas rendem: cadeia completa disponível em 93% dos casos, com mediana de 10 vizinhos em 1 salto e 69 em 2.
4. **Bloco "relacionadas" na resposta da busca**, separado do ranking (top-5 do híbrido intacto + 5 vizinhos). Dá o ganho de multi-salto (+0,07 a +0,14 de recall@10) sem tocar nas outras categorias.
5. **Relações tipadas escritas pelo agente ao gravar a nota**, como convenção e não como obrigação. Valem mais quanto pior o vault estiver linkado.
6. **Menções não linkadas por dicionário**, como arestas derivadas e como sugestão de link para o agente ("lint"). Barato e com precisão 0,94 aqui; num vault real, nomes ambíguos vão baixar isso.
7. **Resumos como notas comuns** (`type: resumo`), escritos por um agente CLI agendado, no estilo do `index.md` do Karpathy. Louvain serve para sugerir o agrupamento. Vale deixar para depois: em 296 notas o ganho só aparece com contexto curto.

### O que não entra

- **Pipeline de GraphRAG** (extração por LLM em cada trecho, relatórios de comunidade automáticos). Não há LLM no servidor e a busca híbrida já cobre as perguntas globais neste tamanho.
- **Relatórios de comunidade extrativos sem LLM.** Pioraram a cobertura de 0,88 para 0,21.
- **Arestas de similaridade de embedding como grafo.** Sem ganho sozinhas; a busca vetorial já usa esse sinal.
- **PageRank personalizado misturado ao ranking padrão.** Ganha em multi-salto e perde em temporal e termo exato. Se entrar, é atrás de um parâmetro e como bloco separado.
- **Leiden e banco de grafos.** Louvain em JS resolve em 87 ms; SQLite resolve a vizinhança em 1,6 ms.
- **Expansão de 2 saltos no ranking.** Não se distinguiu da de 1 salto.

### Como popular o grafo sem LLM no servidor

| fonte | quem escreve | quando | o que medimos |
|---|---|---|---|
| wikilinks do corpo | humano ou agente | ao escrever | 54% das cadeias; precisão 1,00 |
| dicionário de títulos e aliases | servidor, sem LLM | ao indexar | sobe para 71%; precisão 0,94 |
| `relations` no frontmatter e notas de fato | agente cliente | ao gravar a nota | sobe para 93% junto com wikilinks; 56 tokens por nota |
| resumos e revisão de relações | agente CLI agendado | periódico | 9,6 mil caracteres para 296 notas; não medi custo em tokens de um LLM real |

## Limitações

- **Corpus sintético e autor único.** Os textos saem de moldes; as perguntas foram escritas sabendo como o corpus foi montado. Em notas reais os nomes são ambíguos, os links são mais irregulares e as perguntas são menos bem formadas.
- **Amostras pequenas.** 20 perguntas temporais, 18 de termo exato, 12 globais. Só o multi-salto foi ampliado para 56.
- **Dev e teste vêm do mesmo mundo.** O ajuste de parâmetros é otimista.
- **O agente cliente é simulado por parâmetros** (80% das notas com relações, 90% de captura, 5% de erro). Um LLM real pode errar de outras formas.
- **A1 e A2 não usam LLM.** A1 escolhe links por similaridade de título; A2 supõe que o agente sempre acha a entidade-ponte.
- **As perguntas globais medem cobertura de termos**, não a qualidade da resposta. Os resumos foram escritos por mim seguindo um roteiro que inclui riscos e decisões substituídas, que é também o que as perguntas pedem.
- **Sem reranker, sem divisão em trechos, sem geração de resposta.** Um reranker poderia mudar o quadro do multi-salto mais do que o grafo; não foi testado.
- **Escala.** A qualidade foi medida em 296 notas; em 20k notas medi só tempo.
- **Pesquisa.** Feita por subagente; não reabri as fontes uma a uma.
