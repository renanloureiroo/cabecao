# Contribuindo com o Cabeção

O plano de arquitetura está **validado por provas de conceito**. O marco 1 (núcleo: `init`, `sync`, busca por palavra-chave, servidor MCP com 9 tools e CLI com 8 comandos) está **implementado e em revisão**, na branch `feat/m1-nucleo`; nada foi publicado no npm ainda. Busca por significado, grafo, plugin e o resto vêm nos marcos seguintes. A melhor contribuição agora é validar os pontos em aberto, principalmente com provedores git reais e clientes MCP reais, ou discutir o desenho.

## Como ajudar hoje
- Abra uma *issue* com dúvidas, problemas ou sugestões.

## Convenções
- **Commits do projeto:** [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat:`, `fix:`, `docs:`, `chore:`...). Os commits que o Cabeção faz no repositório de um cérebro têm um padrão próprio.
- **Idioma:** documentação em português (com versão em inglês planejada); código, identificadores e schema em inglês.
- **Código:** TypeScript estrito, pnpm, testes com Vitest, lint e formatação com Biome.
- **Changeset:** PR que muda o produto leva um changeset (`pnpm changeset`, marcando o pacote `cabecao`); é ele que gera a versão nova e a entrada no changelog. O fluxo está em 13 · Publicar no npm.
- **Antes de abrir um PR:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`. Os comandos estão em 13 · Desenvolvimento, CI e publicação.
- **Dados de teste:** use o cérebro de exemplo em [`fixtures/vault`](fixtures/README.md), que só tem dados inventados.

## Segurança
Nunca inclua dados do seu cérebro pessoal em issues, PRs ou *fixtures*. Para relatar uma vulnerabilidade, use o recurso de *private vulnerability reporting* do GitHub em vez de uma issue pública.
