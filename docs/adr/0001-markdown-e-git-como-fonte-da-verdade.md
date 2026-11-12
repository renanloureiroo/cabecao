# ADR-0001 · Markdown + git como fonte da verdade

**Status:** Aceito · **Data:** 2026-11-12

## Contexto
Um segundo cérebro só é confiável se a pessoa consegue ver, corrigir e levar embora o que está guardado. Bancos de memória opacos dificultam as três coisas.

## Decisão
Todo conteúdo e todo conhecimento extraído ficam em arquivos Markdown com frontmatter YAML, num repositório git. Bancos e índices são construídos a partir desses arquivos.

## Consequências
- ✅ Legível no Obsidian ou em qualquer editor; portátil; histórico, *diff* e *rollback* de graça.
- ✅ Revisão de mudanças da IA por Pull Request.
- ❌ Escritas concorrentes exigem cuidado (escrita atômica, lock de git, tratamento de conflito).
- ❌ Não escala para milhões de documentos. O alvo é até dezenas de milhares de notas.

## Alternativas
- **Banco como fonte da verdade (Postgres, grafo):** melhor para consultas, pior para auditar e portar.
- **Banco + export para Markdown:** duas fontes da verdade que divergem.
