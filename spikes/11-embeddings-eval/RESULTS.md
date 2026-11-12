# Spike 11 — Embeddings locais, busca híbrida e runtime: resultados

> PoC encerrada por tempo em 12/11/2026. Tudo o que está em tabela foi executado; o que não foi medido está
> listado em "Não medido" (§12). Como rodar: [`README.md`](./README.md). Tabelas completas nos apêndices.

## 0. Recomendação

| decisão | escolha | por quê (medido) |
|---|---|---|
| **Modelo padrão** | **EmbeddingGemma 300m, ONNX `q4`** (`onnx-community/embeddinggemma-300m-ONNX`, 197 MB, 768d) | melhor no sintético (MRR 0,872) e no Quati (nDCG@10 0,583; bge-m3 0,567); no Belebele 0,935, empatado no topo (pplx-0.6b 0,945); `q4` empata com `q8`/`fp16` e é o menor/mais rápido. **Ressalva de licença:** "Gemma Terms of Use" (não é licença OSI). O repositório ONNX **não é gated**; o original do Google é. |
| **Alternativa de licença limpa** | **EmbeddingGemma 2, ONNX `q4`** (`onnx-community/embeddinggemma-2-ONNX`, 175 MB, Apache-2.0, não gated) | MRR 0,802 no sintético (−0,07, diferença significativa, concentrada em paráfrase: 40% vs 67% de R@1), empata no Belebele (0,929) e fica próximo no Quati (0,537). Se a regra do projeto for "só Apache/MIT", este é o padrão. |
| **Modelo "qualidade"** | **nenhum modelo maior ganhou** | bge-m3 (570 MB) 0,836; arctic-l-v2 (570 MB) 0,810; harrier-0.6b 0,814; Qwen3-0.6B 0,789; pplx-0.6b 0,782 — todos abaixo do EmbeddingGemma 300m. O "modo qualidade" que funcionou é o **reranker** (abaixo), não um embedding maior. |
| **Runtime** | embeddings como **componente opcional baixado sob demanda**; núcleo do `npx cabecao` sem dependência nativa (BM25 do `node:sqlite` funciona sozinho). Primeira opção: **`onnxruntime-node` direto + `@huggingface/tokenizers`** (sem transformers.js). Candidato forte a validar: **`node-llama-cpp` + GGUF** (75 MB instalado). | transformers.js completo = 471–483 MB; `onnxruntime-node` sozinho = 291 MB (só ~45 MB são da plataforma atual); `node-llama-cpp` = 75 MB e deu a mesma qualidade (R@1 81,9 vs 83,3). Velocidade comparativa entre runtimes **não foi concluída** (§9). |
| **Formato do vetor** | **int8 com escala por vetor, dimensão cheia (768 B/trecho)**; float32 nunca vai para o git | int8 = float32 dentro do ruído em todos os modelos; float16 idêntico a float32 mas o dobro do tamanho; binário perde 2–6 pontos no Gemma e **destrói** os e5; truncar para 256d custa ~0,03–0,04 de MRR no Gemma 300m. ~7 MB por 10 mil trechos depois do zlib do git. |
| **Híbrido** | **combinação convexa com cobertura lexical**, `α = 0,5`, top-30 de cada lista; **não usar RRF puro** | RRF k=60 **piorou** o melhor modelo de 0,871 para 0,704 no sintético (paráfrase: 65% → 15% de R@1). A fusão com cobertura mantém 0,868 e melhora os públicos (Belebele 0,938 → 0,952). |
| **BM25** | FTS5 `unicode61 remove_diacritics 2`, colunas `text` + `heading`, consulta `OR` dos termos + prefixo de 5 letras | melhor variante das 4 medidas (MRR 0,553 vs 0,517 no sintético; 0,857 vs 0,836 no Belebele). |
| **Contexto barato** | **sim**: prefixar `Título › Seção` no texto embutido e indexar o título no FTS | +0,04 a +0,09 de MRR vetorial em quase todos os modelos; nas perguntas que dependem do título, R@1 sobe de 17–33% para 75–92%. |
| **Reranker** | **fora do padrão**; opcional `bge-reranker-v2-m3` apenas como modo "qualidade" explícito | não melhora o melhor modelo no sintético (0,857 → 0,859), ganha +0,02 no Belebele; salva modelos fracos (e5-small 0,699 → 0,824). Custo medido (com a máquina carregada): 571 MB e ~8,5 s para 30 candidatos de 300 tokens. O reranker pequeno (mMiniLM) **piora** o resultado. |

## 1. Ambiente e método

- **Máquina:** MacBook Pro, Apple M3 Pro (12 núcleos: 6P + 6E), 18 GB, macOS 27 (Darwin 27.0.0), Node v24.21.0.
- **Bibliotecas:** `@huggingface/transformers` 4.3.2 (`onnxruntime-node` 1.30.0), `onnxruntime-web` 1.31.1,
  `@huggingface/tokenizers` 0.2.0, `node-llama-cpp` 3.22.3, `fastembed` 3.0.0, `node:sqlite` (FTS5) embutido.
- **Máquina compartilhada:** durante toda a PoC outros agentes rodavam cargas pesadas na mesma máquina
  (load average entre 6 e 31, swap em uso). Consequências: (a) **qualidade não é afetada**; (b) os **tempos têm ruído** —
  as medições de custo foram refeitas numa passada separada, um processo por vez (`speed-all.mjs`,
  `runtime/bench-all.sh`, `rerank.mjs --cost-only`), mas ainda assim devem ser lidas como ordem de grandeza
  (±30%), não como benchmark de laboratório.
- **Um processo por modelo** (`embed.mjs`), para que tempo de carga e RAM (RSS) não se misturem.
- **Prefixos/pooling** de cada modelo vêm do model card e estão em `lib/models.mjs`. Dois casos em que o uso
  "óbvio" dá resultado errado e que o código do produto precisa tratar:
  - modelos com *last-token pooling* e tokenizer com padding à direita (jina-v5) só funcionam com lote 1 no
    `pipeline` do transformers.js (ele pega a última posição, que vira padding);
  - `Qwen3-Embedding-0.6B` em `q8` perde ~15 pontos de MRR em relação a `q4f16` (ver §3) — a quantização dinâmica
    int8 quebra esse modelo.
- **Métricas:** R@1, R@5, R@10 (acerto: algum trecho relevante até a posição k), MRR@10 e, no Quati (relevância
  graduada), nDCG@10. Com 138 perguntas, o erro-padrão de um R@1 de 80% é ≈ 3,4 pontos; diferenças menores que
  ~5 pontos entre modelos no conjunto sintético **não são significativas** (há IC por bootstrap pareado no Apêndice A).

## 2. Conjuntos de avaliação

| conjunto | origem | trechos | perguntas | o que mede |
|---|---|---:|---:|---|
| **Sintético** (`data/dataset.mjs`) | escrito para esta PoC, persona e empresa fictícias | 178 (média 17 palavras) | 138 | segundo cérebro: decisões, preferências, reuniões, conceitos, armadilhas, fatos pessoais |
| **Sintético + IDs** (`data/ids.mjs`) | sintético + 361 trechos gerados cheios de identificadores vizinhos | 539 | 198 | o mesmo, com o cofre "poluído" por centenas de `ERR_PAY_4xxx`, `INC-2xxx`, `ATL-123`, funções e variáveis parecidas |
| **Belebele por_Latn** | público (facebook/belebele, CC-BY-SA-4.0); mesma tarefa do `BelebeleRetrieval` do MTEB | 488 (~110 palavras) | 900 | pergunta → passagem, português traduzido por humanos; perguntas compartilham vocabulário com a passagem |
| **Quati 1M (pool julgado)** | público (unicamp-dl/quati, CC-BY-4.0), PT-BR nativo da web | 1.896 (~185 palavras) | 49 | passagens longas (~300 tokens) com relevância graduada; **só** as passagens julgadas nos qrels, não o milhão inteiro |

Composição das perguntas do conjunto sintético:

| tipo | n | definição | exemplo → trecho-alvo |
|---|---:|---|---|
| **P** paráfrase | 48 | nenhuma palavra de conteúdo em comum com o alvo nem com o título (verificado por `check-dataset.mjs`, radical de 5 letras) | "motivo de abandonar o broker antigo" → "A mensageria saiu do RabbitMQ e foi para o Amazon SQS…" |
| **E** termo exato | 40 | ID, função, código de erro, variável, nome próprio raro | `ERR_PAY_4012` (com `ERR_PAY_4021` como distrator), `calcularJurosMora` (vs. `calcularJurosCompostos`) |
| **V** curta/vaga | 38 | 1 a 4 palavras | "alergias", "seguro do carro" (com "seguro viagem" como distrator) |
| **C** vaga + contexto | 12 | a resposta depende do título/seção; o trecho não cita o projeto/data | "banco de dados do Farol" → trecho sob *Projeto Farol › Decisões* que só diz "escolhemos ClickHouse…" |
| **I** ID no meio de vizinhos | 60 | só no conjunto "+ IDs" | `INC-2166`, "o que é ADR-0013?" |

Limitações que valem para tudo o que segue: o conjunto principal é **sintético e escrito por um modelo de linguagem**
(a mesma família de modelos que treina embeddings), os trechos são curtos (notas atômicas) e o tipo P é
*adversarial para BM25 por construção* (35% das perguntas). Por isso toda conclusão é conferida nos dois conjuntos
públicos, que têm o viés oposto (perguntas que repetem palavras da passagem). Nenhum dado real do usuário foi lido.

## 3. Qualidade por modelo (busca vetorial pura)

Sintético = trecho embutido com prefixo `Título › Seção`. MRR@10 (R@1). Quati só foi rodado em 6 modelos.
Tabela completa, com todas as variantes de quantização, no Apêndice A.

| modelo (ONNX) | dims | Sintético MRR (R@1) | R@1 só paráfrase | Sintético+IDs MRR | Belebele MRR | Quati nDCG@10 (R@1) |
|---|---:|---:|---:|---:|---:|---:|
| **EmbeddingGemma 300m q4** | 768 | **0,872 (84,1)** | **66,7** | **0,883** | **0,935** | **0,583 (79,6)** |
| EmbeddingGemma 300m q8 / fp16 | 768 | 0,871 / 0,862 | 64,6 / 60,4 | 0,885 / 0,877 | 0,938 / 0,941 | não medido |
| jina-v5-text-nano q8 *(CC-BY-NC, só referência)* | 768 | 0,837 (76,8) | 54,2 | 0,823 | 0,937 | não medido |
| bge-m3 q8 | 1024 | 0,836 (76,8) | 47,9 | 0,823 | 0,928 | 0,567 (81,6) |
| EmbeddingGemma 2 fp16 / q8 | 768 | 0,817 / 0,818 | 41,7 / — | 0,848 / 0,847 | 0,927 / não medido | não medido |
| harrier-oss-v1-0.6b q4 | 1024 | 0,814 (76,8) | 47,9 | 0,823 | 0,935 | não medido |
| arctic-embed-l-v2.0 q8 | 1024 | 0,810 (73,9) | — | 0,815 | 0,926 | não medido |
| **EmbeddingGemma 2 q4** | 768 | 0,802 (74,6) | 39,6 | 0,823 | 0,929 | 0,537 (71,4) |
| arctic-embed-m-v2.0 q8 | 768 | 0,795 (72,5) | — | 0,810 | 0,917 | não medido |
| nomic-embed-text-v2-moe q8 *(ONNX de terceiros)* | 768 | 0,794 (73,9) | — | 0,793 | 0,923 | não medido |
| Qwen3-Embedding-0.6B q4f16 | 1024 | 0,789 (74,6) | 45,8 | 0,734 | 0,916 | não medido |
| pplx-embed-v1-0.6b q4 | 1024 | 0,782 (71,0) | 45,8 | 0,798 | **0,945** | não medido |
| gte-multilingual-base q8 | 768 | 0,774 (70,3) | — | 0,766 | 0,889 | não medido |
| granite-311m-multilingual-r2 (quint8) | 768 | 0,767 (69,6) | 39,6 | 0,718 | 0,886 | não medido |
| multilingual-e5-base q8 | 768 | 0,763 (71,7) | 39,6 | 0,772 | 0,903 | 0,495 (71,4) |
| harrier-oss-v1-270m q8 / q4 | 640 | 0,751 / 0,739 | 37,5 | 0,766 / 0,752 | 0,907 / 0,906 | não medido |
| multilingual-e5-small q8 / fp32 | 384 | 0,693 / 0,703 | 16,7 / 18,8 | 0,704 / 0,748 | 0,877 / 0,888 | 0,505 (71,4) |
| granite-97m-multilingual-r2 fp32 / q8 | 384 | 0,682 / 0,606 | 33,3 / 22,9 | 0,731 / 0,608 | 0,889 / 0,833 | 0,502 (fp32) |
| Qwen3-Embedding-0.6B q8 | 1024 | 0,635 (56,5) | 8,3 | 0,640 | 0,803 | não medido |
| paraphrase-multilingual-MiniLM-L12 q8 | 384 | 0,606 (51,4) | 31,3 | 0,436 | 0,773 | não medido |

BM25 sozinho, para comparação: Sintético 0,553 (R@1 52,9; paráfrase 0,0; termo exato 95,0) · Sintético+IDs 0,688 ·
Belebele 0,857 · Quati nDCG@10 0,402.

Leituras:

1. **EmbeddingGemma 300m é o melhor no Sintético, no Sintético+IDs e no Quati**; no Belebele fica em 0,935–0,941, atrás apenas do pplx-0.6b q4 (0,945) e empatado com harrier-0.6b — diferenças dentro do ruído. A a quantização do *modelo* (q4, q4f16, q8, fp16) não muda
   a qualidade além do ruído (0,862–0,872). No híbrido, q4 e q8 são estatisticamente indistinguíveis
   (Δ MRR −0,011, IC 95% [−0,029; 0,006]).
2. A diferença entre modelos está quase toda na **paráfrase sem sobreposição lexical**: 67% (Gemma 300m) → 48%
   (bge-m3, harrier-0.6b) → 40% (Gemma 2, e5-base) → 17% (e5-small). Em termo exato quase todos passam de 95%.
3. **EmbeddingGemma 2 não superou o 1** em português (o próprio card declara MTEB multilíngue 61,36 vs 61,15).
4. **Quantização que quebra o modelo:** Qwen3-0.6B `q8` (0,635 vs 0,789 em `q4f16`) e Granite-97m `q8`
   (0,606 vs 0,682 em fp32). Não dá para assumir que "q8 é seguro" — tem de medir por modelo.
5. O jeito "errado" do spike 04 para o EmbeddingGemma (pipeline + mean pooling) dá o mesmo resultado (0,862) que
   usar `sentence_embedding` do grafo; os 9/12 de lá eram só amostra pequena.
6. Mesmo com 361 IDs vizinhos no cofre, o vetor sozinho do Gemma 300m acha o ID certo em 96,7% (e5-small: 80%);
   o BM25 acha 100%.

## 4. Custo, tamanho, licença e gating

Tempos medidos **com a máquina sob carga de outros processos** (ver §1): servem para comparar ordens de grandeza
entre modelos, não como valor absoluto. A passada de velocidade em máquina ociosa **não foi concluída**.
"ms/trecho" = lote de 32 trechos de ~290 tokens.

| modelo | ONNX usado (MB) | dims | carga c/ cache (ms) | pergunta curta (ms) | ms/trecho lote 32 | RSS pico (MB) | licença | gated? |
|---|---:|---:|---:|---:|---:|---:|---|---|
| multilingual-e5-small q8 | 118 | 384 | 1058 | 9,5 | 37 | 1074 | MIT | não |
| paraphrase-multilingual-MiniLM q8 | 118 | 384 | 691 | 6,2 | 25 | 1184 | Apache-2.0 | não |
| granite-97m-r2 q8 / fp32 | 98 / 390 | 384 | 538 / 581 | 4,5 / 5,1 | 28 / 77 | 1284 / 1460 | Apache-2.0 | não |
| multilingual-e5-base q8 | 279 | 768 | 712 | 9,5 | 78 | 1095 | MIT | não |
| **EmbeddingGemma 300m q4** | **197** | 768 | 1020 | 12,4 | 94 | 1138 | Gemma Terms of Use | ONNX não; original do Google **sim** |
| EmbeddingGemma 300m q4f16 / q8 / fp16 | 176 / 310 / 618 | 768 | 861 / 993 / 1350 | 15 / 61 / 22 | 119 / 254 / 212 | 1430 / 1978 / 1548 | Gemma Terms of Use | idem |
| **EmbeddingGemma 2 q4** (só texto) | **175** | 768 | 1089 | 41 | 270 | 2799 | Apache-2.0 | não |
| EmbeddingGemma 2 q4f16 / q8 / fp16 | 157 / 314 / 543 | 768 | 1055 / 472 / 1533 | 51 / 53 / 36 | 341 / não medido / 320 | 2658 / — / 3212 | Apache-2.0 | não |
| harrier-oss-v1-270m q4 / q8 | 206 / 344 | 640 | 1038 / 918 | 57 / 136 | 247 / 278 | 1323 / 1434 | MIT | não |
| arctic-embed-m-v2.0 q8 | 311 | 768 | 690 | 12 | 106 | 2444 | Apache-2.0 | não |
| gte-multilingual-base q8 | 340 | 768 | 634 | 11 | 103 | 2492 | Apache-2.0 | não |
| granite-311m-r2 quint8 | 313 | 768 | 1222 | 24 | 157 | 1339 | Apache-2.0 | não |
| nomic-embed-text-v2-moe q8 | 478 | 768 | 953 | 27 | 274 | 3872 | Apache-2.0 | não |
| bge-m3 q8 | 570 | 1024 | 1021 | 20 | 208 | 1271 | MIT | não |
| arctic-embed-l-v2.0 q8 | 570 | 1024 | 845 | 27 | 245 | 2275 | Apache-2.0 | não |
| harrier-oss-v1-0.6b q4 | 399 | 1024 | 1053 | 217 | 1183 | 2646 | MIT | não |
| Qwen3-Embedding-0.6B q8 / q4f16 | 614 / 568 | 1024 | 719 / 708 | 74 / 50 | 1898 / não medido | 3092 / 2412 | Apache-2.0 | não |
| pplx-embed-v1-0.6b q4 | 399 | 1024 | 855 | 47 | não medido | 1348 | MIT | não |
| jina-v5-text-nano q8 | 247 | 768 | 247 | 46 | não medido | 751 | **CC-BY-NC-4.0** | não |

Notas: (a) além do ONNX, cada modelo baixa um `tokenizer.json` de 11–32 MB. (b) O pico de RSS inclui o lote de
32×300 tokens; depois de carregar, o Gemma 300m q4 ficava em ~550 MB. (c) Nenhum repositório ONNX usado exige login;
o único gated é `google/embeddinggemma-300m` (o original). `jina-*` é não comercial → fora. Os repos `Xenova/*` e
alguns `onnx-community/*` não declaram licença no card; vale a do modelo original (Apêndice D).
(d) `nomic-v2-moe` só tem ONNX de terceiros (`netrias`, 69 downloads) e o próprio card avisa que as variantes
quantizadas dão vetores diferentes conforme a composição do lote.

## 5. Híbrido (vetor + BM25)

MRR@10 no Sintético / Sintético+IDs / Belebele; nDCG@10 no Quati. Top-30 de cada lista.

| modelo | conjunto | BM25 | vetor | RRF k=60 | convexa min-max α=.5 | **convexa c/ cobertura α=.5** | idem α=.3 | idem α=.7 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Gemma 300m q4 | Sintético | 0,553 | 0,872 | **0,708** | 0,781 | **0,857** | 0,827 | 0,870 |
| Gemma 300m q4 | Sintético+IDs | 0,688 | 0,883 | 0,783 | 0,833 | **0,883** | 0,864 | 0,882 |
| Gemma 300m q4 | Belebele | 0,857 | 0,935 | 0,928 | 0,947 | **0,952** | 0,958 | 0,945 |
| Gemma 300m q4 | Quati | 0,402 | 0,583 | 0,564 | 0,536 | **0,580** | 0,527 | 0,595 |
| Gemma 2 q4 | Sintético | 0,553 | 0,802 | 0,688 | 0,734 | **0,791** | 0,757 | 0,806 |
| Gemma 2 q4 | Belebele | 0,857 | 0,929 | 0,932 | 0,952 | **0,946** | 0,954 | 0,938 |
| e5-small q8 | Sintético | 0,553 | 0,693 | 0,645 | 0,650 | **0,699** | 0,685 | 0,699 |
| e5-small q8 | Sintético+IDs | 0,688 | 0,704 | 0,728 | 0,742 | **0,760** | 0,761 | 0,748 |
| e5-small q8 | Belebele | 0,857 | 0,877 | 0,912 | 0,926 | **0,914** | 0,929 | 0,896 |
| granite-97m fp32 | Sintético | 0,553 | 0,682 | 0,656 | 0,649 | **0,740** | 0,731 | 0,716 |

R@1 por tipo no Sintético (Gemma 300m q4): vetor P 66,7 / E 97,5 / V 94,7 / C 75,0 → RRF P **14,6** / E 100 / V 84,2 /
C 66,7 → convexa com cobertura P 58,3 / E 100 / V 92,1 / C 75,0.

- **RRF puro é perigoso.** Quando a pergunta não compartilha palavras com o alvo, o BM25 devolve trechos que casam
  por uma palavra solta; como o RRF só olha posição (1/61 ≈ 1/70), qualquer trecho que apareça nas duas listas
  ultrapassa o primeiro colocado do vetor. Pesar 2:1 a favor do vetor não resolve (0,718).
- **Fusão recomendada** (`convexCov` em `lib/search.mjs`):
  `score = α · minmax(cosseno no top-30) + (1 − α) · cobertura`, onde
  `cobertura = min(1, bm25(trecho) / Σ idf(termos da pergunta))` — quanto da pergunta, ponderada por raridade, o
  trecho cobre. Palavra solta em comum dá cobertura ~0,2; ID exato dá ~0,9–1,0. `α = 0,5`; entre 0,4 e 0,6 a
  variação é ≤ 0,02 em todos os conjuntos (o ótimo é ~0,3 no Belebele e ~0,7 no Sintético/Quati).
- **O híbrido compensa um modelo pequeno? Só em parte.** No Belebele (perguntas que repetem palavras) e5-small +
  BM25 chega a 0,914–0,929 contra 0,952 do Gemma + BM25. No Sintético, não: 0,699 contra 0,857 — a diferença é
  paráfrase, que o BM25 não recupera (0%). Com o melhor modelo o híbrido rende pouco no Sintético e no Quati
  (≈ empate) e +0,015 no Belebele; a função dele é segurar termo exato/ID (E 97,5 → 100) sem estragar paráfrase.

## 6. Reranker (por cima do híbrido, top-30)

MRR@10 / R@1. Belebele com 150 perguntas. Custos medidos com a máquina carregada (a remedição ociosa não foi feita).

| candidatos de | conjunto | sem reranker | mMiniLMv2-L12 qint8 (119 MB) | bge-reranker-v2-m3 q8 (571 MB) | jina-reranker-v2 q8 (280 MB, CC-BY-NC) |
|---|---|---:|---:|---:|---:|
| e5-small q8 | Sintético | 0,699 / 62,3 | 0,635 / 55,8 | **0,824 / 79,0** | 0,762 / 70,3 |
| Gemma 2 q4 | Sintético | 0,791 / 73,2 | 0,677 / 59,4 | **0,861 / 81,2** | 0,788 / 72,5 |
| Gemma 300m q4 | Sintético | 0,857 / 81,2 | 0,654 / 56,5 | 0,859 / 81,2 | 0,771 / 69,6 |
| Gemma 300m q4 | Sintético+IDs | 0,883 / 85,9 | 0,738 / 66,2 | 0,861 / 81,8 | ver Apêndice B |
| Gemma 300m q4 | Belebele | 0,957 / 94,0 | 0,944 / 92,7 | **0,980 / 96,7** | ver Apêndice B |
| e5-small q8 | Belebele | 0,918 / 89,3 | 0,939 / 92,7 | **0,973 / 96,0** | ver Apêndice B |

| reranker | 30 candidatos de ~300 tokens | 30 candidatos curtos | RSS pico | carrega no transformers.js 4.3.2? |
|---|---:|---:|---:|---|
| mMiniLMv2-L12 qint8 | 1,5 s | 0,3 s | 846 MB | sim |
| bge-reranker-v2-m3 q8 | 8,5 s | 1,9 s | 1565 MB | sim |
| jina-reranker-v2 q8 | 1,7 s | 0,3 s | 1257 MB | não ("Unsupported model type") — rodou via onnxruntime-node direto |
| gte-multilingual-reranker-base q8 | **não medido** | — | — | não ("Unsupported model type: new"); a tentativa via ORT direto falhou por um bug meu e a correção não chegou a rodar |

Conclusão: o reranker **não entra no padrão**. Com o Gemma 300m ele não melhora o conjunto de segundo cérebro
(e derruba paráfrase de 58 para 52% de R@1), ganha +0,02 no Belebele, e custa segundos por busca e mais 571 MB.
O reranker pequeno (mMiniLM) piora quase tudo (perguntas vagas: 92% → 50%). Vale como opção explícita de
"qualidade" só para quem ficar num modelo de embedding fraco.

## 7. Contexto barato (`Título › Seção` antes do trecho)

| modelo | MRR vetor sem → com | R@1 nas 12 perguntas dependentes do título sem → com | MRR híbrido sem → com |
|---|---:|---:|---:|
| Gemma 300m q4 | 0,825 → 0,872 | 33,3 → 75,0 | 0,819 → 0,857 |
| Gemma 300m q8 | 0,828 → 0,871 | 25,0 → 83,3 | 0,821 → 0,868 |
| Gemma 2 q4 | 0,778 → 0,802 | 33,3 → 83,3 | 0,770 → 0,791 |
| bge-m3 q8 | 0,796 → 0,836 | 33,3 → 91,7 | 0,798 → 0,829 |
| e5-base q8 | 0,701 → 0,763 | 16,7 → 66,7 | 0,719 → 0,767 |
| e5-small q8 | 0,608 → 0,693 | 16,7 → 75,0 | 0,629 → 0,699 |

Melhora em todos os modelos medidos menos o MiniLM (0,619 → 0,606). No EmbeddingGemma o título vai no campo
próprio do prompt (`title: {Título › Seção} | text: {trecho}`); nos demais, como primeira linha. No BM25, indexar o
título como segunda coluna leva o R@1 das perguntas dependentes do título de 41,7% para 58,3%.
Só foi medido no conjunto sintético (os públicos não têm título) e são só 12 perguntas desse tipo.

## 8. Armazenamento do vetor

Busca vetorial pura no Sintético, MRR@10:

| modelo | float32 | float16 | int8 (escala por vetor) | int8 ingênuo (x·127) | binário (Hamming) | binário top-50 → rescoring int8 | Matryoshka 512d / 256d / 128d |
|---|---:|---:|---:|---:|---:|---:|---:|
| Gemma 300m q4 (768d) | 0,872 | 0,872 | 0,872 | 0,873 | 0,814 | 0,872 | 0,847 / 0,828 / 0,793 |
| Gemma 300m q8 (768d) | 0,871 | 0,871 | 0,871 | 0,862 | 0,832 | 0,871 | 0,850 / 0,838 / 0,790 |
| Gemma 2 q4 (768d) | 0,802 | 0,802 | 0,798 | 0,793 | 0,783 | 0,791 | 0,805 / 0,779 / 0,698 |
| bge-m3 q8 (1024d) | 0,836 | 0,836 | 0,836 | 0,844 | 0,785 | 0,837 | — / 0,741* / 0,641* |
| arctic-m-v2 q8 (768d) | 0,795 | 0,795 | 0,795 | 0,794 | 0,773 | 0,795 | — / 0,795 / 0,724* |
| e5-base q8 (768d) | 0,763 | 0,763 | 0,764 | 0,756 | **0,327** | 0,725 | — / 0,666* / 0,577* |
| e5-small q8 (384d) | 0,693 | 0,693 | 0,690 | 0,692 | **0,153** | 0,539 | — / 0,645* / 0,538* |

`*` = dimensão não declarada como Matryoshka pelo modelo. Truncado + int8 dá o mesmo que truncado em float
(diferença ≤ 0,007). Mesma análise no Belebele: Apêndice A.

| formato (Gemma 300m, 768d) | bytes/trecho | após zlib (binário) | como base64 em texto + zlib | 10 mil trechos no git |
|---|---:|---:|---:|---:|
| float32 | 3072 | 2851 | 3050 | 28,5–30,5 MB |
| float16 | 1536 | 1415 | 1499 | 14,2–15,0 MB |
| **int8** | **768** | **699** | **761** | **7,0–7,6 MB** |
| int8 truncado a 256d | 256 | 236 | 256 | 2,4–2,6 MB |
| binário | 96 | 96 | 96 | 1,0 MB |

- **int8 com escala por vetor** (divide pelo maior valor absoluto do vetor, multiplica por 127; cosseno ignora a
  escala) é o melhor custo/benefício: 4× menor que float32 sem perda mensurável. O `x·127` do spike 04 funciona
  mas perde até 0,009 em alguns modelos; em 1024d ele usa poucos níveis.
- **float16 não compensa**: idêntico a float32, o dobro do int8.
- **Binário depende do modelo**: aceitável no Gemma (−0,04 a −0,06; com rescoring int8 volta ao normal, mas aí o
  int8 já está guardado), inutilizável nos e5 (vetores não centrados).
- **Matryoshka 256d + int8** (256 B) é a opção se o tamanho do repositório apertar: −0,03 a −0,04 de MRR no
  Gemma 300m. Guardar 768d int8 permite truncar depois sem reembutir.
- Vetores praticamente não comprimem (zlib tira ~9%); base64 em texto custa ~9% a mais que binário depois do zlib.

## 9. Peso de instalação e runtime

Tamanho instalado (`runtime/install-all.sh`) e download (`runtime/cold-install.sh`, cache npm frio, rede desta máquina):

| opção | `node_modules` | tarball(s) comprimidos | instalação fria | observação |
|---|---:|---:|---:|---|
| `@huggingface/transformers` 4.3.2 | 471–483 MB | ~150 MB | 51 s | onnxruntime-node 288 + onnxruntime-web 141 + sharp/libvips 18 + lib 14 |
| `onnxruntime-node` 1.30 + `@huggingface/tokenizers` | 291–296 MB | 113,5 MB | 23 s | o pacote traz as 5 plataformas; a atual usa ~45 MB (darwin-arm64: dylib de 44,6 MB, duplicada no pacote; linux-x64: 45,8 MB) |
| `onnxruntime-web` 1.31 + tokenizers (WASM) | 154 MB | 34,6 MB | 14 s | só `ort-wasm-simd-threaded.wasm` (14,3 MB) + JS são necessários |
| `node-llama-cpp` 3.22 + GGUF | 75–77 MB | 37,4 + 5,9 MB (mac) / 11,9 MB (linux-x64, win-x64) | 26 s | 36 MB são fontes do llama.cpp para compilar se não houver binário pronto |
| `fastembed` 3.0 | 235 MB | não medido | — | traz onnxruntime-node 1.21 + tokenizer nativo; único modelo multilíngue embutido é o e5-large |
| `@huggingface/tokenizers` sozinho | 0,6 MB | 0,1 MB | — | JS puro, sem dependências |

O que foi verificado funcionando (qualidade no conjunto sintético, R@1 / MRR):

| runtime | modelo | resultado | status |
|---|---|---|---|
| transformers.js (onnxruntime-node) | e5-small q8 | 61,6 / 0,693 | referência |
| **onnxruntime-node direto + tokenizers.js** (sem transformers.js) | e5-small q8 | 61,6 / 0,693 — idêntico | funciona (`runtime/ort-direct.mjs`) |
| **onnxruntime-web (WASM) direto no Node + tokenizers.js** | e5-small q8 | 63,8 / 0,716 | funciona; vetores não idênticos aos do ORT nativo |
| transformers.js com `device: 'wasm'` no Node | — | erro `Unsupported device: "wasm"` (só `cpu`, `coreml`, `webgpu`); injetar onnxruntime-web por `Symbol.for('onnxruntime')` também falha | **não funciona** em 4.3.2 |
| **node-llama-cpp (Metal)** | embeddinggemma-300M Q8_0 GGUF (334 MB) | 81,9 / 0,862 (ONNX q8: 83,3 / 0,871) | funciona |

Velocidade entre runtimes — **só há uma medição de cada, feita com a máquina disputada por outros processos; trate
como indício, não como resultado**: no mesmo momento, e5-small q8 fez 62 ms/trecho no onnxruntime-node direto e
199 ms/trecho no WASM (≈ 3× mais lento; pergunta curta 7 ms vs 42 ms); node-llama-cpp com Metal fez 26 ms/trecho e
11,5 ms por pergunta com o EmbeddingGemma 300m Q8_0 (o ONNX q8 em CPU marcou 254 ms/trecho em outra hora do dia).
O benchmark comparativo limpo (`runtime/bench-all.sh`) **não foi executado**.

Estratégia que mantém o `npx cabecao` leve:

1. O pacote principal não depende de nenhum runtime de ML. Busca lexical (FTS5) funciona na instalação zero.
2. Embeddings = passo explícito (`cabecao embeddings enable` ou primeira busca semântica) que baixa para
   `~/.cabecao/` o runtime e o modelo (197 MB). Custo medido do runtime na primeira vez: 23–26 s e 114 MB de
   download (ORT) ou 43–49 MB (llama.cpp), contra 51 s / ~150 MB do transformers.js completo.
3. Não é preciso transformers.js em produção: sessão ONNX + `@huggingface/tokenizers` (0,6 MB) + ~40 linhas de
   pooling/normalização reproduzem os mesmos vetores. Para os modelos Gemma o grafo já devolve `sentence_embedding`.
4. Com ORT, baixar só o binário da plataforma (~45 MB) em vez do pacote npm de 291 MB — ideia **não implementada
   nem testada** aqui.

## 10. Provedor alternativo: Ollama (apenas documentado — NÃO testado, não está instalado)

Fonte: documentação oficial (`docs.ollama.com/capabilities/embeddings`, `docs.ollama.com/api/embed`,
`docs.ollama.com/api/openai-compatibility`) e a listagem `ollama.com/search?c=embedding`, consultadas em 12/11/2026.

**Interface**

- `POST http://localhost:11434/api/embed` com `{ "model": "...", "input": "texto" | ["t1", "t2"] }`.
  Campos opcionais documentados: `truncate` (bool, padrão `true`), `dimensions` (inteiro — truncamento Matryoshka
  no servidor), `keep_alive`, `options` (ex.: `num_ctx`).
- Resposta: `{ model, embeddings: number[][], total_duration, load_duration, prompt_eval_count }`.
  A doc afirma que `/api/embed` devolve vetores **já normalizados (L2)**.
- Também há `POST /v1/embeddings` compatível com OpenAI (`model`, `input` string ou array, `dimensions`,
  formato de codificação; `user` não é suportado).
- Em JS: `ollama.embed({ model, input })` → `res.embeddings`.

```js
// esboço do adaptador (não executado)
async function embedOllama(texts, { model = 'embeddinggemma', host = 'http://localhost:11434', dimensions } = {}) {
  const r = await fetch(`${host}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts, ...(dimensions ? { dimensions } : {}) }) });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  return (await r.json()).embeddings; // já em norma 1
}
```

**Modelos de embedding listados hoje na biblioteca do Ollama**

| modelo (tag) | tamanhos | observação |
|---|---|---|
| `embeddinggemma-2` | 270m (texto, 304 MB em q8_0), 440m, 570m, 740m (`latest` = 740m multimodal, 1,3 GB) | o mais recente; o mesmo modelo que medimos em ONNX/GGUF |
| `embeddinggemma` | 300m | o EmbeddingGemma 1 que venceu nossas medições |
| `qwen3-embedding` | 0.6b, 4b, 8b | |
| `bge-m3` | 567m | |
| `nomic-embed-text-v2-moe` | — | multilíngue |
| `snowflake-arctic-embed2` | 568m | multilíngue (arctic-embed-l-v2.0) |
| `granite-embedding` | 30m (só inglês), 278m (multilíngue, geração anterior à R2) | |
| `paraphrase-multilingual` | 278m | |
| `nomic-embed-text`, `mxbai-embed-large`, `all-minilm`, `snowflake-arctic-embed`, `bge-large` | — | essencialmente inglês |
| `laya` | — | listado na categoria, mas é um modelo de decisão, não de recuperação |

**Pontos de atenção para o plano (não medidos):**

1. Os **prefixos de tarefa continuam sendo responsabilidade do cliente** (`task: search result | query: …` no
   EmbeddingGemma, `query: `/`passage: ` no e5 etc.) — a doc do Ollama não menciona aplicação automática de prefixo.
   O adaptador deve reutilizar a mesma tabela de prefixos de `lib/models.mjs`.
2. Vetores de provedores diferentes **não são comparáveis** mesmo sendo "o mesmo modelo" (GGUF q8_0 do Ollama vs.
   ONNX q4 local): no nosso teste, ONNX e GGUF do mesmo modelo dão qualidade equivalente, mas os vetores não são
   idênticos. O índice precisa gravar `provedor + modelo + quantização + dims` e reembutir se mudar.
3. `latest` do `embeddinggemma-2` é a variante multimodal de 1,3 GB; para texto o certo é a tag `270m`.

## 11. O que foi derrubado e por quê

| item | motivo (medido) |
|---|---|
| multilingual-e5-small / e5-base como padrão | 0,693 / 0,763 de MRR contra 0,872; paráfrase 17% / 40% contra 67%. O ganho de tamanho (118 MB vs 197 MB) não paga. |
| paraphrase-multilingual-MiniLM | pior de todos (0,606; 0,436 com IDs no cofre). |
| bge-m3, arctic-embed-l-v2, harrier-0.6b, Qwen3-0.6B, pplx-0.6b como modelo "qualidade" | 2–3× maiores e mais lentos; abaixo do EmbeddingGemma 300m no sintético e no Quati (bge-m3), e no máximo empatados no Belebele. |
| Qwen3-Embedding-0.6B `q8`, Granite-97m-r2 `q8` | a quantização derruba a qualidade (−0,15 e −0,08 de MRR). |
| Granite R2 (97m e 311m), harrier-270m, gte-multilingual-base, arctic-m-v2, nomic-v2-moe | corretos, mas abaixo do Gemma em todos os conjuntos; nomic só com ONNX de terceiros. |
| jina-embeddings v3/v5, jina-reranker-v2 | CC-BY-NC-4.0. (v5-nano mediu 0,837 — bom, mas não utilizável como padrão.) |
| F2LLM-v2 | 0.6B só em ONNX fp32 de 2,4 GB; o ONNX de 80M devolve HTTP 401. Não testado. |
| RRF k=60 (com ou sem peso) e combinação convexa com min-max nos dois lados | pioram o melhor modelo (0,872 → 0,708 / 0,781). |
| Reranker no caminho padrão | sem ganho com o melhor modelo no caso de uso; segundos por busca. |
| Reranker pequeno (mmarco-mMiniLMv2) | piora o ranking. |
| float32 / float16 no armazenamento | int8 dá o mesmo resultado com 1/4 ou 1/2 do tamanho. |
| Binário como formato único | perde 4–6 pontos no Gemma e não funciona nos e5. |
| transformers.js com backend WASM no Node | não suportado na 4.3.2. |
| transformers.js como dependência direta do pacote | 471 MB instalados. |
| fastembed-js | 235 MB e nenhum modelo multilíngue pequeno. |

## 12. Não medido / limitações

- **Velocidade em máquina ociosa**: a passada dedicada (`speed-all.mjs`) e o benchmark de runtimes
  (`runtime/bench-all.sh`) não rodaram. Os tempos das tabelas vêm da execução principal, com outros processos
  pesados na máquina; `ms/trecho` de EmbeddingGemma 2 q8, Qwen3 q4f16, pplx e jina-v5 não foi medido.
- **node-llama-cpp**: só um modelo (EmbeddingGemma 300m Q8_0), só macOS arm64 com Metal. CPU pura, GGUF do
  EmbeddingGemma 2 e do Granite (já baixados), Linux e Windows: não medidos.
- **CoreML / WebGPU no Node** (o transformers.js lista os dois como dispositivos): não medidos.
- **Reranker gte-multilingual-reranker-base** e a remedição de custo dos rerankers: não medidos.
- **Quati**: só 6 modelos, e é um reordenamento do pool julgado (1.896 passagens), não busca em 1 milhão.
  harrier-270m no Quati foi cancelado.
- **nomic-v2-moe fp16** e **EmbeddingGemma 2 q8 no Belebele**: cancelados por tempo.
- **mMARCO-pt**: não usado (coleção de ~3 GB); os conjuntos públicos foram Belebele e Quati.
- **Determinismo entre máquinas** (x86 vs ARM, ONNX vs GGUF) dos vetores int8 — relevante para sincronizar por
  git — não foi testado. Entre runtimes na mesma máquina os vetores não são idênticos (ver §9).
- **Baixar só o binário de uma plataforma do onnxruntime**: ideia, não implementada.
- **Ollama**: apenas documentado.
- Corpus pequeno (178–1.896 trechos). O comportamento com dezenas de milhares de trechos reais não foi medido.
- O conjunto principal é sintético e 35% dele é adversarial para BM25 por construção; a proporção real de
  perguntas-paráfrase num segundo cérebro é desconhecida e muda o tamanho do ganho do vetor sobre o BM25.


---

# Apêndice A — Tabelas completas de recuperação (geradas por `eval.mjs`)

## Conjunto: Sintético (segundo cérebro) — 178 trechos, 138 perguntas

### BM25 (FTS5 `unicode61 remove_diacritics 2`)

| variante | R@1 | R@5 | R@10 | MRR@10 | R@1 P | R@1 E | R@1 V | R@1 C |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| texto, OR | 48.6 | 55.8 | 55.8 | 0.517 | 0.0 | 95.0 | 71.1 | 16.7 |
| texto, OR+prefixo | 51.4 | 56.5 | 56.5 | 0.537 | 0.0 | 95.0 | 73.7 | 41.7 |
| texto+título, OR | 51.4 | 56.5 | 58.7 | 0.539 | 0.0 | 95.0 | 71.1 | 50.0 |
| texto+título, OR+prefixo | 52.9 | 58.7 | 59.4 | 0.553 | 0.0 | 95.0 | 73.7 | 58.3 |

### Vetor sozinho (trecho embutido com prefixo `Título › Seção`)

| modelo | dims | R@1 | R@5 | R@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| gemma300m-q4 | 768 | 84.1 | 92.0 | 94.2 | 0.872 |
| gemma300m-q8 | 768 | 83.3 | 92.8 | 94.9 | 0.871 |
| gemma300m-q4f16 | 768 | 82.6 | 92.0 | 94.2 | 0.864 |
| gemma300m-fp16 | 768 | 81.9 | 92.8 | 94.9 | 0.862 |
| gemma300m-q8-SEM-DENSE | 768 | 83.3 | 89.9 | 93.5 | 0.862 |
| jina-v5-nano-q8 | 768 | 76.8 | 91.3 | 95.7 | 0.837 |
| bge-m3-q8 | 1024 | 76.8 | 92.8 | 94.2 | 0.836 |
| gemma2-q8 | 768 | 76.8 | 87.7 | 92.0 | 0.818 |
| gemma2-fp16 | 768 | 76.8 | 87.7 | 91.3 | 0.817 |
| harrier0.6b-q4 | 1024 | 76.8 | 87.0 | 92.8 | 0.814 |
| arctic-l-v2-q8 | 1024 | 73.9 | 90.6 | 92.8 | 0.810 |
| gemma2-q4 | 768 | 74.6 | 87.7 | 92.0 | 0.802 |
| gemma2-q4f16 | 768 | 73.9 | 87.7 | 92.0 | 0.798 |
| arctic-m-v2-q8 | 768 | 72.5 | 88.4 | 92.8 | 0.795 |
| nomic-v2-moe-q8 | 768 | 73.9 | 86.2 | 89.1 | 0.794 |
| qwen3-0.6b-q4f16 | 1024 | 74.6 | 84.1 | 87.7 | 0.789 |
| pplx-0.6b-q4 | 1024 | 71.0 | 87.0 | 89.9 | 0.782 |
| gte-mbase-q8 | 768 | 70.3 | 87.0 | 91.3 | 0.774 |
| granite311m-r2-q8 | 768 | 69.6 | 87.7 | 91.3 | 0.767 |
| e5-base-q8 | 768 | 71.7 | 85.5 | 87.7 | 0.763 |
| harrier270m-q8 | 640 | 68.1 | 84.8 | 88.4 | 0.751 |
| harrier270m-q4 | 640 | 67.4 | 83.3 | 86.2 | 0.739 |
| e5-small-fp32 | 384 | 62.3 | 79.7 | 85.5 | 0.703 |
| e5-small-q8 | 384 | 61.6 | 79.7 | 84.8 | 0.693 |
| granite97m-r2-fp32 | 384 | 59.4 | 79.0 | 85.5 | 0.682 |
| qwen3-0.6b-q8 | 1024 | 56.5 | 75.4 | 76.8 | 0.635 |
| minilm-l12-q8 | 384 | 51.4 | 71.7 | 75.4 | 0.606 |
| granite97m-r2-q8 | 384 | 50.7 | 76.1 | 81.2 | 0.606 |

### Híbrido vetor + BM25 (texto+título, OR+prefixo; top-30 de cada lista) — MRR@10

BM25 sozinho: R@1 52.9 · R@5 58.7 · MRR 0.553

| modelo | vetor | RRF k=60 | RRF prof.100 | RRF 2:1 | conv mm .5 | conv mm .7 | RRF×cob | RRF porta .5 | conv cob .3 | conv cob .4 | conv cob .5 | conv cob .6 | conv cob .7 | R@1 vetor | R@1 RRF | R@1 conv cob .5 | R@5 vetor | R@5 RRF | R@5 conv cob .5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gemma300m-q8 | 0.871 | 0.704 | 0.682 | 0.714 | 0.774 | 0.852 | 0.731 | 0.860 | 0.822 | 0.844 | 0.868 | 0.874 | 0.874 | 83.3 | 63.0 | 83.3 | 92.8 | 80.4 | 92.8 |
| gemma300m-q4 | 0.872 | 0.708 | 0.686 | 0.718 | 0.781 | 0.859 | 0.742 | 0.862 | 0.827 | 0.841 | 0.857 | 0.868 | 0.870 | 84.1 | 63.0 | 81.2 | 92.0 | 80.4 | 90.6 |
| gemma300m-q4f16 | 0.864 | 0.706 | 0.685 | 0.717 | 0.770 | 0.853 | 0.739 | 0.854 | 0.824 | 0.838 | 0.856 | 0.865 | 0.867 | 82.6 | 63.0 | 81.2 | 92.0 | 81.2 | 92.8 |
| gemma300m-fp16 | 0.862 | 0.701 | 0.682 | 0.713 | 0.759 | 0.846 | 0.737 | 0.850 | 0.821 | 0.839 | 0.852 | 0.863 | 0.863 | 81.9 | 63.0 | 80.4 | 92.8 | 80.4 | 92.0 |
| gemma300m-q8-SEM-DENSE | 0.862 | 0.709 | 0.691 | 0.720 | 0.755 | 0.829 | 0.749 | 0.850 | 0.811 | 0.835 | 0.848 | 0.860 | 0.859 | 83.3 | 64.5 | 80.4 | 89.9 | 80.4 | 89.9 |
| bge-m3-q8 | 0.836 | 0.695 | 0.677 | 0.708 | 0.747 | 0.820 | 0.736 | 0.825 | 0.805 | 0.820 | 0.829 | 0.830 | 0.830 | 76.8 | 60.9 | 75.4 | 92.8 | 80.4 | 93.5 |
| jina-v5-nano-q8 | 0.837 | 0.691 | 0.671 | 0.696 | 0.750 | 0.810 | 0.723 | 0.829 | 0.791 | 0.815 | 0.824 | 0.832 | 0.831 | 76.8 | 60.9 | 75.4 | 91.3 | 81.2 | 91.3 |
| arctic-l-v2-q8 | 0.810 | 0.696 | 0.674 | 0.708 | 0.731 | 0.803 | 0.722 | 0.811 | 0.789 | 0.804 | 0.813 | 0.817 | 0.816 | 73.9 | 61.6 | 74.6 | 90.6 | 81.9 | 90.6 |
| harrier0.6b-q4 | 0.814 | 0.685 | 0.664 | 0.698 | 0.732 | 0.808 | 0.719 | 0.799 | 0.773 | 0.798 | 0.804 | 0.805 | 0.810 | 76.8 | 60.9 | 75.4 | 87.0 | 79.0 | 86.2 |
| gemma2-q8 | 0.818 | 0.701 | 0.685 | 0.703 | 0.749 | 0.804 | 0.740 | 0.807 | 0.770 | 0.793 | 0.803 | 0.814 | 0.814 | 76.8 | 63.8 | 74.6 | 87.7 | 79.7 | 87.0 |
| gemma2-fp16 | 0.817 | 0.700 | 0.684 | 0.702 | 0.748 | 0.804 | 0.740 | 0.806 | 0.773 | 0.792 | 0.802 | 0.814 | 0.814 | 76.8 | 63.8 | 74.6 | 87.7 | 79.7 | 87.0 |
| pplx-0.6b-q4 | 0.782 | 0.674 | 0.663 | 0.676 | 0.699 | 0.765 | 0.704 | 0.802 | 0.775 | 0.796 | 0.801 | 0.787 | 0.790 | 71.0 | 59.4 | 72.5 | 87.0 | 79.0 | 90.6 |
| gemma2-q4 | 0.802 | 0.688 | 0.676 | 0.692 | 0.734 | 0.794 | 0.727 | 0.795 | 0.757 | 0.781 | 0.791 | 0.802 | 0.806 | 74.6 | 63.0 | 73.2 | 87.7 | 76.8 | 87.0 |
| gte-mbase-q8 | 0.774 | 0.696 | 0.677 | 0.703 | 0.728 | 0.768 | 0.719 | 0.780 | 0.767 | 0.787 | 0.791 | 0.793 | 0.797 | 70.3 | 63.8 | 73.2 | 87.0 | 78.3 | 86.2 |
| qwen3-0.6b-q4f16 | 0.789 | 0.684 | 0.662 | 0.684 | 0.713 | 0.781 | 0.710 | 0.792 | 0.768 | 0.773 | 0.790 | 0.792 | 0.788 | 74.6 | 61.6 | 74.6 | 84.1 | 78.3 | 84.1 |
| gemma2-q4f16 | 0.798 | 0.687 | 0.676 | 0.692 | 0.734 | 0.793 | 0.725 | 0.791 | 0.753 | 0.781 | 0.788 | 0.798 | 0.802 | 73.9 | 63.0 | 72.5 | 87.7 | 76.8 | 87.0 |
| arctic-m-v2-q8 | 0.795 | 0.685 | 0.668 | 0.694 | 0.723 | 0.784 | 0.731 | 0.796 | 0.765 | 0.775 | 0.784 | 0.791 | 0.799 | 72.5 | 60.1 | 70.3 | 88.4 | 76.8 | 87.7 |
| nomic-v2-moe-q8 | 0.794 | 0.675 | 0.662 | 0.685 | 0.709 | 0.772 | 0.697 | 0.780 | 0.742 | 0.758 | 0.773 | 0.786 | 0.794 | 73.9 | 60.9 | 70.3 | 86.2 | 76.1 | 86.2 |
| granite311m-r2-q8 | 0.767 | 0.668 | 0.653 | 0.671 | 0.714 | 0.757 | 0.697 | 0.782 | 0.760 | 0.775 | 0.770 | 0.780 | 0.779 | 69.6 | 58.0 | 68.8 | 87.7 | 78.3 | 88.4 |
| e5-base-q8 | 0.763 | 0.679 | 0.661 | 0.687 | 0.701 | 0.760 | 0.712 | 0.768 | 0.748 | 0.757 | 0.767 | 0.767 | 0.768 | 71.7 | 61.6 | 71.7 | 85.5 | 75.4 | 85.5 |
| harrier270m-q8 | 0.751 | 0.684 | 0.659 | 0.690 | 0.705 | 0.749 | 0.704 | 0.762 | 0.738 | 0.751 | 0.761 | 0.760 | 0.765 | 68.1 | 62.3 | 71.0 | 84.8 | 76.8 | 82.6 |
| harrier270m-q4 | 0.739 | 0.675 | 0.648 | 0.686 | 0.702 | 0.741 | 0.703 | 0.752 | 0.741 | 0.752 | 0.750 | 0.754 | 0.758 | 67.4 | 60.1 | 68.8 | 83.3 | 76.8 | 83.3 |
| granite97m-r2-fp32 | 0.682 | 0.656 | 0.648 | 0.657 | 0.649 | 0.678 | 0.678 | 0.741 | 0.731 | 0.744 | 0.740 | 0.727 | 0.716 | 59.4 | 58.7 | 67.4 | 79.0 | 76.1 | 83.3 |
| e5-small-fp32 | 0.703 | 0.657 | 0.647 | 0.663 | 0.665 | 0.708 | 0.676 | 0.716 | 0.699 | 0.710 | 0.712 | 0.713 | 0.712 | 62.3 | 59.4 | 63.8 | 79.7 | 70.3 | 80.4 |
| minilm-l12-q8 | 0.606 | 0.639 | 0.628 | 0.616 | 0.619 | 0.633 | 0.661 | 0.705 | 0.705 | 0.717 | 0.707 | 0.684 | 0.665 | 51.4 | 55.1 | 63.0 | 71.7 | 76.8 | 79.7 |
| e5-small-q8 | 0.693 | 0.645 | 0.636 | 0.652 | 0.650 | 0.703 | 0.665 | 0.706 | 0.685 | 0.695 | 0.699 | 0.706 | 0.699 | 61.6 | 58.0 | 62.3 | 79.7 | 71.0 | 80.4 |
| granite97m-r2-q8 | 0.606 | 0.628 | 0.619 | 0.637 | 0.594 | 0.625 | 0.650 | 0.697 | 0.694 | 0.707 | 0.699 | 0.686 | 0.667 | 50.7 | 55.8 | 63.8 | 76.1 | 73.2 | 79.7 |
| qwen3-0.6b-q8 | 0.635 | 0.614 | 0.605 | 0.617 | 0.613 | 0.640 | 0.624 | 0.657 | 0.642 | 0.652 | 0.650 | 0.656 | 0.651 | 56.5 | 55.1 | 58.7 | 75.4 | 68.8 | 73.9 |

### R@1 por tipo de pergunta (P = paráfrase, E = termo exato, V = vaga, C = vaga que depende do título)

BM25 (texto+título, OR+prefixo): P 0.0 · E 95.0 · V 73.7 · C 58.3

| modelo | vetor P | vetor E | vetor V | vetor C | RRF P | RRF E | RRF V | RRF C | conv cob .5 P | conv cob .5 E | conv cob .5 V | conv cob .5 C |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| e5-small-q8 | 16.7 | 95.0 | 78.9 | 75.0 | 2.1 | 100.0 | 81.6 | 66.7 | 14.6 | 97.5 | 81.6 | 75.0 |
| e5-small-fp32 | 18.8 | 95.0 | 78.9 | 75.0 | 6.3 | 100.0 | 78.9 | 75.0 | 18.8 | 100.0 | 78.9 | 75.0 |
| e5-base-q8 | 39.6 | 100.0 | 84.2 | 66.7 | 12.5 | 100.0 | 81.6 | 66.7 | 39.6 | 100.0 | 84.2 | 66.7 |
| minilm-l12-q8 | 31.3 | 72.5 | 55.3 | 50.0 | 8.3 | 95.0 | 71.1 | 58.3 | 27.1 | 97.5 | 68.4 | 75.0 |
| bge-m3-q8 | 47.9 | 95.0 | 89.5 | 91.7 | 10.4 | 97.5 | 81.6 | 75.0 | 47.9 | 97.5 | 84.2 | 83.3 |
| gemma300m-q8 | 64.6 | 97.5 | 92.1 | 83.3 | 14.6 | 100.0 | 84.2 | 66.7 | 64.6 | 100.0 | 92.1 | 75.0 |
| gemma300m-q4 | 66.7 | 97.5 | 94.7 | 75.0 | 14.6 | 100.0 | 84.2 | 66.7 | 58.3 | 100.0 | 92.1 | 75.0 |
| gemma300m-q4f16 | 62.5 | 97.5 | 94.7 | 75.0 | 14.6 | 100.0 | 84.2 | 66.7 | 58.3 | 100.0 | 92.1 | 75.0 |
| gemma300m-fp16 | 60.4 | 97.5 | 92.1 | 83.3 | 14.6 | 100.0 | 84.2 | 66.7 | 56.3 | 100.0 | 92.1 | 75.0 |
| gemma300m-q8-SEM-DENSE | 60.4 | 97.5 | 94.7 | 91.7 | 14.6 | 100.0 | 86.8 | 75.0 | 56.3 | 100.0 | 92.1 | 75.0 |
| gemma2-q8 | 41.7 | 97.5 | 97.4 | 83.3 | 10.4 | 100.0 | 89.5 | 75.0 | 39.6 | 100.0 | 92.1 | 75.0 |
| gemma2-q4 | 39.6 | 97.5 | 92.1 | 83.3 | 10.4 | 100.0 | 86.8 | 75.0 | 37.5 | 100.0 | 89.5 | 75.0 |
| gemma2-q4f16 | 37.5 | 97.5 | 92.1 | 83.3 | 10.4 | 100.0 | 86.8 | 75.0 | 35.4 | 100.0 | 89.5 | 75.0 |
| gemma2-fp16 | 41.7 | 97.5 | 97.4 | 83.3 | 10.4 | 100.0 | 89.5 | 75.0 | 39.6 | 100.0 | 92.1 | 75.0 |
| granite97m-r2-q8 | 22.9 | 85.0 | 50.0 | 50.0 | 4.2 | 97.5 | 76.3 | 58.3 | 20.8 | 100.0 | 78.9 | 66.7 |
| granite97m-r2-fp32 | 33.3 | 92.5 | 55.3 | 66.7 | 8.3 | 100.0 | 73.7 | 75.0 | 31.3 | 100.0 | 78.9 | 66.7 |
| granite311m-r2-q8 | 39.6 | 95.0 | 81.6 | 66.7 | 8.3 | 95.0 | 78.9 | 66.7 | 33.3 | 95.0 | 86.8 | 66.7 |
| harrier270m-q8 | 37.5 | 95.0 | 78.9 | 66.7 | 12.5 | 97.5 | 84.2 | 75.0 | 35.4 | 97.5 | 84.2 | 83.3 |
| harrier270m-q4 | 37.5 | 95.0 | 73.7 | 75.0 | 12.5 | 97.5 | 78.9 | 66.7 | 33.3 | 97.5 | 81.6 | 75.0 |
| harrier0.6b-q4 | 47.9 | 97.5 | 86.8 | 91.7 | 12.5 | 97.5 | 81.6 | 66.7 | 43.8 | 97.5 | 89.5 | 83.3 |
| qwen3-0.6b-q4f16 | 45.8 | 95.0 | 92.1 | 66.7 | 10.4 | 95.0 | 86.8 | 75.0 | 43.8 | 97.5 | 92.1 | 66.7 |
| qwen3-0.6b-q8 | 8.3 | 92.5 | 84.2 | 41.7 | 0.0 | 97.5 | 78.9 | 58.3 | 8.3 | 97.5 | 81.6 | 58.3 |
| arctic-m-v2-q8 | 41.7 | 95.0 | 89.5 | 66.7 | 6.3 | 100.0 | 84.2 | 66.7 | 33.3 | 100.0 | 86.8 | 66.7 |
| arctic-l-v2-q8 | 39.6 | 92.5 | 92.1 | 91.7 | 6.3 | 100.0 | 86.8 | 75.0 | 39.6 | 100.0 | 86.8 | 91.7 |
| gte-mbase-q8 | 39.6 | 97.5 | 81.6 | 66.7 | 12.5 | 100.0 | 86.8 | 75.0 | 39.6 | 100.0 | 84.2 | 83.3 |
| nomic-v2-moe-q8 | 37.5 | 95.0 | 92.1 | 91.7 | 8.3 | 97.5 | 84.2 | 75.0 | 31.3 | 97.5 | 86.8 | 83.3 |
| pplx-0.6b-q4 | 45.8 | 92.5 | 76.3 | 83.3 | 6.3 | 97.5 | 81.6 | 75.0 | 41.7 | 97.5 | 84.2 | 75.0 |
| jina-v5-nano-q8 | 54.2 | 95.0 | 92.1 | 58.3 | 12.5 | 97.5 | 81.6 | 66.7 | 52.1 | 97.5 | 86.8 | 58.3 |

### Contexto barato: trecho puro vs. prefixado com `Título › Seção` (híbrido = conv cob .5)

| modelo | R@1 puro | R@1 ctx | MRR puro | MRR ctx | R@1 (12 perg. ctx) puro | R@1 (12 perg. ctx) ctx | MRR híbrido puro | MRR híbrido ctx | R@1 híbrido puro | R@1 híbrido ctx |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| e5-small-q8 | 55.1 | 61.6 | 0.608 | 0.693 | 16.7 | 75.0 | 0.629 | 0.699 | 58.7 | 62.3 |
| e5-small-fp32 | 57.2 | 62.3 | 0.623 | 0.703 | 16.7 | 75.0 | 0.641 | 0.712 | 60.1 | 63.8 |
| e5-base-q8 | 62.3 | 71.7 | 0.701 | 0.763 | 16.7 | 66.7 | 0.719 | 0.767 | 65.2 | 71.7 |
| minilm-l12-q8 | 52.9 | 51.4 | 0.619 | 0.606 | 25.0 | 50.0 | 0.691 | 0.707 | 62.3 | 63.0 |
| bge-m3-q8 | 71.7 | 76.8 | 0.796 | 0.836 | 33.3 | 91.7 | 0.798 | 0.829 | 71.7 | 75.4 |
| gemma300m-q8 | 77.5 | 83.3 | 0.828 | 0.871 | 25.0 | 83.3 | 0.821 | 0.868 | 76.1 | 83.3 |
| gemma300m-q4 | 76.8 | 84.1 | 0.825 | 0.872 | 33.3 | 75.0 | 0.819 | 0.857 | 75.4 | 81.2 |
| gemma300m-q4f16 | 77.5 | 82.6 | 0.827 | 0.864 | 33.3 | 75.0 | 0.821 | 0.856 | 76.1 | 81.2 |
| gemma300m-fp16 | 76.1 | 81.9 | 0.821 | 0.862 | 16.7 | 83.3 | 0.826 | 0.852 | 76.8 | 80.4 |
| gemma300m-q8-SEM-DENSE | 76.1 | 83.3 | 0.820 | 0.862 | 25.0 | 91.7 | 0.814 | 0.848 | 75.4 | 80.4 |
| gemma2-q8 | 71.7 | 76.8 | 0.779 | 0.818 | 41.7 | 83.3 | 0.776 | 0.803 | 71.0 | 74.6 |
| gemma2-q4 | 71.7 | 74.6 | 0.778 | 0.802 | 33.3 | 83.3 | 0.770 | 0.791 | 70.3 | 73.2 |
| gemma2-q4f16 | 71.7 | 73.9 | 0.778 | 0.798 | 33.3 | 83.3 | 0.768 | 0.788 | 70.3 | 72.5 |
| gemma2-fp16 | 71.7 | 76.8 | 0.781 | 0.817 | 41.7 | 83.3 | 0.777 | 0.802 | 71.0 | 74.6 |
| granite97m-r2-q8 | 43.5 | 50.7 | 0.519 | 0.606 | 16.7 | 50.0 | 0.639 | 0.699 | 58.0 | 63.8 |
| granite97m-r2-fp32 | 53.6 | 59.4 | 0.626 | 0.682 | 8.3 | 66.7 | 0.713 | 0.740 | 63.8 | 67.4 |
| granite311m-r2-q8 | 60.9 | 69.6 | 0.706 | 0.767 | 16.7 | 66.7 | 0.738 | 0.770 | 63.8 | 68.8 |
| harrier270m-q8 | 60.9 | 68.1 | 0.681 | 0.751 | 25.0 | 66.7 | 0.687 | 0.761 | 61.6 | 71.0 |
| harrier270m-q4 | 58.7 | 67.4 | 0.672 | 0.739 | 16.7 | 75.0 | 0.689 | 0.750 | 61.6 | 68.8 |
| harrier0.6b-q4 | 64.5 | 76.8 | 0.730 | 0.814 | 16.7 | 91.7 | 0.738 | 0.804 | 66.7 | 75.4 |
| qwen3-0.6b-q4f16 | 70.3 | 74.6 | 0.757 | 0.789 | 25.0 | 66.7 | 0.756 | 0.790 | 69.6 | 74.6 |
| qwen3-0.6b-q8 | 57.2 | 56.5 | 0.623 | 0.635 | 16.7 | 41.7 | 0.643 | 0.650 | 58.7 | 58.7 |
| arctic-m-v2-q8 | 68.1 | 72.5 | 0.767 | 0.795 | 33.3 | 66.7 | 0.763 | 0.784 | 67.4 | 70.3 |
| arctic-l-v2-q8 | 73.9 | 73.9 | 0.815 | 0.810 | 58.3 | 91.7 | 0.812 | 0.813 | 72.5 | 74.6 |
| gte-mbase-q8 | 65.2 | 70.3 | 0.720 | 0.774 | 25.0 | 66.7 | 0.748 | 0.791 | 68.8 | 73.2 |
| nomic-v2-moe-q8 | 67.4 | 73.9 | 0.743 | 0.794 | 41.7 | 91.7 | 0.731 | 0.773 | 65.9 | 70.3 |
| pplx-0.6b-q4 | 65.2 | 71.0 | 0.739 | 0.782 | 41.7 | 83.3 | 0.779 | 0.801 | 70.3 | 72.5 |
| jina-v5-nano-q8 | 73.9 | 76.8 | 0.812 | 0.837 | 33.3 | 58.3 | 0.801 | 0.824 | 73.2 | 75.4 |

### Diferença pareada de MRR do híbrido (conv cob .5) contra o melhor (gemma300m-q8), IC 95% por bootstrap

| modelo | Δ MRR | IC 95% | leitura |
|---|---:|---:|---:|
| gemma300m-q4 | -0.011 | [-0.029, 0.006] | indistinguível |
| gemma300m-q4f16 | -0.012 | [-0.030, 0.006] | indistinguível |
| gemma300m-fp16 | -0.016 | [-0.033, -0.002] | pior (significativo) |
| gemma300m-q8-SEM-DENSE | -0.019 | [-0.043, 0.001] | indistinguível |
| bge-m3-q8 | -0.039 | [-0.079, 0.002] | indistinguível |
| jina-v5-nano-q8 | -0.044 | [-0.076, -0.015] | pior (significativo) |
| arctic-l-v2-q8 | -0.055 | [-0.098, -0.017] | pior (significativo) |
| harrier0.6b-q4 | -0.064 | [-0.108, -0.024] | pior (significativo) |
| gemma2-q8 | -0.065 | [-0.106, -0.030] | pior (significativo) |
| gemma2-fp16 | -0.066 | [-0.107, -0.030] | pior (significativo) |
| pplx-0.6b-q4 | -0.067 | [-0.113, -0.023] | pior (significativo) |
| gemma2-q4 | -0.076 | [-0.117, -0.039] | pior (significativo) |
| gte-mbase-q8 | -0.077 | [-0.118, -0.037] | pior (significativo) |
| qwen3-0.6b-q4f16 | -0.078 | [-0.119, -0.042] | pior (significativo) |
| gemma2-q4f16 | -0.080 | [-0.123, -0.042] | pior (significativo) |
| arctic-m-v2-q8 | -0.084 | [-0.121, -0.050] | pior (significativo) |
| nomic-v2-moe-q8 | -0.095 | [-0.143, -0.051] | pior (significativo) |
| granite311m-r2-q8 | -0.098 | [-0.145, -0.056] | pior (significativo) |
| e5-base-q8 | -0.101 | [-0.149, -0.059] | pior (significativo) |
| harrier270m-q8 | -0.107 | [-0.156, -0.061] | pior (significativo) |
| harrier270m-q4 | -0.117 | [-0.167, -0.072] | pior (significativo) |
| granite97m-r2-fp32 | -0.128 | [-0.179, -0.078] | pior (significativo) |
| e5-small-fp32 | -0.156 | [-0.209, -0.107] | pior (significativo) |
| minilm-l12-q8 | -0.161 | [-0.214, -0.109] | pior (significativo) |
| granite97m-r2-q8 | -0.168 | [-0.224, -0.116] | pior (significativo) |
| e5-small-q8 | -0.169 | [-0.224, -0.120] | pior (significativo) |
| qwen3-0.6b-q8 | -0.217 | [-0.281, -0.159] | pior (significativo) |

### Formato de armazenamento do vetor (busca vetorial pura; MRR@10 e R@1)

| modelo | dims | float32 | float16 | int8 (escala por vetor) | int8 ingênuo (x·127) | binário Hamming | binário, pergunta float | binário top-50 → rescoring int8 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| e5-small-q8 | 384 | 0.693 / 61.6 | 0.693 / 61.6 | 0.690 / 60.9 | 0.692 / 61.6 | 0.153 / 10.9 | 0.189 / 12.3 | 0.539 / 48.6 |
| e5-small-fp32 | 384 | 0.703 / 62.3 | 0.703 / 62.3 | 0.703 / 62.3 | 0.693 / 60.9 | 0.115 / 5.8 | 0.168 / 9.4 | 0.533 / 50.0 |
| e5-base-q8 | 768 | 0.763 / 71.7 | 0.763 / 71.7 | 0.764 / 71.7 | 0.756 / 70.3 | 0.327 / 23.9 | 0.450 / 33.3 | 0.725 / 68.8 |
| minilm-l12-q8 | 384 | 0.606 / 51.4 | 0.606 / 51.4 | 0.606 / 51.4 | 0.603 / 50.7 | 0.574 / 47.8 | 0.610 / 52.9 | 0.606 / 51.4 |
| bge-m3-q8 | 1024 | 0.836 / 76.8 | 0.836 / 76.8 | 0.836 / 76.8 | 0.844 / 78.3 | 0.785 / 72.5 | 0.817 / 73.9 | 0.837 / 76.8 |
| gemma300m-q8 | 768 | 0.871 / 83.3 | 0.871 / 83.3 | 0.871 / 83.3 | 0.862 / 81.9 | 0.832 / 78.3 | 0.855 / 81.2 | 0.871 / 83.3 |
| gemma300m-q4 | 768 | 0.872 / 84.1 | 0.872 / 84.1 | 0.872 / 84.1 | 0.873 / 84.1 | 0.814 / 75.4 | 0.847 / 79.7 | 0.872 / 84.1 |
| gemma300m-q4f16 | 768 | 0.864 / 82.6 | 0.864 / 82.6 | 0.864 / 82.6 | 0.863 / 82.6 | 0.810 / 75.4 | 0.856 / 81.9 | 0.864 / 82.6 |
| gemma300m-fp16 | 768 | 0.862 / 81.9 | 0.862 / 81.9 | 0.862 / 81.9 | 0.862 / 81.9 | 0.821 / 76.1 | 0.844 / 77.5 | 0.862 / 81.9 |
| gemma2-q8 | 768 | 0.818 / 76.8 | 0.818 / 76.8 | 0.818 / 76.8 | 0.814 / 76.1 | 0.765 / 71.0 | 0.772 / 71.0 | 0.818 / 76.8 |
| gemma2-q4 | 768 | 0.802 / 74.6 | 0.802 / 74.6 | 0.798 / 73.9 | 0.793 / 72.5 | 0.783 / 73.2 | 0.797 / 74.6 | 0.791 / 73.2 |
| gemma2-q4f16 | 768 | 0.798 / 73.9 | 0.798 / 73.9 | 0.798 / 73.9 | 0.791 / 72.5 | 0.781 / 73.2 | 0.789 / 73.2 | 0.791 / 73.2 |
| gemma2-fp16 | 768 | 0.817 / 76.8 | 0.817 / 76.8 | 0.817 / 76.8 | 0.816 / 76.8 | 0.761 / 69.6 | 0.777 / 72.5 | 0.818 / 76.8 |
| granite97m-r2-q8 | 384 | 0.606 / 50.7 | 0.609 / 51.4 | 0.611 / 51.4 | 0.603 / 50.0 | 0.524 / 42.0 | 0.586 / 52.2 | 0.612 / 51.4 |
| granite97m-r2-fp32 | 384 | 0.682 / 59.4 | 0.682 / 59.4 | 0.673 / 58.0 | 0.671 / 58.0 | 0.594 / 50.7 | 0.632 / 53.6 | 0.669 / 58.0 |
| granite311m-r2-q8 | 768 | 0.767 / 69.6 | 0.767 / 69.6 | 0.767 / 69.6 | 0.769 / 70.3 | 0.729 / 64.5 | 0.733 / 63.8 | 0.767 / 69.6 |
| harrier270m-q8 | 640 | 0.751 / 68.1 | 0.751 / 68.1 | 0.750 / 68.1 | 0.749 / 67.4 | 0.623 / 54.3 | 0.670 / 59.4 | 0.744 / 68.1 |
| harrier270m-q4 | 640 | 0.739 / 67.4 | 0.738 / 67.4 | 0.734 / 65.9 | 0.741 / 67.4 | 0.600 / 53.6 | 0.649 / 55.8 | 0.731 / 65.9 |
| harrier0.6b-q4 | 1024 | 0.814 / 76.8 | 0.814 / 76.8 | 0.815 / 76.8 | 0.815 / 76.8 | 0.717 / 63.8 | 0.762 / 68.8 | 0.812 / 76.8 |
| qwen3-0.6b-q4f16 | 1024 | 0.789 / 74.6 | 0.789 / 74.6 | 0.789 / 74.6 | 0.782 / 73.9 | 0.759 / 71.7 | 0.757 / 71.0 | 0.788 / 74.6 |
| qwen3-0.6b-q8 | 1024 | 0.635 / 56.5 | 0.635 / 56.5 | 0.635 / 56.5 | 0.634 / 55.8 | 0.586 / 51.4 | 0.616 / 55.8 | 0.635 / 56.5 |
| arctic-m-v2-q8 | 768 | 0.795 / 72.5 | 0.795 / 72.5 | 0.795 / 72.5 | 0.794 / 72.5 | 0.773 / 72.5 | 0.784 / 71.7 | 0.795 / 72.5 |
| arctic-l-v2-q8 | 1024 | 0.810 / 73.9 | 0.810 / 73.9 | 0.811 / 73.9 | 0.809 / 73.9 | 0.760 / 68.1 | 0.798 / 73.9 | 0.811 / 73.9 |
| gte-mbase-q8 | 768 | 0.774 / 70.3 | 0.774 / 70.3 | 0.775 / 70.3 | 0.767 / 68.8 | 0.685 / 58.7 | 0.760 / 68.1 | 0.776 / 70.3 |
| nomic-v2-moe-q8 | 768 | 0.794 / 73.9 | 0.794 / 73.9 | 0.794 / 73.9 | 0.795 / 73.9 | 0.714 / 62.3 | 0.764 / 69.6 | 0.795 / 73.9 |
| pplx-0.6b-q4 | 1024 | 0.782 / 71.0 | 0.782 / 71.0 | 0.782 / 71.0 | 0.778 / 71.0 | 0.700 / 60.9 | 0.750 / 66.7 | 0.786 / 71.7 |
| jina-v5-nano-q8 | 768 | 0.837 / 76.8 | 0.837 / 76.8 | 0.838 / 76.8 | 0.836 / 76.8 | 0.810 / 73.9 | 0.849 / 79.0 | 0.838 / 76.8 |

### Truncamento (MRR@10; `*` = dimensão NÃO declarada como Matryoshka pelo modelo)

| modelo | dimensão cheia | truncado |
|---|---:|---:|
| e5-small-q8 | 384d: 0.693 → int8 0.690 (384 B) | 256d*: 0.645 → int8 0.648 (256 B) · 128d*: 0.538 → int8 0.537 (128 B) |
| e5-small-fp32 | 384d: 0.703 → int8 0.703 (384 B) | 256d*: 0.661 → int8 0.661 (256 B) · 128d*: 0.573 → int8 0.568 (128 B) |
| e5-base-q8 | 768d: 0.763 → int8 0.764 (768 B) | 256d*: 0.666 → int8 0.667 (256 B) · 128d*: 0.577 → int8 0.576 (128 B) |
| minilm-l12-q8 | 384d: 0.606 → int8 0.606 (384 B) | 256d*: 0.586 → int8 0.586 (256 B) · 128d*: 0.495 → int8 0.495 (128 B) |
| bge-m3-q8 | 1024d: 0.836 → int8 0.836 (1024 B) | 256d*: 0.741 → int8 0.741 (256 B) · 128d*: 0.641 → int8 0.641 (128 B) |
| gemma300m-q8 | 768d: 0.871 → int8 0.871 (768 B) | 512d: 0.850 → int8 0.850 (512 B) · 256d: 0.838 → int8 0.845 (256 B) · 128d: 0.790 → int8 0.790 (128 B) |
| gemma300m-q4 | 768d: 0.872 → int8 0.872 (768 B) | 512d: 0.847 → int8 0.847 (512 B) · 256d: 0.828 → int8 0.828 (256 B) · 128d: 0.793 → int8 0.793 (128 B) |
| gemma300m-q4f16 | 768d: 0.864 → int8 0.864 (768 B) | 512d: 0.848 → int8 0.847 (512 B) · 256d: 0.822 → int8 0.822 (256 B) · 128d: 0.792 → int8 0.792 (128 B) |
| gemma300m-fp16 | 768d: 0.862 → int8 0.862 (768 B) | 512d: 0.850 → int8 0.850 (512 B) · 256d: 0.849 → int8 0.851 (256 B) · 128d: 0.793 → int8 0.797 (128 B) |
| gemma2-q8 | 768d: 0.818 → int8 0.818 (768 B) | 512d: 0.809 → int8 0.810 (512 B) · 256d: 0.782 → int8 0.777 (256 B) · 128d: 0.712 → int8 0.708 (128 B) |
| gemma2-q4 | 768d: 0.802 → int8 0.798 (768 B) | 512d: 0.805 → int8 0.806 (512 B) · 256d: 0.779 → int8 0.779 (256 B) · 128d: 0.698 → int8 0.698 (128 B) |
| gemma2-q4f16 | 768d: 0.798 → int8 0.798 (768 B) | 512d: 0.802 → int8 0.806 (512 B) · 256d: 0.779 → int8 0.775 (256 B) · 128d: 0.697 → int8 0.697 (128 B) |
| gemma2-fp16 | 768d: 0.817 → int8 0.817 (768 B) | 512d: 0.809 → int8 0.809 (512 B) · 256d: 0.782 → int8 0.778 (256 B) · 128d: 0.712 → int8 0.712 (128 B) |
| granite97m-r2-q8 | 384d: 0.606 → int8 0.611 (384 B) | 256d*: 0.575 → int8 0.574 (256 B) · 128d*: 0.506 → int8 0.506 (128 B) |
| granite97m-r2-fp32 | 384d: 0.682 → int8 0.673 (384 B) | 256d*: 0.647 → int8 0.651 (256 B) · 128d*: 0.571 → int8 0.571 (128 B) |
| granite311m-r2-q8 | 768d: 0.767 → int8 0.767 (768 B) | 512d: 0.759 → int8 0.763 (512 B) · 384d: 0.747 → int8 0.744 (384 B) · 256d: 0.754 → int8 0.751 (256 B) · 128d: 0.730 → int8 0.730 (128 B) |
| harrier270m-q8 | 640d: 0.751 → int8 0.750 (640 B) | 256d*: 0.672 → int8 0.667 (256 B) · 128d*: 0.530 → int8 0.531 (128 B) |
| harrier270m-q4 | 640d: 0.739 → int8 0.734 (640 B) | 256d*: 0.620 → int8 0.619 (256 B) · 128d*: 0.494 → int8 0.495 (128 B) |
| harrier0.6b-q4 | 1024d: 0.814 → int8 0.815 (1024 B) | 256d*: 0.590 → int8 0.590 (256 B) · 128d*: 0.407 → int8 0.409 (128 B) |
| qwen3-0.6b-q4f16 | 1024d: 0.789 → int8 0.789 (1024 B) | 512d: 0.786 → int8 0.789 (512 B) · 256d: 0.741 → int8 0.741 (256 B) · 128d: 0.682 → int8 0.683 (128 B) |
| qwen3-0.6b-q8 | 1024d: 0.635 → int8 0.635 (1024 B) | 512d: 0.594 → int8 0.595 (512 B) · 256d: 0.521 → int8 0.520 (256 B) · 128d: 0.443 → int8 0.444 (128 B) |
| arctic-m-v2-q8 | 768d: 0.795 → int8 0.795 (768 B) | 256d: 0.795 → int8 0.792 (256 B) · 128d*: 0.724 → int8 0.720 (128 B) |
| arctic-l-v2-q8 | 1024d: 0.810 → int8 0.811 (1024 B) | 256d: 0.802 → int8 0.802 (256 B) · 128d*: 0.756 → int8 0.756 (128 B) |
| gte-mbase-q8 | 768d: 0.774 → int8 0.775 (768 B) | 512d: 0.772 → int8 0.772 (512 B) · 256d: 0.737 → int8 0.736 (256 B) · 128d: 0.686 → int8 0.687 (128 B) |
| nomic-v2-moe-q8 | 768d: 0.794 → int8 0.794 (768 B) | 256d: 0.751 → int8 0.751 (256 B) · 128d*: 0.643 → int8 0.642 (128 B) |
| pplx-0.6b-q4 | 1024d: 0.782 → int8 0.782 (1024 B) | 256d*: 0.646 → int8 0.647 (256 B) · 128d*: 0.557 → int8 0.557 (128 B) |
| jina-v5-nano-q8 | 768d: 0.837 → int8 0.838 (768 B) | 512d: 0.823 → int8 0.823 (512 B) · 256d: 0.788 → int8 0.788 (256 B) · 128d: 0.767 → int8 0.767 (128 B) |


## Conjunto: Sintético + estresse de identificadores — 539 trechos, 198 perguntas

### BM25 (FTS5 `unicode61 remove_diacritics 2`)

| variante | R@1 | R@5 | R@10 | MRR@10 | R@1 P | R@1 E | R@1 V | R@1 C | R@1 I |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| texto, OR | 64.1 | 68.7 | 68.7 | 0.661 | 0.0 | 95.0 | 68.4 | 25.0 | 100.0 |
| texto, OR+prefixo | 65.7 | 69.2 | 69.2 | 0.673 | 0.0 | 95.0 | 71.1 | 41.7 | 100.0 |
| texto+título, OR | 66.2 | 69.2 | 70.7 | 0.677 | 0.0 | 95.0 | 71.1 | 50.0 | 100.0 |
| texto+título, OR+prefixo | 67.2 | 70.7 | 71.2 | 0.688 | 0.0 | 95.0 | 73.7 | 58.3 | 100.0 |

### Vetor sozinho (trecho embutido com prefixo `Título › Seção`)

| modelo | dims | R@1 | R@5 | R@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| gemma300m-q8 | 768 | 85.9 | 92.4 | 93.9 | 0.885 |
| gemma300m-q4 | 768 | 85.4 | 92.4 | 94.4 | 0.883 |
| gemma300m-q8-SEM-DENSE | 768 | 86.4 | 90.9 | 91.9 | 0.882 |
| gemma300m-q4f16 | 768 | 84.3 | 91.9 | 94.4 | 0.877 |
| gemma300m-fp16 | 768 | 84.8 | 92.4 | 93.4 | 0.877 |
| gemma2-fp16 | 768 | 81.3 | 89.4 | 90.9 | 0.848 |
| gemma2-q8 | 768 | 81.3 | 89.4 | 90.9 | 0.847 |
| gemma2-q4f16 | 768 | 78.8 | 87.9 | 89.9 | 0.825 |
| bge-m3-q8 | 1024 | 76.3 | 90.4 | 93.9 | 0.823 |
| gemma2-q4 | 768 | 78.3 | 87.9 | 89.9 | 0.823 |
| harrier0.6b-q4 | 1024 | 78.3 | 87.4 | 90.4 | 0.823 |
| jina-v5-nano-q8 | 768 | 77.8 | 89.4 | 93.4 | 0.823 |
| arctic-l-v2-q8 | 1024 | 76.8 | 88.4 | 90.4 | 0.815 |
| arctic-m-v2-q8 | 768 | 75.3 | 89.4 | 90.9 | 0.810 |
| pplx-0.6b-q4 | 1024 | 73.7 | 87.4 | 90.9 | 0.798 |
| nomic-v2-moe-q8 | 768 | 74.7 | 85.4 | 87.9 | 0.793 |
| e5-base-q8 | 768 | 72.2 | 83.8 | 87.4 | 0.772 |
| harrier270m-q8 | 640 | 70.2 | 83.8 | 87.9 | 0.766 |
| gte-mbase-q8 | 768 | 69.2 | 85.4 | 90.4 | 0.766 |
| harrier270m-q4 | 640 | 68.7 | 83.3 | 86.4 | 0.752 |
| e5-small-fp32 | 384 | 69.7 | 80.3 | 84.3 | 0.748 |
| qwen3-0.6b-q4f16 | 1024 | 67.7 | 81.3 | 86.4 | 0.734 |
| granite97m-r2-fp32 | 384 | 67.2 | 80.8 | 84.3 | 0.731 |
| granite311m-r2-q8 | 768 | 65.2 | 82.8 | 87.9 | 0.718 |
| e5-small-q8 | 384 | 63.6 | 78.8 | 83.3 | 0.704 |
| qwen3-0.6b-q8 | 1024 | 56.6 | 73.7 | 80.3 | 0.640 |
| granite97m-r2-q8 | 384 | 53.0 | 70.7 | 77.8 | 0.608 |
| minilm-l12-q8 | 384 | 36.9 | 52.0 | 60.1 | 0.436 |

### Híbrido vetor + BM25 (texto+título, OR+prefixo; top-30 de cada lista) — MRR@10

BM25 sozinho: R@1 67.2 · R@5 70.7 · MRR 0.688

| modelo | vetor | RRF k=60 | RRF prof.100 | RRF 2:1 | conv mm .5 | conv mm .7 | RRF×cob | RRF porta .5 | conv cob .3 | conv cob .4 | conv cob .5 | conv cob .6 | conv cob .7 | R@1 vetor | R@1 RRF | R@1 conv cob .5 | R@5 vetor | R@5 RRF | R@5 conv cob .5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gemma300m-q8 | 0.885 | 0.782 | 0.770 | 0.786 | 0.837 | 0.880 | 0.804 | 0.877 | 0.862 | 0.878 | 0.887 | 0.887 | 0.886 | 85.9 | 73.7 | 86.9 | 92.4 | 82.8 | 92.4 |
| gemma300m-q4 | 0.883 | 0.783 | 0.769 | 0.791 | 0.833 | 0.881 | 0.804 | 0.874 | 0.864 | 0.875 | 0.883 | 0.884 | 0.882 | 85.4 | 73.7 | 85.9 | 92.4 | 83.8 | 90.9 |
| gemma300m-fp16 | 0.877 | 0.777 | 0.767 | 0.781 | 0.834 | 0.873 | 0.802 | 0.868 | 0.860 | 0.874 | 0.880 | 0.880 | 0.878 | 84.8 | 73.2 | 85.9 | 92.4 | 83.3 | 91.4 |
| gemma300m-q4f16 | 0.877 | 0.778 | 0.767 | 0.787 | 0.834 | 0.877 | 0.804 | 0.869 | 0.860 | 0.872 | 0.878 | 0.881 | 0.879 | 84.3 | 73.2 | 84.8 | 91.9 | 84.3 | 91.4 |
| gemma300m-q8-SEM-DENSE | 0.882 | 0.788 | 0.773 | 0.792 | 0.828 | 0.873 | 0.812 | 0.872 | 0.860 | 0.863 | 0.874 | 0.878 | 0.878 | 86.4 | 74.7 | 85.4 | 90.9 | 84.8 | 90.4 |
| bge-m3-q8 | 0.823 | 0.777 | 0.757 | 0.783 | 0.818 | 0.843 | 0.808 | 0.842 | 0.841 | 0.850 | 0.852 | 0.846 | 0.843 | 76.3 | 72.2 | 80.8 | 90.4 | 84.8 | 90.9 |
| jina-v5-nano-q8 | 0.823 | 0.778 | 0.758 | 0.779 | 0.817 | 0.845 | 0.792 | 0.848 | 0.846 | 0.851 | 0.851 | 0.848 | 0.844 | 77.8 | 72.2 | 81.3 | 89.4 | 83.3 | 89.4 |
| harrier0.6b-q4 | 0.823 | 0.774 | 0.754 | 0.779 | 0.832 | 0.849 | 0.803 | 0.833 | 0.844 | 0.850 | 0.850 | 0.849 | 0.848 | 78.3 | 72.7 | 82.3 | 87.4 | 82.8 | 87.9 |
| gemma2-q8 | 0.847 | 0.781 | 0.768 | 0.786 | 0.806 | 0.839 | 0.804 | 0.840 | 0.825 | 0.833 | 0.847 | 0.845 | 0.847 | 81.3 | 74.2 | 81.3 | 89.4 | 83.8 | 89.4 |
| gemma2-fp16 | 0.848 | 0.781 | 0.768 | 0.786 | 0.806 | 0.839 | 0.803 | 0.841 | 0.825 | 0.833 | 0.847 | 0.845 | 0.848 | 81.3 | 74.2 | 81.3 | 89.4 | 83.8 | 89.4 |
| arctic-l-v2-q8 | 0.815 | 0.768 | 0.754 | 0.777 | 0.798 | 0.831 | 0.789 | 0.832 | 0.838 | 0.845 | 0.844 | 0.838 | 0.836 | 76.8 | 72.7 | 81.3 | 88.4 | 82.3 | 89.4 |
| pplx-0.6b-q4 | 0.798 | 0.757 | 0.749 | 0.752 | 0.773 | 0.810 | 0.773 | 0.826 | 0.833 | 0.842 | 0.834 | 0.827 | 0.821 | 73.7 | 70.7 | 78.3 | 87.4 | 82.8 | 89.9 |
| gemma2-q4 | 0.823 | 0.775 | 0.765 | 0.780 | 0.802 | 0.827 | 0.795 | 0.831 | 0.818 | 0.825 | 0.833 | 0.836 | 0.833 | 78.3 | 74.2 | 79.8 | 87.9 | 82.3 | 88.4 |
| gemma2-q4f16 | 0.825 | 0.775 | 0.764 | 0.780 | 0.802 | 0.826 | 0.795 | 0.831 | 0.815 | 0.824 | 0.832 | 0.833 | 0.833 | 78.8 | 74.2 | 79.8 | 87.9 | 82.3 | 88.4 |
| arctic-m-v2-q8 | 0.810 | 0.771 | 0.753 | 0.777 | 0.804 | 0.827 | 0.794 | 0.821 | 0.818 | 0.824 | 0.825 | 0.828 | 0.826 | 75.3 | 72.7 | 78.3 | 89.4 | 82.3 | 87.9 |
| gte-mbase-q8 | 0.766 | 0.767 | 0.753 | 0.770 | 0.799 | 0.805 | 0.781 | 0.811 | 0.818 | 0.827 | 0.824 | 0.814 | 0.808 | 69.2 | 73.2 | 78.3 | 85.4 | 80.8 | 86.9 |
| qwen3-0.6b-q4f16 | 0.734 | 0.752 | 0.736 | 0.745 | 0.802 | 0.810 | 0.766 | 0.802 | 0.819 | 0.825 | 0.822 | 0.811 | 0.786 | 67.7 | 70.2 | 79.3 | 81.3 | 82.3 | 86.4 |
| nomic-v2-moe-q8 | 0.793 | 0.757 | 0.748 | 0.761 | 0.780 | 0.800 | 0.771 | 0.810 | 0.801 | 0.819 | 0.819 | 0.817 | 0.814 | 74.7 | 71.2 | 77.8 | 85.4 | 80.8 | 87.4 |
| harrier270m-q8 | 0.766 | 0.761 | 0.752 | 0.761 | 0.790 | 0.797 | 0.775 | 0.801 | 0.811 | 0.813 | 0.814 | 0.807 | 0.808 | 70.2 | 72.2 | 77.8 | 83.8 | 80.8 | 85.9 |
| harrier270m-q4 | 0.752 | 0.764 | 0.755 | 0.766 | 0.784 | 0.800 | 0.775 | 0.801 | 0.812 | 0.813 | 0.807 | 0.808 | 0.804 | 68.7 | 72.7 | 76.8 | 83.3 | 80.3 | 85.4 |
| e5-base-q8 | 0.772 | 0.752 | 0.741 | 0.758 | 0.781 | 0.800 | 0.777 | 0.795 | 0.803 | 0.804 | 0.803 | 0.800 | 0.791 | 72.2 | 72.2 | 77.8 | 83.8 | 79.8 | 84.3 |
| granite311m-r2-q8 | 0.718 | 0.754 | 0.735 | 0.739 | 0.772 | 0.779 | 0.766 | 0.810 | 0.812 | 0.814 | 0.803 | 0.798 | 0.768 | 65.2 | 70.7 | 75.8 | 82.8 | 79.8 | 86.9 |
| granite97m-r2-fp32 | 0.731 | 0.757 | 0.737 | 0.748 | 0.738 | 0.756 | 0.763 | 0.791 | 0.795 | 0.797 | 0.786 | 0.773 | 0.756 | 67.2 | 71.7 | 74.2 | 80.8 | 82.3 | 84.8 |
| e5-small-fp32 | 0.748 | 0.734 | 0.733 | 0.739 | 0.753 | 0.761 | 0.747 | 0.763 | 0.769 | 0.775 | 0.771 | 0.767 | 0.762 | 69.7 | 69.7 | 73.2 | 80.3 | 78.3 | 80.8 |
| e5-small-q8 | 0.704 | 0.728 | 0.723 | 0.731 | 0.742 | 0.755 | 0.740 | 0.749 | 0.761 | 0.762 | 0.760 | 0.758 | 0.748 | 63.6 | 68.2 | 72.2 | 78.8 | 77.8 | 81.3 |
| granite97m-r2-q8 | 0.608 | 0.705 | 0.706 | 0.679 | 0.690 | 0.676 | 0.699 | 0.714 | 0.759 | 0.753 | 0.731 | 0.712 | 0.675 | 53.0 | 65.7 | 68.7 | 70.7 | 77.3 | 78.8 |
| qwen3-0.6b-q8 | 0.640 | 0.704 | 0.700 | 0.696 | 0.716 | 0.707 | 0.711 | 0.708 | 0.733 | 0.732 | 0.719 | 0.707 | 0.695 | 56.6 | 66.7 | 67.7 | 73.7 | 76.8 | 77.3 |
| minilm-l12-q8 | 0.436 | 0.592 | 0.591 | 0.545 | 0.657 | 0.528 | 0.591 | 0.598 | 0.756 | 0.725 | 0.635 | 0.572 | 0.520 | 36.9 | 50.5 | 53.5 | 52.0 | 72.2 | 77.3 |

### R@1 por tipo de pergunta (P = paráfrase, E = termo exato, V = vaga, C = vaga que depende do título, I = ID entre centenas de IDs vizinhos)

BM25 (texto+título, OR+prefixo): P 0.0 · E 95.0 · V 73.7 · C 58.3 · I 100.0

| modelo | vetor P | vetor E | vetor V | vetor C | vetor I | RRF P | RRF E | RRF V | RRF C | RRF I | conv cob .5 P | conv cob .5 E | conv cob .5 V | conv cob .5 C | conv cob .5 I |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| e5-small-q8 | 12.5 | 87.5 | 73.7 | 75.0 | 80.0 | 2.1 | 97.5 | 76.3 | 66.7 | 96.7 | 12.5 | 95.0 | 78.9 | 75.0 | 100.0 |
| e5-small-fp32 | 18.8 | 90.0 | 71.1 | 75.0 | 95.0 | 6.3 | 95.0 | 73.7 | 75.0 | 100.0 | 18.8 | 95.0 | 76.3 | 75.0 | 100.0 |
| e5-base-q8 | 35.4 | 97.5 | 76.3 | 66.7 | 83.3 | 16.7 | 97.5 | 73.7 | 66.7 | 100.0 | 35.4 | 97.5 | 78.9 | 66.7 | 100.0 |
| minilm-l12-q8 | 31.3 | 55.0 | 50.0 | 50.0 | 18.3 | 12.5 | 87.5 | 65.8 | 50.0 | 46.7 | 29.2 | 82.5 | 63.2 | 50.0 | 48.3 |
| bge-m3-q8 | 43.8 | 87.5 | 84.2 | 91.7 | 86.7 | 12.5 | 97.5 | 76.3 | 83.3 | 98.3 | 43.8 | 97.5 | 81.6 | 83.3 | 98.3 |
| gemma300m-q8 | 60.4 | 97.5 | 89.5 | 83.3 | 96.7 | 14.6 | 100.0 | 78.9 | 75.0 | 100.0 | 60.4 | 100.0 | 86.8 | 83.3 | 100.0 |
| gemma300m-q4 | 58.3 | 97.5 | 92.1 | 75.0 | 96.7 | 14.6 | 100.0 | 78.9 | 75.0 | 100.0 | 56.3 | 100.0 | 86.8 | 83.3 | 100.0 |
| gemma300m-q4f16 | 56.3 | 97.5 | 92.1 | 75.0 | 95.0 | 12.5 | 100.0 | 78.9 | 75.0 | 100.0 | 52.1 | 100.0 | 86.8 | 83.3 | 100.0 |
| gemma300m-fp16 | 56.3 | 97.5 | 89.5 | 83.3 | 96.7 | 12.5 | 100.0 | 78.9 | 75.0 | 100.0 | 56.3 | 100.0 | 86.8 | 83.3 | 100.0 |
| gemma300m-q8-SEM-DENSE | 56.3 | 97.5 | 92.1 | 91.7 | 98.3 | 14.6 | 100.0 | 81.6 | 83.3 | 100.0 | 54.2 | 100.0 | 86.8 | 83.3 | 100.0 |
| gemma2-q8 | 35.4 | 97.5 | 92.1 | 83.3 | 100.0 | 10.4 | 100.0 | 86.8 | 75.0 | 100.0 | 35.4 | 100.0 | 89.5 | 83.3 | 100.0 |
| gemma2-q4 | 33.3 | 90.0 | 89.5 | 83.3 | 98.3 | 10.4 | 100.0 | 86.8 | 75.0 | 100.0 | 33.3 | 100.0 | 84.2 | 83.3 | 100.0 |
| gemma2-q4f16 | 33.3 | 92.5 | 89.5 | 83.3 | 98.3 | 10.4 | 100.0 | 86.8 | 75.0 | 100.0 | 33.3 | 100.0 | 84.2 | 83.3 | 100.0 |
| gemma2-fp16 | 35.4 | 97.5 | 92.1 | 83.3 | 100.0 | 10.4 | 100.0 | 86.8 | 75.0 | 100.0 | 35.4 | 100.0 | 89.5 | 83.3 | 100.0 |
| granite97m-r2-q8 | 18.8 | 72.5 | 47.4 | 50.0 | 71.7 | 6.3 | 97.5 | 65.8 | 58.3 | 93.3 | 16.7 | 95.0 | 65.8 | 66.7 | 95.0 |
| granite97m-r2-fp32 | 31.3 | 90.0 | 52.6 | 66.7 | 90.0 | 12.5 | 100.0 | 71.1 | 75.0 | 100.0 | 29.2 | 97.5 | 68.4 | 66.7 | 100.0 |
| granite311m-r2-q8 | 35.4 | 90.0 | 73.7 | 66.7 | 66.7 | 10.4 | 92.5 | 78.9 | 75.0 | 98.3 | 33.3 | 90.0 | 81.6 | 66.7 | 98.3 |
| harrier270m-q8 | 35.4 | 87.5 | 76.3 | 66.7 | 83.3 | 14.6 | 92.5 | 78.9 | 75.0 | 100.0 | 33.3 | 95.0 | 78.9 | 83.3 | 100.0 |
| harrier270m-q4 | 35.4 | 87.5 | 71.1 | 75.0 | 80.0 | 14.6 | 95.0 | 78.9 | 75.0 | 100.0 | 31.3 | 95.0 | 78.9 | 75.0 | 100.0 |
| harrier0.6b-q4 | 47.9 | 92.5 | 84.2 | 91.7 | 86.7 | 14.6 | 95.0 | 78.9 | 75.0 | 100.0 | 45.8 | 95.0 | 86.8 | 83.3 | 100.0 |
| qwen3-0.6b-q4f16 | 41.7 | 82.5 | 86.8 | 66.7 | 66.7 | 14.6 | 92.5 | 81.6 | 75.0 | 91.7 | 41.7 | 92.5 | 84.2 | 66.7 | 100.0 |
| qwen3-0.6b-q8 | 8.3 | 85.0 | 78.9 | 41.7 | 65.0 | 0.0 | 97.5 | 73.7 | 50.0 | 98.3 | 8.3 | 92.5 | 76.3 | 50.0 | 96.7 |
| arctic-m-v2-q8 | 33.3 | 92.5 | 84.2 | 66.7 | 93.3 | 12.5 | 100.0 | 78.9 | 66.7 | 100.0 | 31.3 | 100.0 | 84.2 | 66.7 | 100.0 |
| arctic-l-v2-q8 | 39.6 | 87.5 | 86.8 | 91.7 | 90.0 | 10.4 | 97.5 | 81.6 | 83.3 | 98.3 | 39.6 | 95.0 | 86.8 | 91.7 | 100.0 |
| gte-mbase-q8 | 33.3 | 90.0 | 76.3 | 66.7 | 80.0 | 14.6 | 97.5 | 81.6 | 83.3 | 96.7 | 33.3 | 97.5 | 81.6 | 83.3 | 98.3 |
| nomic-v2-moe-q8 | 33.3 | 92.5 | 86.8 | 91.7 | 85.0 | 10.4 | 95.0 | 78.9 | 75.0 | 98.3 | 29.2 | 95.0 | 84.2 | 83.3 | 100.0 |
| pplx-0.6b-q4 | 43.8 | 87.5 | 65.8 | 83.3 | 91.7 | 10.4 | 97.5 | 68.4 | 83.3 | 100.0 | 41.7 | 97.5 | 71.1 | 75.0 | 100.0 |
| jina-v5-nano-q8 | 50.0 | 92.5 | 89.5 | 58.3 | 86.7 | 12.5 | 97.5 | 81.6 | 66.7 | 98.3 | 47.9 | 97.5 | 84.2 | 58.3 | 100.0 |

### Diferença pareada de MRR do híbrido (conv cob .5) contra o melhor (gemma300m-q8), IC 95% por bootstrap

| modelo | Δ MRR | IC 95% | leitura |
|---|---:|---:|---:|
| gemma300m-q4 | -0.004 | [-0.018, 0.009] | indistinguível |
| gemma300m-fp16 | -0.007 | [-0.017, 0.000] | indistinguível |
| gemma300m-q4f16 | -0.009 | [-0.024, 0.005] | indistinguível |
| gemma300m-q8-SEM-DENSE | -0.013 | [-0.029, 0.003] | indistinguível |
| bge-m3-q8 | -0.035 | [-0.065, -0.007] | pior (significativo) |
| jina-v5-nano-q8 | -0.036 | [-0.060, -0.012] | pior (significativo) |
| harrier0.6b-q4 | -0.037 | [-0.067, -0.010] | pior (significativo) |
| gemma2-q8 | -0.040 | [-0.067, -0.012] | pior (significativo) |
| gemma2-fp16 | -0.040 | [-0.067, -0.012] | pior (significativo) |
| arctic-l-v2-q8 | -0.042 | [-0.076, -0.012] | pior (significativo) |
| pplx-0.6b-q4 | -0.052 | [-0.085, -0.022] | pior (significativo) |
| gemma2-q4 | -0.054 | [-0.084, -0.027] | pior (significativo) |
| gemma2-q4f16 | -0.055 | [-0.084, -0.027] | pior (significativo) |
| arctic-m-v2-q8 | -0.062 | [-0.090, -0.037] | pior (significativo) |
| gte-mbase-q8 | -0.063 | [-0.097, -0.031] | pior (significativo) |
| qwen3-0.6b-q4f16 | -0.065 | [-0.095, -0.036] | pior (significativo) |
| nomic-v2-moe-q8 | -0.068 | [-0.102, -0.036] | pior (significativo) |
| harrier270m-q8 | -0.073 | [-0.109, -0.040] | pior (significativo) |
| harrier270m-q4 | -0.079 | [-0.118, -0.045] | pior (significativo) |
| e5-base-q8 | -0.083 | [-0.124, -0.048] | pior (significativo) |
| granite311m-r2-q8 | -0.084 | [-0.121, -0.050] | pior (significativo) |
| granite97m-r2-fp32 | -0.101 | [-0.140, -0.065] | pior (significativo) |
| e5-small-fp32 | -0.115 | [-0.158, -0.077] | pior (significativo) |
| e5-small-q8 | -0.127 | [-0.173, -0.086] | pior (significativo) |
| granite97m-r2-q8 | -0.156 | [-0.201, -0.113] | pior (significativo) |
| qwen3-0.6b-q8 | -0.168 | [-0.216, -0.123] | pior (significativo) |
| minilm-l12-q8 | -0.252 | [-0.300, -0.206] | pior (significativo) |


## Conjunto: Belebele por_Latn — 488 trechos, 900 perguntas

### BM25 (FTS5 `unicode61 remove_diacritics 2`)

| variante | R@1 | R@5 | R@10 | MRR@10 |
|---|---:|---:|---:|---:|
| texto, OR | 78.6 | 90.2 | 93.0 | 0.836 |
| texto, OR+prefixo | 80.7 | 92.0 | 94.4 | 0.857 |

### Vetor sozinho

| modelo | dims | R@1 | R@5 | R@10 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| pplx-0.6b-q4 | 1024 | 91.9 | 97.9 | 98.7 | 0.945 |
| gemma300m-q8-SEM-DENSE | 768 | 91.8 | 97.3 | 98.3 | 0.942 |
| gemma300m-fp16 | 768 | 91.1 | 97.7 | 98.4 | 0.941 |
| gemma300m-q8 | 768 | 90.8 | 97.7 | 98.3 | 0.938 |
| jina-v5-nano-q8 | 768 | 90.6 | 97.6 | 98.6 | 0.937 |
| gemma300m-q4 | 768 | 90.4 | 97.2 | 98.6 | 0.935 |
| gemma300m-q4f16 | 768 | 90.4 | 97.2 | 98.4 | 0.935 |
| harrier0.6b-q4 | 1024 | 90.3 | 97.7 | 98.3 | 0.935 |
| gemma2-q4 | 768 | 90.1 | 96.6 | 97.7 | 0.929 |
| bge-m3-q8 | 1024 | 89.6 | 96.9 | 98.2 | 0.928 |
| gemma2-q4f16 | 768 | 90.0 | 96.6 | 97.7 | 0.928 |
| gemma2-fp16 | 768 | 89.6 | 97.0 | 97.7 | 0.927 |
| arctic-l-v2-q8 | 1024 | 89.4 | 96.4 | 97.7 | 0.926 |
| nomic-v2-moe-q8 | 768 | 89.0 | 96.8 | 98.0 | 0.923 |
| arctic-m-v2-q8 | 768 | 88.4 | 96.1 | 97.2 | 0.917 |
| qwen3-0.6b-q4f16 | 1024 | 88.1 | 96.0 | 97.9 | 0.916 |
| harrier270m-q8 | 640 | 86.6 | 96.4 | 97.4 | 0.907 |
| harrier270m-q4 | 640 | 86.6 | 96.0 | 97.8 | 0.906 |
| e5-base-q8 | 768 | 86.6 | 95.6 | 96.9 | 0.903 |
| granite97m-r2-fp32 | 384 | 84.4 | 94.3 | 96.4 | 0.889 |
| gte-mbase-q8 | 768 | 84.0 | 95.6 | 97.1 | 0.889 |
| e5-small-fp32 | 384 | 84.7 | 93.8 | 96.6 | 0.888 |
| granite311m-r2-q8 | 768 | 84.3 | 94.0 | 96.1 | 0.886 |
| e5-small-q8 | 384 | 83.6 | 93.0 | 96.0 | 0.877 |
| granite97m-r2-q8 | 384 | 77.9 | 90.1 | 93.7 | 0.833 |
| qwen3-0.6b-q8 | 1024 | 74.2 | 87.7 | 91.6 | 0.803 |
| minilm-l12-q8 | 384 | 70.8 | 86.0 | 90.9 | 0.773 |

### Híbrido vetor + BM25 (texto, OR+prefixo; top-30 de cada lista) — MRR@10

BM25 sozinho: R@1 80.7 · R@5 92.0 · MRR 0.857

| modelo | vetor | RRF k=60 | RRF prof.100 | RRF 2:1 | conv mm .5 | conv mm .7 | RRF×cob | RRF porta .5 | conv cob .3 | conv cob .4 | conv cob .5 | conv cob .6 | conv cob .7 | R@1 vetor | R@1 RRF | R@1 conv cob .5 | R@5 vetor | R@5 RRF | R@5 conv cob .5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pplx-0.6b-q4 | 0.945 | 0.932 | 0.932 | 0.936 | 0.950 | 0.957 | 0.942 | 0.947 | 0.958 | 0.959 | 0.956 | 0.954 | 0.950 | 91.9 | 90.2 | 93.6 | 97.9 | 96.8 | 98.3 |
| jina-v5-nano-q8 | 0.937 | 0.933 | 0.932 | 0.935 | 0.947 | 0.953 | 0.940 | 0.941 | 0.957 | 0.959 | 0.956 | 0.953 | 0.947 | 90.6 | 90.3 | 93.6 | 97.6 | 96.3 | 98.1 |
| harrier0.6b-q4 | 0.935 | 0.930 | 0.929 | 0.933 | 0.949 | 0.950 | 0.938 | 0.939 | 0.956 | 0.957 | 0.954 | 0.951 | 0.947 | 90.3 | 89.8 | 93.3 | 97.7 | 96.8 | 97.9 |
| bge-m3-q8 | 0.928 | 0.933 | 0.932 | 0.936 | 0.949 | 0.950 | 0.940 | 0.934 | 0.955 | 0.955 | 0.952 | 0.946 | 0.942 | 89.6 | 90.2 | 93.0 | 96.9 | 97.0 | 98.2 |
| gemma300m-q8 | 0.938 | 0.929 | 0.928 | 0.931 | 0.948 | 0.950 | 0.935 | 0.941 | 0.958 | 0.956 | 0.952 | 0.950 | 0.947 | 90.8 | 89.7 | 93.0 | 97.7 | 96.8 | 98.0 |
| gemma300m-q4 | 0.935 | 0.928 | 0.927 | 0.930 | 0.947 | 0.950 | 0.935 | 0.939 | 0.958 | 0.958 | 0.952 | 0.949 | 0.945 | 90.4 | 89.6 | 92.9 | 97.2 | 96.4 | 97.9 |
| gemma300m-q4f16 | 0.935 | 0.929 | 0.928 | 0.930 | 0.947 | 0.950 | 0.934 | 0.939 | 0.958 | 0.957 | 0.951 | 0.947 | 0.945 | 90.4 | 89.7 | 92.9 | 97.2 | 96.3 | 97.8 |
| gemma300m-fp16 | 0.941 | 0.930 | 0.929 | 0.934 | 0.949 | 0.950 | 0.937 | 0.944 | 0.958 | 0.956 | 0.951 | 0.950 | 0.948 | 91.1 | 89.8 | 92.7 | 97.7 | 96.9 | 98.2 |
| gemma300m-q8-SEM-DENSE | 0.942 | 0.931 | 0.930 | 0.929 | 0.948 | 0.948 | 0.931 | 0.942 | 0.954 | 0.953 | 0.951 | 0.948 | 0.946 | 91.8 | 90.0 | 92.8 | 97.3 | 96.8 | 98.1 |
| gemma2-fp16 | 0.927 | 0.931 | 0.930 | 0.931 | 0.952 | 0.949 | 0.933 | 0.930 | 0.956 | 0.951 | 0.950 | 0.944 | 0.939 | 89.6 | 89.8 | 92.6 | 97.0 | 96.9 | 97.9 |
| gemma2-q4 | 0.929 | 0.932 | 0.931 | 0.935 | 0.952 | 0.947 | 0.939 | 0.932 | 0.954 | 0.953 | 0.946 | 0.944 | 0.938 | 90.1 | 90.0 | 92.1 | 96.6 | 96.9 | 97.7 |
| gemma2-q4f16 | 0.928 | 0.932 | 0.930 | 0.935 | 0.952 | 0.947 | 0.939 | 0.932 | 0.954 | 0.953 | 0.945 | 0.943 | 0.938 | 90.0 | 90.0 | 92.0 | 96.6 | 96.8 | 97.7 |
| arctic-l-v2-q8 | 0.926 | 0.926 | 0.924 | 0.928 | 0.944 | 0.945 | 0.930 | 0.931 | 0.949 | 0.949 | 0.945 | 0.941 | 0.935 | 89.4 | 89.4 | 92.0 | 96.4 | 96.1 | 97.3 |
| qwen3-0.6b-q4f16 | 0.916 | 0.928 | 0.928 | 0.930 | 0.941 | 0.939 | 0.933 | 0.924 | 0.949 | 0.946 | 0.940 | 0.935 | 0.930 | 88.1 | 89.6 | 91.0 | 96.0 | 96.7 | 97.2 |
| arctic-m-v2-q8 | 0.917 | 0.926 | 0.925 | 0.926 | 0.939 | 0.936 | 0.928 | 0.922 | 0.947 | 0.945 | 0.939 | 0.933 | 0.929 | 88.4 | 89.7 | 91.4 | 96.1 | 95.9 | 97.0 |
| nomic-v2-moe-q8 | 0.923 | 0.926 | 0.925 | 0.932 | 0.937 | 0.944 | 0.934 | 0.925 | 0.944 | 0.943 | 0.939 | 0.937 | 0.934 | 89.0 | 89.2 | 91.0 | 96.8 | 96.6 | 97.4 |
| harrier270m-q8 | 0.907 | 0.918 | 0.917 | 0.922 | 0.940 | 0.936 | 0.924 | 0.911 | 0.943 | 0.938 | 0.932 | 0.930 | 0.924 | 86.6 | 87.8 | 89.9 | 96.4 | 96.3 | 97.2 |
| gte-mbase-q8 | 0.889 | 0.914 | 0.913 | 0.915 | 0.935 | 0.929 | 0.919 | 0.904 | 0.941 | 0.938 | 0.932 | 0.922 | 0.914 | 84.0 | 87.0 | 90.0 | 95.6 | 96.9 | 97.2 |
| harrier270m-q4 | 0.906 | 0.921 | 0.921 | 0.923 | 0.940 | 0.935 | 0.925 | 0.911 | 0.943 | 0.939 | 0.931 | 0.927 | 0.923 | 86.6 | 88.3 | 89.6 | 96.0 | 96.6 | 97.7 |
| e5-base-q8 | 0.903 | 0.925 | 0.925 | 0.923 | 0.936 | 0.928 | 0.924 | 0.905 | 0.939 | 0.933 | 0.928 | 0.919 | 0.913 | 86.6 | 89.2 | 89.6 | 95.6 | 96.2 | 97.0 |
| granite97m-r2-fp32 | 0.889 | 0.921 | 0.920 | 0.917 | 0.936 | 0.928 | 0.920 | 0.904 | 0.941 | 0.934 | 0.927 | 0.915 | 0.907 | 84.4 | 88.4 | 89.8 | 94.3 | 96.2 | 96.6 |
| granite311m-r2-q8 | 0.886 | 0.918 | 0.917 | 0.914 | 0.937 | 0.927 | 0.919 | 0.900 | 0.942 | 0.935 | 0.925 | 0.916 | 0.909 | 84.3 | 88.4 | 89.4 | 94.0 | 95.7 | 96.6 |
| e5-small-fp32 | 0.888 | 0.916 | 0.916 | 0.919 | 0.932 | 0.919 | 0.919 | 0.896 | 0.932 | 0.925 | 0.920 | 0.911 | 0.904 | 84.7 | 88.1 | 89.0 | 93.8 | 95.9 | 95.7 |
| e5-small-q8 | 0.877 | 0.912 | 0.913 | 0.912 | 0.926 | 0.915 | 0.915 | 0.886 | 0.929 | 0.921 | 0.914 | 0.904 | 0.896 | 83.6 | 87.3 | 88.3 | 93.0 | 96.0 | 95.0 |
| granite97m-r2-q8 | 0.833 | 0.906 | 0.906 | 0.895 | 0.928 | 0.896 | 0.900 | 0.860 | 0.924 | 0.910 | 0.896 | 0.881 | 0.869 | 77.9 | 86.6 | 85.9 | 90.1 | 95.8 | 94.7 |
| minilm-l12-q8 | 0.773 | 0.880 | 0.880 | 0.866 | 0.903 | 0.857 | 0.865 | 0.815 | 0.913 | 0.887 | 0.862 | 0.837 | 0.817 | 70.8 | 83.0 | 81.0 | 86.0 | 94.6 | 93.0 |
| qwen3-0.6b-q8 | 0.803 | 0.883 | 0.884 | 0.872 | 0.901 | 0.862 | 0.874 | 0.834 | 0.899 | 0.882 | 0.862 | 0.849 | 0.834 | 74.2 | 83.7 | 81.0 | 87.7 | 93.8 | 92.8 |

### Diferença pareada de MRR do híbrido (conv cob .5) contra o melhor (pplx-0.6b-q4), IC 95% por bootstrap

| modelo | Δ MRR | IC 95% | leitura |
|---|---:|---:|---:|
| jina-v5-nano-q8 | -0.000 | [-0.008, 0.007] | indistinguível |
| harrier0.6b-q4 | -0.003 | [-0.011, 0.006] | indistinguível |
| bge-m3-q8 | -0.004 | [-0.012, 0.004] | indistinguível |
| gemma300m-q8 | -0.004 | [-0.011, 0.003] | indistinguível |
| gemma300m-q4 | -0.004 | [-0.012, 0.003] | indistinguível |
| gemma300m-q4f16 | -0.005 | [-0.012, 0.002] | indistinguível |
| gemma300m-fp16 | -0.005 | [-0.012, 0.002] | indistinguível |
| gemma300m-q8-SEM-DENSE | -0.005 | [-0.013, 0.002] | indistinguível |
| gemma2-fp16 | -0.006 | [-0.015, 0.002] | indistinguível |
| gemma2-q4 | -0.011 | [-0.019, -0.001] | pior (significativo) |
| gemma2-q4f16 | -0.011 | [-0.020, -0.002] | pior (significativo) |
| arctic-l-v2-q8 | -0.011 | [-0.019, -0.002] | pior (significativo) |
| qwen3-0.6b-q4f16 | -0.016 | [-0.024, -0.007] | pior (significativo) |
| arctic-m-v2-q8 | -0.017 | [-0.026, -0.008] | pior (significativo) |
| nomic-v2-moe-q8 | -0.017 | [-0.027, -0.007] | pior (significativo) |
| harrier270m-q8 | -0.024 | [-0.034, -0.013] | pior (significativo) |
| gte-mbase-q8 | -0.024 | [-0.036, -0.013] | pior (significativo) |
| harrier270m-q4 | -0.025 | [-0.036, -0.014] | pior (significativo) |
| e5-base-q8 | -0.028 | [-0.040, -0.016] | pior (significativo) |
| granite97m-r2-fp32 | -0.029 | [-0.040, -0.018] | pior (significativo) |
| granite311m-r2-q8 | -0.031 | [-0.043, -0.020] | pior (significativo) |
| e5-small-fp32 | -0.037 | [-0.048, -0.025] | pior (significativo) |
| e5-small-q8 | -0.042 | [-0.055, -0.030] | pior (significativo) |
| granite97m-r2-q8 | -0.061 | [-0.076, -0.046] | pior (significativo) |
| minilm-l12-q8 | -0.094 | [-0.112, -0.077] | pior (significativo) |
| qwen3-0.6b-q8 | -0.094 | [-0.111, -0.078] | pior (significativo) |

### Formato de armazenamento do vetor (busca vetorial pura; MRR@10 e R@1)

| modelo | dims | float32 | float16 | int8 (escala por vetor) | int8 ingênuo (x·127) | binário Hamming | binário, pergunta float | binário top-50 → rescoring int8 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| e5-small-q8 | 384 | 0.877 / 83.6 | 0.877 / 83.6 | 0.878 / 83.7 | 0.874 / 83.0 | 0.260 / 19.4 | 0.405 / 32.4 | 0.637 / 62.0 |
| e5-small-fp32 | 384 | 0.888 / 84.7 | 0.888 / 84.7 | 0.888 / 84.7 | 0.886 / 84.4 | 0.259 / 18.0 | 0.410 / 32.3 | 0.672 / 65.6 |
| e5-base-q8 | 768 | 0.903 / 86.6 | 0.903 / 86.6 | 0.902 / 86.3 | 0.900 / 86.0 | 0.540 / 45.7 | 0.708 / 63.7 | 0.833 / 80.8 |
| minilm-l12-q8 | 384 | 0.773 / 70.8 | 0.773 / 70.8 | 0.774 / 70.8 | 0.774 / 70.8 | 0.713 / 63.1 | 0.740 / 65.6 | 0.774 / 70.8 |
| bge-m3-q8 | 1024 | 0.928 / 89.6 | 0.928 / 89.6 | 0.927 / 89.4 | 0.925 / 89.1 | 0.890 / 85.0 | 0.910 / 86.9 | 0.927 / 89.4 |
| gemma300m-q8 | 768 | 0.938 / 90.8 | 0.938 / 90.8 | 0.938 / 90.8 | 0.940 / 91.1 | 0.917 / 87.9 | 0.932 / 90.1 | 0.938 / 90.8 |
| gemma300m-q4 | 768 | 0.935 / 90.4 | 0.935 / 90.4 | 0.935 / 90.4 | 0.935 / 90.3 | 0.901 / 86.1 | 0.922 / 88.6 | 0.935 / 90.4 |
| gemma300m-q4f16 | 768 | 0.935 / 90.4 | 0.935 / 90.4 | 0.934 / 90.3 | 0.934 / 90.3 | 0.904 / 86.6 | 0.925 / 89.1 | 0.935 / 90.3 |
| gemma300m-fp16 | 768 | 0.941 / 91.1 | 0.941 / 91.1 | 0.941 / 91.1 | 0.942 / 91.4 | 0.915 / 87.7 | 0.933 / 90.2 | 0.941 / 91.1 |
| gemma2-q4 | 768 | 0.929 / 90.1 | 0.929 / 90.1 | 0.928 / 90.0 | 0.927 / 89.9 | 0.882 / 83.9 | 0.909 / 87.2 | 0.928 / 90.0 |
| gemma2-q4f16 | 768 | 0.928 / 90.0 | 0.928 / 90.0 | 0.928 / 90.0 | 0.927 / 89.8 | 0.881 / 83.7 | 0.907 / 87.0 | 0.928 / 90.0 |
| gemma2-fp16 | 768 | 0.927 / 89.6 | 0.927 / 89.6 | 0.927 / 89.4 | 0.927 / 89.3 | 0.885 / 83.8 | 0.916 / 88.3 | 0.926 / 89.4 |
| granite97m-r2-q8 | 384 | 0.833 / 77.9 | 0.832 / 77.8 | 0.833 / 77.8 | 0.832 / 77.8 | 0.741 / 67.2 | 0.795 / 72.7 | 0.833 / 77.8 |
| granite97m-r2-fp32 | 384 | 0.889 / 84.4 | 0.888 / 84.3 | 0.889 / 84.6 | 0.887 / 84.2 | 0.821 / 76.3 | 0.855 / 80.2 | 0.886 / 84.3 |
| granite311m-r2-q8 | 768 | 0.886 / 84.3 | 0.886 / 84.3 | 0.887 / 84.4 | 0.885 / 84.3 | 0.839 / 77.9 | 0.866 / 82.0 | 0.886 / 84.4 |
| harrier270m-q8 | 640 | 0.907 / 86.6 | 0.907 / 86.6 | 0.908 / 86.8 | 0.906 / 86.4 | 0.815 / 75.1 | 0.880 / 83.2 | 0.906 / 86.9 |
| harrier270m-q4 | 640 | 0.906 / 86.6 | 0.906 / 86.6 | 0.907 / 86.7 | 0.906 / 86.6 | 0.814 / 75.2 | 0.873 / 82.6 | 0.903 / 86.7 |
| harrier0.6b-q4 | 1024 | 0.935 / 90.3 | 0.935 / 90.3 | 0.935 / 90.4 | 0.935 / 90.4 | 0.889 / 85.0 | 0.911 / 87.4 | 0.934 / 90.4 |
| qwen3-0.6b-q4f16 | 1024 | 0.916 / 88.1 | 0.916 / 88.1 | 0.916 / 88.1 | 0.914 / 87.9 | 0.884 / 84.7 | 0.897 / 85.6 | 0.916 / 88.1 |
| qwen3-0.6b-q8 | 1024 | 0.803 / 74.2 | 0.803 / 74.2 | 0.802 / 74.0 | 0.801 / 74.0 | 0.754 / 69.4 | 0.787 / 73.2 | 0.802 / 74.0 |
| arctic-m-v2-q8 | 768 | 0.917 / 88.4 | 0.917 / 88.4 | 0.917 / 88.4 | 0.917 / 88.6 | 0.883 / 84.1 | 0.907 / 87.3 | 0.916 / 88.4 |
| arctic-l-v2-q8 | 1024 | 0.926 / 89.4 | 0.926 / 89.4 | 0.927 / 89.6 | 0.926 / 89.3 | 0.892 / 85.2 | 0.908 / 86.8 | 0.926 / 89.4 |
| gte-mbase-q8 | 768 | 0.889 / 84.0 | 0.889 / 84.0 | 0.889 / 84.0 | 0.891 / 84.3 | 0.830 / 76.8 | 0.869 / 81.8 | 0.888 / 84.0 |
| nomic-v2-moe-q8 | 768 | 0.923 / 89.0 | 0.923 / 89.0 | 0.923 / 89.0 | 0.923 / 89.0 | 0.864 / 80.7 | 0.898 / 85.0 | 0.923 / 89.0 |
| pplx-0.6b-q4 | 1024 | 0.945 / 91.9 | 0.945 / 91.9 | 0.945 / 91.9 | 0.945 / 91.9 | 0.930 / 90.2 | 0.942 / 91.4 | 0.945 / 91.9 |
| jina-v5-nano-q8 | 768 | 0.937 / 90.6 | 0.937 / 90.6 | 0.937 / 90.6 | 0.937 / 90.7 | 0.923 / 88.7 | 0.934 / 90.6 | 0.937 / 90.6 |

### Truncamento (MRR@10; `*` = dimensão NÃO declarada como Matryoshka pelo modelo)

| modelo | dimensão cheia | truncado |
|---|---:|---:|
| e5-small-q8 | 384d: 0.877 → int8 0.878 (384 B) | 256d*: 0.828 → int8 0.828 (256 B) · 128d*: 0.673 → int8 0.672 (128 B) |
| e5-small-fp32 | 384d: 0.888 → int8 0.888 (384 B) | 256d*: 0.837 → int8 0.837 (256 B) · 128d*: 0.695 → int8 0.695 (128 B) |
| e5-base-q8 | 768d: 0.903 → int8 0.902 (768 B) | 256d*: 0.769 → int8 0.769 (256 B) · 128d*: 0.583 → int8 0.584 (128 B) |
| minilm-l12-q8 | 384d: 0.773 → int8 0.774 (384 B) | 256d*: 0.757 → int8 0.757 (256 B) · 128d*: 0.711 → int8 0.711 (128 B) |
| bge-m3-q8 | 1024d: 0.928 → int8 0.927 (1024 B) | 256d*: 0.866 → int8 0.867 (256 B) · 128d*: 0.745 → int8 0.746 (128 B) |
| gemma300m-q8 | 768d: 0.938 → int8 0.938 (768 B) | 512d: 0.939 → int8 0.939 (512 B) · 256d: 0.924 → int8 0.924 (256 B) · 128d: 0.882 → int8 0.882 (128 B) |
| gemma300m-q4 | 768d: 0.935 → int8 0.935 (768 B) | 512d: 0.932 → int8 0.933 (512 B) · 256d: 0.920 → int8 0.921 (256 B) · 128d: 0.876 → int8 0.876 (128 B) |
| gemma300m-q4f16 | 768d: 0.935 → int8 0.934 (768 B) | 512d: 0.933 → int8 0.932 (512 B) · 256d: 0.915 → int8 0.915 (256 B) · 128d: 0.876 → int8 0.876 (128 B) |
| gemma300m-fp16 | 768d: 0.941 → int8 0.941 (768 B) | 512d: 0.938 → int8 0.939 (512 B) · 256d: 0.924 → int8 0.924 (256 B) · 128d: 0.880 → int8 0.880 (128 B) |
| gemma2-q4 | 768d: 0.929 → int8 0.928 (768 B) | 512d: 0.923 → int8 0.923 (512 B) · 256d: 0.903 → int8 0.904 (256 B) · 128d: 0.858 → int8 0.854 (128 B) |
| gemma2-q4f16 | 768d: 0.928 → int8 0.928 (768 B) | 512d: 0.923 → int8 0.924 (512 B) · 256d: 0.903 → int8 0.904 (256 B) · 128d: 0.858 → int8 0.856 (128 B) |
| gemma2-fp16 | 768d: 0.927 → int8 0.927 (768 B) | 512d: 0.924 → int8 0.924 (512 B) · 256d: 0.908 → int8 0.910 (256 B) · 128d: 0.861 → int8 0.861 (128 B) |
| granite97m-r2-q8 | 384d: 0.833 → int8 0.833 (384 B) | 256d*: 0.813 → int8 0.814 (256 B) · 128d*: 0.756 → int8 0.756 (128 B) |
| granite97m-r2-fp32 | 384d: 0.889 → int8 0.889 (384 B) | 256d*: 0.866 → int8 0.866 (256 B) · 128d*: 0.820 → int8 0.821 (128 B) |
| granite311m-r2-q8 | 768d: 0.886 → int8 0.887 (768 B) | 512d: 0.886 → int8 0.886 (512 B) · 384d: 0.883 → int8 0.882 (384 B) · 256d: 0.881 → int8 0.880 (256 B) · 128d: 0.867 → int8 0.864 (128 B) |
| harrier270m-q8 | 640d: 0.907 → int8 0.908 (640 B) | 256d*: 0.847 → int8 0.846 (256 B) · 128d*: 0.740 → int8 0.742 (128 B) |
| harrier270m-q4 | 640d: 0.906 → int8 0.907 (640 B) | 256d*: 0.837 → int8 0.837 (256 B) · 128d*: 0.718 → int8 0.716 (128 B) |
| harrier0.6b-q4 | 1024d: 0.935 → int8 0.935 (1024 B) | 256d*: 0.812 → int8 0.812 (256 B) · 128d*: 0.667 → int8 0.666 (128 B) |
| qwen3-0.6b-q4f16 | 1024d: 0.916 → int8 0.916 (1024 B) | 512d: 0.897 → int8 0.896 (512 B) · 256d: 0.876 → int8 0.877 (256 B) · 128d: 0.847 → int8 0.847 (128 B) |
| qwen3-0.6b-q8 | 1024d: 0.803 → int8 0.802 (1024 B) | 512d: 0.760 → int8 0.760 (512 B) · 256d: 0.702 → int8 0.702 (256 B) · 128d: 0.620 → int8 0.620 (128 B) |
| arctic-m-v2-q8 | 768d: 0.917 → int8 0.917 (768 B) | 256d: 0.912 → int8 0.911 (256 B) · 128d*: 0.844 → int8 0.845 (128 B) |
| arctic-l-v2-q8 | 1024d: 0.926 → int8 0.927 (1024 B) | 256d: 0.917 → int8 0.917 (256 B) · 128d*: 0.852 → int8 0.851 (128 B) |
| gte-mbase-q8 | 768d: 0.889 → int8 0.889 (768 B) | 512d: 0.884 → int8 0.884 (512 B) · 256d: 0.866 → int8 0.866 (256 B) · 128d: 0.827 → int8 0.828 (128 B) |
| nomic-v2-moe-q8 | 768d: 0.923 → int8 0.923 (768 B) | 256d: 0.878 → int8 0.877 (256 B) · 128d*: 0.791 → int8 0.791 (128 B) |
| pplx-0.6b-q4 | 1024d: 0.945 → int8 0.945 (1024 B) | 256d*: 0.910 → int8 0.910 (256 B) · 128d*: 0.884 → int8 0.884 (128 B) |
| jina-v5-nano-q8 | 768d: 0.937 → int8 0.937 (768 B) | 512d: 0.936 → int8 0.936 (512 B) · 256d: 0.926 → int8 0.926 (256 B) · 128d: 0.901 → int8 0.900 (128 B) |


## Conjunto: Quati 1M (pool julgado) — 1896 trechos, 49 perguntas

### BM25 (FTS5 `unicode61 remove_diacritics 2`)

| variante | R@1 | R@5 | R@10 | MRR@10 | nDCG@10 |
|---|---:|---:|---:|---:|---:|
| texto, OR | 53.1 | 85.7 | 95.9 | 0.687 | 0.396 |
| texto, OR+prefixo | 44.9 | 89.8 | 95.9 | 0.654 | 0.402 |

### Vetor sozinho

| modelo | dims | R@1 | R@5 | R@10 | MRR@10 | nDCG@10 |
|---|---:|---:|---:|---:|---:|---:|
| gemma300m-q4 | 768 | 79.6 | 91.8 | 100.0 | 0.868 | 0.583 |
| bge-m3-q8 | 1024 | 81.6 | 91.8 | 98.0 | 0.858 | 0.567 |
| gemma2-q4 | 768 | 71.4 | 93.9 | 100.0 | 0.823 | 0.537 |
| e5-base-q8 | 768 | 71.4 | 93.9 | 95.9 | 0.808 | 0.495 |
| e5-small-q8 | 384 | 71.4 | 91.8 | 95.9 | 0.803 | 0.505 |
| granite97m-r2-fp32 | 384 | 67.3 | 93.9 | 100.0 | 0.789 | 0.502 |

### Híbrido vetor + BM25 (texto, OR+prefixo; top-30 de cada lista) — nDCG@10

BM25 sozinho: R@1 44.9 · R@5 89.8 · MRR 0.654 · nDCG@10 0.402

| modelo | vetor | RRF k=60 | RRF prof.100 | RRF 2:1 | conv mm .5 | conv mm .7 | RRF×cob | RRF porta .5 | conv cob .3 | conv cob .4 | conv cob .5 | conv cob .6 | conv cob .7 | R@1 vetor | R@1 RRF | R@1 conv cob .5 | R@5 vetor | R@5 RRF | R@5 conv cob .5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gemma300m-q4 | 0.583 | 0.564 | 0.562 | 0.574 | 0.536 | 0.579 | 0.566 | 0.564 | 0.527 | 0.560 | 0.580 | 0.590 | 0.595 | 79.6 | 81.6 | 83.7 | 91.8 | 95.9 | 95.9 |
| bge-m3-q8 | 0.567 | 0.546 | 0.546 | 0.562 | 0.531 | 0.571 | 0.544 | 0.546 | 0.514 | 0.541 | 0.562 | 0.576 | 0.573 | 81.6 | 79.6 | 83.7 | 91.8 | 93.9 | 91.8 |
| gemma2-q4 | 0.537 | 0.534 | 0.535 | 0.556 | 0.510 | 0.552 | 0.535 | 0.534 | 0.507 | 0.534 | 0.543 | 0.555 | 0.547 | 71.4 | 77.6 | 75.5 | 93.9 | 95.9 | 93.9 |
| granite97m-r2-fp32 | 0.502 | 0.509 | 0.514 | 0.512 | 0.497 | 0.510 | 0.509 | 0.509 | 0.483 | 0.501 | 0.508 | 0.514 | 0.516 | 67.3 | 67.3 | 69.4 | 93.9 | 95.9 | 95.9 |
| e5-base-q8 | 0.495 | 0.486 | 0.484 | 0.490 | 0.489 | 0.516 | 0.487 | 0.486 | 0.471 | 0.488 | 0.504 | 0.511 | 0.512 | 71.4 | 67.3 | 73.5 | 93.9 | 91.8 | 93.9 |
| e5-small-q8 | 0.505 | 0.509 | 0.508 | 0.509 | 0.481 | 0.499 | 0.508 | 0.509 | 0.479 | 0.485 | 0.495 | 0.497 | 0.492 | 71.4 | 73.5 | 71.4 | 91.8 | 91.8 | 89.8 |

### Diferença pareada de MRR do híbrido (conv cob .5) contra o melhor (gemma300m-q4), IC 95% por bootstrap

| modelo | Δ MRR | IC 95% | leitura |
|---|---:|---:|---:|
| bge-m3-q8 | -0.010 | [-0.067, 0.046] | indistinguível |
| gemma2-q4 | -0.046 | [-0.104, 0.007] | indistinguível |
| e5-base-q8 | -0.072 | [-0.138, -0.009] | pior (significativo) |
| e5-small-q8 | -0.079 | [-0.151, -0.017] | pior (significativo) |
| granite97m-r2-fp32 | -0.085 | [-0.155, -0.020] | pior (significativo) |


## Custo dos modelos (onnxruntime-node, CPU, Apple M3 Pro)

| modelo | repositório ONNX | dtype | parâmetros | dims | ONNX (MB) | carga c/ cache (ms) | pergunta curta (ms) | ms/trecho lote 32 | ms/trecho lote 1 | tokens/trecho | RSS após carga (MB) | RSS após perguntas (MB) | RSS pico (MB) | licença |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| e5-small-q8 | Xenova/multilingual-e5-small | q8 | 118M | 384 | 118.3 | 1058 | 9.5 | 37.2 | 51.6 | 286 | 507 | 432 | 1074 | MIT |
| e5-small-fp32 | Xenova/multilingual-e5-small | fp32 | 118M | 384 | 470.3 | 1039 | 8.7 | 60.5 | 63.3 | 286 | 567 | 557 | 1170 | MIT |
| e5-base-q8 | Xenova/multilingual-e5-base | q8 | 278M | 768 | 278.6 | 712 | 9.5 | 78.1 | 67.3 | 286 | 1040 | 1076 | 1095 | MIT |
| minilm-l12-q8 | Xenova/paraphrase-multilingual-MiniLM-L12-v2 | q8 | 118M | 384 | 118.3 | 691 | 6.2 | 24.5 | 29.3 | 284 | 658 | 716 | 1184 | Apache-2.0 |
| bge-m3-q8 | Xenova/bge-m3 | q8 | 568M | 1024 | 569.7 | 1021 | 19.8 | 208.4 | 195 | 284 | 1116 | 1082 | 1271 | MIT |
| gemma300m-q8 | onnx-community/embeddinggemma-300m-ONNX | q8 | 308M | 768 | 309.5 | 993 | 61 | 254 | 300.3 | 282 | 482 | 1632 | 1978 | Gemma (termos de uso) |
| gemma300m-q4 | onnx-community/embeddinggemma-300m-ONNX | q4 | 308M | 768 | 197.2 | 1020 | 12.4 | 94.3 | 97.3 | 282 | 547 | 561 | 1138 | Gemma (termos de uso) |
| gemma300m-q4f16 | onnx-community/embeddinggemma-300m-ONNX | q4f16 | 308M | 768 | 176.1 | 861 | 15.4 | 119.4 | 135.2 | 282 | 561 | 574 | 1430 | Gemma (termos de uso) |
| gemma300m-fp16 | onnx-community/embeddinggemma-300m-ONNX | fp16 | 308M | 768 | 618.1 | 1350 | 22.4 | 211.6 | 196.9 | 282 | 900 | 909 | 1548 | Gemma (termos de uso) |
| gemma300m-q8-SEM-DENSE | onnx-community/embeddinggemma-300m-ONNX | q8 | 308M | 768 | 309.5 | 721 | 49.8 | 195.2 | 601.2 | 282 | 521 | 1697 | 2110 | Gemma (termos de uso) |
| gemma2-q8 | onnx-community/embeddinggemma-2-ONNX | q8 | 270M (texto) | 768 | 314.2 | 472 | 53.1 | — | — | — | 522 | 711 | 934 | Apache-2.0 |
| gemma2-q4 | onnx-community/embeddinggemma-2-ONNX | q4 | 270M (texto) | 768 | 174.5 | 1089 | 40.9 | 270.1 | 262.7 | 282 | 576 | 556 | 2799 | Apache-2.0 |
| gemma2-q4f16 | onnx-community/embeddinggemma-2-ONNX | q4f16 | 270M (texto) | 768 | 157.4 | 1055 | 50.7 | 341.3 | 301.2 | 282 | 614 | 631 | 2658 | Apache-2.0 |
| gemma2-fp16 | onnx-community/embeddinggemma-2-ONNX | fp16 | 270M (texto) | 768 | 542.5 | 1533 | 35.6 | 319.6 | 275.6 | 282 | 1136 | 1143 | 3212 | Apache-2.0 |
| granite97m-r2-q8 | onnx-community/granite-embedding-97m-multilingual-r2-ONNX | q8 | 97M | 384 | 97.9 | 538 | 4.5 | 28.2 | 24.9 | 265 | 633 | 637 | 1284 | Apache-2.0 |
| granite97m-r2-fp32 | onnx-community/granite-embedding-97m-multilingual-r2-ONNX | fp32 | 97M | 384 | 390 | 581 | 5.1 | 77.2 | 144.7 | 265 | 1342 | 1347 | 1460 | Apache-2.0 |
| granite311m-r2-q8 | ibm-granite/granite-embedding-311m-multilingual-r2 | fp32 (model_quint8_avx2) | 311M | 768 | 313.4 | 1222 | 23.7 | 157.1 | 216 | 275 | 1337 | 1313 | 1339 | Apache-2.0 |
| harrier270m-q8 | onnx-community/harrier-oss-v1-270m-ONNX | q8 | 270M | 640 | 343.9 | 918 | 135.6 | 277.8 | 436.3 | 276 | 421 | 485 | 1434 | MIT |
| harrier270m-q4 | onnx-community/harrier-oss-v1-270m-ONNX | q4 | 270M | 640 | 205.7 | 1038 | 57 | 246.5 | 323.4 | 276 | 464 | 474 | 1323 | MIT |
| harrier0.6b-q4 | onnx-community/harrier-oss-v1-0.6b-ONNX | q4 | 0.6B | 1024 | 399.2 | 1053 | 217.3 | 1182.6 | 991 | 315 | 457 | 543 | 2646 | MIT |
| qwen3-0.6b-q4f16 | onnx-community/Qwen3-Embedding-0.6B-ONNX | q4f16 | 0.6B | 1024 | 567.5 | 708 | 50 | — | — | — | 1571 | 1636 | 2412 | Apache-2.0 |
| qwen3-0.6b-q8 | onnx-community/Qwen3-Embedding-0.6B-ONNX | q8 | 0.6B | 1024 | 613.5 | 719 | 74.3 | 1898.1 | 807.2 | 315 | 1207 | 1296 | 3092 | Apache-2.0 |
| arctic-m-v2-q8 | Snowflake/snowflake-arctic-embed-m-v2.0 | q8 | 305M | 768 | 310.9 | 690 | 12.1 | 105.7 | 106.9 | 284 | 1113 | 1160 | 2444 | Apache-2.0 |
| arctic-l-v2-q8 | Snowflake/snowflake-arctic-embed-l-v2.0 | q8 | 568M | 1024 | 569.7 | 845 | 27.2 | 244.5 | 265 | 284 | 1698 | 1702 | 2275 | Apache-2.0 |
| gte-mbase-q8 | onnx-community/gte-multilingual-base | q8 | 305M | 768 | 340.3 | 634 | 11.3 | 102.9 | 155.6 | 284 | 1183 | 1187 | 2492 | Apache-2.0 |
| nomic-v2-moe-q8 | netrias/nomic-embed-text-v2-moe-onnx | q8 | 475M | 768 | 477.7 | 953 | 27.1 | 274.3 | 297.5 | 288 | 1336 | 1356 | 3872 | Apache-2.0 |
| pplx-0.6b-q4 | perplexity-ai/pplx-embed-v1-0.6b | q4 | 0.6B | 1024 | 399.4 | 855 | 46.8 | — | — | — | 497 | 565 | 1348 | MIT |
| jina-v5-nano-q8 | jinaai/jina-embeddings-v5-text-nano-retrieval | q8 | 239M | 768 | 247.1 | 247 | 45.5 | — | — | — | 435 | 576 | 751 | CC-BY-NC-4.0 (não comercial) |

---

# Apêndice B — Rerankers (gerado por `rerank.mjs`)

## Reranker local por cima do híbrido (top-30 do `conv cob .5`)

| reranker | ONNX (MB) | carga (ms) | 30 cand. ~300 tokens (ms) | 30 cand. curtos (ms) | RSS pico (MB) | licença | carrega no transformers.js 4.3.2? |
|---|---:|---:|---:|---:|---:|---:|---:|
| mmarco-mMiniLMv2-L12 (qint8) | 118.6 | 816 | 1517 | 302 | 846 | Apache-2.0 | sim |
| mmarco-mMiniLMv2-L12 (fp32) | 470.9 | 1197 | 2191 | 380 | 1188 | Apache-2.0 | sim |
| bge-reranker-v2-m3 (q8) | 570.7 | 1373 | 8503 | 1888 | 1565 | Apache-2.0 | sim |
| jina-reranker-v2-base-multilingual (q8) | 279.6 | 508 | 1723 | 285 | 1257 | CC-BY-NC-4.0 | não (rodou via onnxruntime-node direto) |

### Sintético (segundo cérebro) (138 perguntas) — MRR@10 / R@1 / R@5

| candidatos de | sem reranker | mmarco-mMiniLMv2-L12 (qint8) | mmarco-mMiniLMv2-L12 (fp32) | bge-reranker-v2-m3 (q8) | jina-reranker-v2-base-multilingual (q8) |
|---|---:|---:|---:|---:|---:|
| e5-small-q8 | 0.699 / 62.3 / 80.4 | 0.635 / 55.8 / 75.4 | 0.653 / 58.0 / 74.6 | 0.824 / 79.0 / 87.7 | 0.762 / 70.3 / 83.3 |
| gemma2-q4 | 0.791 / 73.2 / 87.0 | 0.677 / 59.4 / 79.7 | 0.691 / 60.9 / 80.4 | 0.861 / 81.2 / 92.8 | 0.788 / 72.5 / 87.0 |
| gemma300m-q4 | 0.857 / 81.2 / 90.6 | 0.654 / 56.5 / 77.5 | 0.680 / 60.1 / 78.3 | 0.859 / 81.2 / 92.0 | 0.771 / 69.6 / 85.5 |
| (só BM25) | 0.553 / 52.9 / 58.7 | 0.594 / 58.7 / 60.1 | 0.598 / 59.4 / 60.1 | 0.601 / 60.1 / 60.1 | 0.594 / 58.7 / 60.1 |

R@1 por tipo (P / E / V / C):

| candidatos de | sem reranker | mmarco-mMiniLMv2-L12 (qint8) | mmarco-mMiniLMv2-L12 (fp32) | bge-reranker-v2-m3 (q8) | jina-reranker-v2-base-multilingual (q8) |
|---|---:|---:|---:|---:|---:|
| e5-small-q8 | 14.6 / 97.5 / 81.6 / 75.0 | 14.6 / 100.0 / 52.6 / 83.3 | 14.6 / 100.0 / 60.5 / 83.3 | 47.9 / 100.0 / 92.1 / 91.7 | 35.4 / 100.0 / 76.3 / 91.7 |
| gemma2-q4 | 37.5 / 100.0 / 89.5 / 75.0 | 18.8 / 100.0 / 57.9 / 91.7 | 16.7 / 100.0 / 65.8 / 91.7 | 54.2 / 100.0 / 92.1 / 91.7 | 37.5 / 100.0 / 81.6 / 91.7 |
| gemma300m-q4 | 58.3 / 100.0 / 92.1 / 75.0 | 18.8 / 100.0 / 50.0 / 83.3 | 18.8 / 100.0 / 63.2 / 83.3 | 52.1 / 100.0 / 94.7 / 91.7 | 35.4 / 100.0 / 73.7 / 91.7 |
| (só BM25) | 0.0 / 95.0 / 73.7 / 58.3 | 0.0 / 100.0 / 78.9 / 91.7 | 0.0 / 100.0 / 81.6 / 91.7 | 0.0 / 100.0 / 84.2 / 91.7 | 0.0 / 100.0 / 81.6 / 83.3 |

### Sintético + estresse de identificadores (198 perguntas) — MRR@10 / R@1 / R@5

| candidatos de | sem reranker | mmarco-mMiniLMv2-L12 (qint8) | mmarco-mMiniLMv2-L12 (fp32) | bge-reranker-v2-m3 (q8) | jina-reranker-v2-base-multilingual (q8) |
|---|---:|---:|---:|---:|---:|
| e5-small-q8 | 0.760 / 72.2 / 81.3 | 0.719 / 66.2 / 81.3 | 0.727 / 67.2 / 80.3 | 0.824 / 79.3 / 85.9 | 0.790 / 75.3 / 82.8 |
| gemma2-q4 | 0.833 / 79.8 / 88.4 | 0.754 / 69.2 / 84.8 | 0.775 / 72.7 / 84.8 | 0.854 / 82.3 / 89.4 | 0.820 / 78.3 / 86.4 |
| gemma300m-q4 | 0.883 / 85.9 / 90.9 | 0.738 / 66.2 / 83.8 | 0.748 / 68.2 / 84.3 | 0.861 / 81.8 / 91.9 | 0.811 / 75.8 / 87.4 |
| (só BM25) | 0.688 / 67.2 / 70.7 | 0.712 / 70.2 / 72.2 | 0.717 / 71.2 / 72.2 | 0.717 / 71.2 / 72.2 | 0.712 / 70.2 / 72.2 |

R@1 por tipo (P / E / V / C / I):

| candidatos de | sem reranker | mmarco-mMiniLMv2-L12 (qint8) | mmarco-mMiniLMv2-L12 (fp32) | bge-reranker-v2-m3 (q8) | jina-reranker-v2-base-multilingual (q8) |
|---|---:|---:|---:|---:|---:|
| e5-small-q8 | 12.5 / 95.0 / 78.9 / 75.0 / 100.0 | 10.4 / 100.0 / 50.0 / 91.7 / 93.3 | 12.5 / 100.0 / 50.0 / 91.7 / 95.0 | 35.4 / 100.0 / 84.2 / 91.7 / 95.0 | 27.1 / 100.0 / 73.7 / 91.7 / 95.0 |
| gemma2-q4 | 33.3 / 100.0 / 84.2 / 83.3 / 100.0 | 14.6 / 100.0 / 60.5 / 91.7 / 93.3 | 22.9 / 100.0 / 65.8 / 91.7 / 95.0 | 45.8 / 100.0 / 86.8 / 91.7 / 95.0 | 33.3 / 100.0 / 81.6 / 91.7 / 95.0 |
| gemma300m-q4 | 56.3 / 100.0 / 86.8 / 83.3 / 100.0 | 14.6 / 100.0 / 44.7 / 91.7 / 93.3 | 18.8 / 100.0 / 47.4 / 91.7 / 95.0 | 43.8 / 100.0 / 86.8 / 91.7 / 95.0 | 31.3 / 100.0 / 71.1 / 91.7 / 95.0 |
| (só BM25) | 0.0 / 95.0 / 73.7 / 58.3 / 100.0 | 0.0 / 100.0 / 78.9 / 91.7 / 96.7 | 0.0 / 100.0 / 81.6 / 91.7 / 98.3 | 0.0 / 100.0 / 84.2 / 91.7 / 96.7 | 0.0 / 100.0 / 81.6 / 83.3 / 96.7 |

### Belebele por_Latn (150 perguntas) — MRR@10 / R@1 / R@5

| candidatos de | sem reranker | mmarco-mMiniLMv2-L12 (qint8) | mmarco-mMiniLMv2-L12 (fp32) | bge-reranker-v2-m3 (q8) | jina-reranker-v2-base-multilingual (q8) |
|---|---:|---:|---:|---:|---:|
| e5-small-q8 | 0.918 / 89.3 / 94.7 | 0.939 / 92.7 / 95.3 | 0.942 / 92.7 / 96.7 | 0.973 / 96.0 / 98.7 | 0.960 / 94.7 / 98.0 |
| gemma2-q4 | 0.940 / 91.3 / 97.3 | 0.938 / 92.0 / 96.0 | 0.938 / 92.0 / 96.7 | 0.973 / 96.0 / 98.7 | 0.959 / 94.7 / 96.7 |
| gemma300m-q4 | 0.957 / 94.0 / 97.3 | 0.944 / 92.7 / 96.7 | 0.946 / 92.7 / 97.3 | 0.980 / 96.7 / 99.3 | 0.962 / 94.7 / 98.7 |
| (só BM25) | 0.867 / 82.0 / 92.0 | 0.949 / 93.3 / 97.3 | 0.949 / 93.3 / 98.0 | 0.971 / 96.0 / 98.0 | 0.961 / 94.7 / 98.7 |

---

# Apêndice C — Bytes por trecho (gerado por `storage-size.mjs`)

| modelo | formato | bytes/trecho cru | binário após zlib | base64 (texto) cru | base64 após zlib | MB no git p/ 10 mil trechos (binário) | MB no git p/ 10 mil trechos (base64) |
|---|---|---:|---:|---:|---:|---:|---:|
| e5-small-q8 | float32 384d | 1536 | 1407 | 2049 | 1523 | 14.1 | 15.2 |
| e5-small-q8 | float16 384d | 768 | 690 | 1025 | 740 | 6.9 | 7.4 |
| e5-small-q8 | int8 384d | 384 | 369 | 513 | 385 | 3.7 | 3.9 |
| e5-small-q8 | int8 256d (truncado) | 256 | 248 | 345 | 258 | 2.5 | 2.6 |
| e5-small-q8 | binário 384d | 48 | 21 | 65 | 20 | 0.2 | 0.2 |
| granite97m-r2-q8 | float32 384d | 1536 | 1428 | 2049 | 1526 | 14.3 | 15.3 |
| granite97m-r2-q8 | float16 384d | 768 | 711 | 1025 | 752 | 7.1 | 7.5 |
| granite97m-r2-q8 | int8 384d | 384 | 245 | 513 | 311 | 2.4 | 3.1 |
| granite97m-r2-q8 | int8 256d (truncado) | 256 | 227 | 345 | 253 | 2.3 | 2.5 |
| granite97m-r2-q8 | binário 384d | 48 | 47 | 65 | 48 | 0.5 | 0.5 |
| gemma300m-q4 | float32 768d | 3072 | 2851 | 4097 | 3050 | 28.5 | 30.5 |
| gemma300m-q4 | float16 768d | 1536 | 1415 | 2049 | 1499 | 14.2 | 15.0 |
| gemma300m-q4 | int8 768d | 768 | 699 | 1025 | 761 | 7.0 | 7.6 |
| gemma300m-q4 | int8 256d (truncado) | 256 | 236 | 345 | 256 | 2.4 | 2.6 |
| gemma300m-q4 | binário 768d | 96 | 96 | 129 | 96 | 1.0 | 1.0 |
| gemma2-q4 | float32 768d | 3072 | 2856 | 4097 | 3050 | 28.6 | 30.5 |
| gemma2-q4 | float16 768d | 1536 | 1420 | 2049 | 1504 | 14.2 | 15.0 |
| gemma2-q4 | int8 768d | 768 | 563 | 1025 | 695 | 5.6 | 7.0 |
| gemma2-q4 | int8 256d (truncado) | 256 | 196 | 345 | 239 | 2.0 | 2.4 |
| gemma2-q4 | binário 768d | 96 | 95 | 129 | 94 | 0.9 | 0.9 |

---

# Apêndice D — Licença e gating (gerado por `gating.mjs`, API pública do Hugging Face)

| repositório | gated? | licença declarada | última modificação |
|---|---|---|---|
| Xenova/multilingual-e5-small | não | não declarada no card | 2025-07-22 |
| intfloat/multilingual-e5-small | não | mit | 2026-04-02 |
| Xenova/multilingual-e5-base | não | não declarada no card | 2025-07-22 |
| intfloat/multilingual-e5-base | não | mit | 2026-04-02 |
| Xenova/paraphrase-multilingual-MiniLM-L12-v2 | não | não declarada no card | 2025-07-22 |
| sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 | não | apache-2.0 | 2026-01-28 |
| Xenova/bge-m3 | não | mit | 2026-02-10 |
| BAAI/bge-m3 | não | mit | 2024-07-03 |
| onnx-community/embeddinggemma-300m-ONNX | não | gemma | 2025-09-04 |
| google/embeddinggemma-300m | SIM (manual) | gemma | 2025-09-25 |
| onnx-community/embeddinggemma-2-ONNX | não | apache-2.0 | 2026-10-06 |
| google/embeddinggemma-2 | não | apache-2.0 | 2026-10-28 |
| onnx-community/granite-embedding-97m-multilingual-r2-ONNX | não | apache-2.0 | 2026-06-21 |
| ibm-granite/granite-embedding-97m-multilingual-r2 | não | apache-2.0 | 2026-05-18 |
| ibm-granite/granite-embedding-311m-multilingual-r2 | não | apache-2.0 | 2026-05-18 |
| onnx-community/harrier-oss-v1-270m-ONNX | não | mit | 2026-04-10 |
| microsoft/harrier-oss-v1-270m | não | mit | 2026-03-30 |
| onnx-community/harrier-oss-v1-0.6b-ONNX | não | mit | 2026-04-10 |
| microsoft/harrier-oss-v1-0.6b | não | mit | 2026-03-30 |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | não | não declarada no card | 2026-04-03 |
| Qwen/Qwen3-Embedding-0.6B | não | apache-2.0 | 2026-04-20 |
| Snowflake/snowflake-arctic-embed-m-v2.0 | não | apache-2.0 | 2025-04-24 |
| Snowflake/snowflake-arctic-embed-l-v2.0 | não | apache-2.0 | 2025-07-28 |
| onnx-community/gte-multilingual-base | não | não declarada no card | 2024-10-08 |
| Alibaba-NLP/gte-multilingual-base | não | apache-2.0 | 2025-07-05 |
| netrias/nomic-embed-text-v2-moe-onnx | não | apache-2.0 | 2026-08-31 |
| nomic-ai/nomic-embed-text-v2-moe | não | apache-2.0 | 2025-04-01 |
| perplexity-ai/pplx-embed-v1-0.6b | não | mit | 2026-06-02 |
| jinaai/jina-embeddings-v5-text-nano-retrieval | não | cc-by-nc-4.0 | 2026-04-15 |
| jinaai/jina-embeddings-v5-text-nano | não | cc-by-nc-4.0 | 2026-04-15 |
| cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 | não | apache-2.0 | 2025-04-15 |
| onnx-community/gte-multilingual-reranker-base | não | não declarada no card | 2024-10-08 |
| Alibaba-NLP/gte-multilingual-reranker-base | não | apache-2.0 | 2025-07-05 |
| jinaai/jina-reranker-v2-base-multilingual | não | cc-by-nc-4.0 | 2025-10-21 |
| onnx-community/bge-reranker-v2-m3-ONNX | não | não declarada no card | 2025-09-01 |
| BAAI/bge-reranker-v2-m3 | não | apache-2.0 | 2024-06-24 |
| ggml-org/embeddinggemma-300M-GGUF | não | não declarada no card | 2026-04-29 |
| ggml-org/embeddinggemma-2-GGUF | não | apache-2.0 | 2026-11-01 |
| unsloth/embeddinggemma-2-GGUF | não | apache-2.0 | 2026-10-07 |
| mykor/granite-embedding-97m-multilingual-r2-GGUF | não | apache-2.0 | 2026-06-10 |
| jinaai/jina-embeddings-v3 | não | cc-by-nc-4.0 | 2026-04-08 |
| jinaai/jina-embeddings-v5-text-small | não | cc-by-nc-4.0 | 2026-04-15 |
| codefuse-ai/F2LLM-v2-80M | não | apache-2.0 | 2026-09-03 |
| ilyaplusplus/F2LLM-v2-80M-ONNX | HTTP 401 (privado, gated ou removido) | — | — |
| ibm-granite/granite-embedding-278m-multilingual | não | apache-2.0 | 2025-08-19 |

---

# Apêndice E — Runtimes: saídas brutas

## Tamanho instalado (`runtime/install-all.sh`, cache npm quente)

```
tjs-full | pacotes: @huggingface/transformers@4.3.2 | instalação: 5s | node_modules: 471 MB | maiores: node_modules/onnxruntime-node=288MB node_modules/onnxruntime-web=141MB node_modules/@img/sharp-libvips-darwin-arm64=18MB node_modules/@img=18MB 
ort-node-min | pacotes: onnxruntime-node@1.30.0 @huggingface/tokenizers | instalação: 3s | node_modules: 291 MB | maiores: node_modules/onnxruntime-node=288MB node_modules/onnxruntime-common=2MB node_modules/type-fest=1MB node_modules/serialize-error=1MB 
ort-web | pacotes: onnxruntime-web@1.31.1 @huggingface/tokenizers | instalação: 2s | node_modules: 154 MB | maiores: node_modules/onnxruntime-web=145MB node_modules/protobufjs=4MB node_modules/@types/node=3MB node_modules/@types=3MB 
llama | pacotes: node-llama-cpp@3.22.3 | instalação: 16s | node_modules: 75 MB | maiores: node_modules/node-llama-cpp=43MB node_modules/@node-llama-cpp/mac-arm64-metal=19MB node_modules/@node-llama-cpp=19MB node_modules/tar=3MB 
fastembed | pacotes: fastembed@3.0.0 | instalação: 11s | node_modules: 235 MB | maiores: node_modules/onnxruntime-node=208MB node_modules/@huggingface=11MB node_modules/@anush008/tokenizers-darwin-universal=9MB node_modules/@anush008=9MB
```

## Tarballs e instalação com cache frio (`runtime/cold-install.sh`)

```
## tarballs (download comprimido)
onnxruntime-node/-/onnxruntime-node-1.30.0.tgz                    113.5 MB
onnxruntime-web/-/onnxruntime-web-1.31.1.tgz                       34.6 MB
onnxruntime-common/-/onnxruntime-common-1.30.0.tgz                  0.1 MB
@huggingface/tokenizers/-/tokenizers-0.2.0.tgz                      0.1 MB
@huggingface/transformers/-/transformers-4.3.2.tgz                  2.3 MB
node-llama-cpp/-/node-llama-cpp-3.22.3.tgz                         37.4 MB
@node-llama-cpp/mac-arm64-metal/-/mac-arm64-metal-3.22.3.tgz        5.9 MB
@node-llama-cpp/linux-x64/-/linux-x64-3.22.3.tgz                   11.9 MB
@node-llama-cpp/win-x64/-/win-x64-3.22.3.tgz                       11.9 MB
## instalação com cache frio
onnxruntime-node@1.30.0 @huggingface/tokenizers       23s  node_modules  296 MB
onnxruntime-web@1.31.1 @huggingface/tokenizers        14s  node_modules  154 MB
node-llama-cpp@3.22.3                                 26s  node_modules   77 MB
@huggingface/transformers@4.3.2                       51s  node_modules  483 MB
```

## Benchmark dos runtimes (`runtime/bench-all.sh`)

```
_(arquivo runtime/bench-results.jsonl não gerado)_
```

