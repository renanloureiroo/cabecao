# ADR-0008 · Identificadores do schema em inglês

**Status:** Aceito · **Data:** 2026-11-12

## Contexto
O primeiro rascunho misturava idiomas: pastas `wiki/conceitos` ao lado de `memory/rules`, tipos `decisao` ao lado de `rule`, e duas pastas para decisões (`wiki/decisoes` e `memory/decisions`). O projeto é público e as tools do MCP já são em inglês.

## Decisão
- Pastas, tipos, campos do frontmatter, valores de enum e nomes de tools são em **inglês**.
- O **conteúdo** das notas, o `AGENTS.md` do cérebro e a documentação do projeto ficam no idioma de quem usa (português primeiro).
- Decisões ficam só em `wiki/decisions/`.

## Consequências
- ✅ Um schema único para qualquer público; sem tradução de identificadores no código.
- ❌ Usuários brasileiros veem nomes de pasta em inglês no Obsidian.

## Alternativas
- **Tudo em português:** coerente com o nome do projeto, mas limita a adoção.
- **Nomes de pasta configuráveis por idioma:** possível no futuro via `config.json`, com custo de complexidade em toda a base.
