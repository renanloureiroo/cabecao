# ADR-0005 · Sincronizar derivados pelo git

**Status:** Aceito, a validar no spike · **Data:** 2026-11-12

## Contexto
Requisito do projeto: índices, embeddings e grafo não podem ser tratados como descartáveis. Ao sincronizar, uma máquina deve receber o que as outras já calcularam.

O obstáculo é que o índice de consulta é um arquivo SQLite binário, que não se mescla e incha o histórico do git.

## Decisão
Separar os dados em camadas e sincronizar cada uma do jeito que o git aguenta:

1. **Conhecimento extraído por LLM** (entidades, relações, fatos, resumos) é gravado como **Markdown**. Sincroniza como conteúdo.
2. **Embeddings** vão para shards JSONL endereçados por conteúdo, *append-only*, com `merge=union`.
3. **Grafo** é exportado em JSONL ordenado, com um *merge driver* que o regenera em caso de conflito.
4. **O SQLite** é reconstruído de forma incremental a partir dos três itens acima, o que leva segundos porque nada caro é recalculado. Snapshots opcionais cobrem cérebros grandes.

## Consequências
- ✅ Nenhuma máquina recalcula embedding nem refaz extração de LLM.
- ✅ Um único mecanismo de sync (git) e um único lugar de backup.
- ❌ O repositório cresce com os vetores; exige `compact` e medição.
- ❌ Dois commits por sync (conteúdo e derivados) poluem o histórico.
- ❌ *Merge drivers* dependem de configuração local do git.

## Alternativas
- **Não versionar derivados e recalcular em cada máquina:** mais simples, mas contraria o requisito e custa caro com modelos maiores.
- **Commitar o SQLite (com ou sem LFS):** conflitos insolúveis e histórico gigante.
- **Sincronizar derivados por outro canal (Release assets, S3, rsync):** mantém o git limpo, mas cria um segundo mecanismo de sync para instalar e manter. Fica como plano B.
- **Branch órfã só para embeddings:** plano B se o crescimento do histórico for alto.
