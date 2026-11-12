# ADR-0002 · TypeScript e Node.js

**Status:** Aceito · **Data:** 2026-11-12

## Contexto
O requisito de instalação é "um comando". O SDK de MCP precisa suportar a especificação 2026-07-28.

## Decisão
TypeScript sobre Node.js ≥ 22, monorepo pnpm, distribuído pelo npm (`npx cabecao`).

## Consequências
- ✅ O SDK TypeScript do MCP é Tier 1 e já suporta a 2026-07-28.
- ✅ `npx` instala sem passo manual; o mesmo pacote serve o plugin do Claude Code e o bundle MCPB.
- ✅ `transformers.js` roda embeddings localmente sem Python.
- ❌ Dependências nativas (`better-sqlite3`, `sqlite-vec`) precisam de binários prontos por plataforma. É um risco a validar no spike.

## Alternativas
- **Python:** ecossistema de ML mais rico, mas instalação mais frágil para o usuário final.
- **Rust/Go (binário único):** instalação excelente, porém desenvolvimento mais lento e SDK de MCP menos maduro em Rust.
