---
id: 01KSH5AGAR6STM5C8SBZW0QH8K
type: procedure
title: Publicar nova versão do Atlas
scope: project:atlas
tags: [release]
sources: []
trust: high
origin: human
created: 2026-04-02
updated: 2026-09-05
confirmed: 2026-09-05
part_of: ["[[Projeto Atlas]]"]
depends_on: ["[[testes-de-integracao-sem-limpar-o-banco]]"]
---
# Publicar nova versão do Atlas

1. Limpe o banco e rode os testes de integração. Veja [[testes-de-integracao-sem-limpar-o-banco]].
2. Atualize o changelog.
3. Crie a tag `vX.Y.Z` e envie.
4. Avise [[Bruno Tavares]], que acompanha a publicação.
