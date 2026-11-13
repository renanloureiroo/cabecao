# Contribuindo com o Cabeção

O Cabeção está em beta e publicado no npm (`cabecao@beta`). O que ele faz hoje, e o que vem em breve, está no [site de documentação](https://renanloureiroo.github.io/cabecao/). A melhor contribuição agora é usar e relatar o que encontrar, principalmente com provedores git reais e clientes MCP reais.

## Como ajudar hoje
- Leia a [documentação](https://renanloureiroo.github.io/cabecao/) e abra uma *issue* com dúvidas, bugs ou sugestões. Inclua a saída de `cabecao doctor --offline`.
- Relatos de uso com provedores git (GitHub, GitLab, Bitbucket, Gitea, servidor próprio) e com clientes MCP reais são muito bem-vindos.
- Para uma mudança grande, abra uma *issue* antes do PR para combinar o desenho.

## Convenções
- **Commits do projeto:** [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat:`, `fix:`, `docs:`, `chore:`...). Os commits que o Cabeção faz no repositório de um cérebro têm um [padrão próprio](https://renanloureiroo.github.io/cabecao/conceitos/commits-e-undo/).
- **Idioma:** documentação em português, com a versão em inglês no mesmo site (`website/src/content/docs/en/`); código, identificadores e schema em inglês.
- **Código:** TypeScript estrito, pnpm, testes com Vitest, lint e formatação com Biome.
- **Antes de abrir um PR:** `pnpm install`, depois `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm smoke && pnpm e2e`.
- **Site de documentação:** fica em `website/` (Astro Starlight). `pnpm docs:dev` abre o site localmente e `pnpm docs:build` constrói e confere os links. Mudou um comando ou uma tool? Atualize a página nos dois idiomas.
- **Dados de teste:** use o cérebro de exemplo em [`fixtures/vault`](fixtures/README.md), que só tem dados inventados.

## Segurança
Nunca inclua dados do seu cérebro pessoal em issues, PRs ou *fixtures*. Para relatar uma vulnerabilidade, use o recurso de *private vulnerability reporting* do GitHub em vez de uma issue pública.
