# ADR-0004 · Embeddings locais por padrão

**Status:** Aceito, a validar no spike · **Data:** 2026-11-12

## Contexto
O cérebro guarda informação pessoal. Enviar todo o conteúdo para uma API de embeddings contraria o princípio local-first e exige chave de API na instalação.

## Decisão
O provedor padrão roda na máquina com `transformers.js` e um modelo multilíngue pequeno (família *multilingual-e5*). Ollama e APIs são provedores opcionais, e APIs exigem ativação explícita.

## Consequências
- ✅ Funciona offline e sem chave; nada sai da máquina.
- ✅ Vetores pequenos (384 dimensões) barateiam a sincronização.
- ❌ Qualidade inferior à de modelos grandes; a medir com `cabecao eval` em português.
- ❌ Download do modelo na primeira execução. A busca por palavra-chave funciona enquanto isso.
- Trocar de modelo gera um conjunto novo de embeddings; os dois convivem durante a troca.

## Alternativas
- **Ollama como padrão:** melhor qualidade, mas adiciona um pré-requisito de instalação.
- **API como padrão:** melhor qualidade e zero CPU, mas quebra privacidade e instalação simples.
