# Contribuindo com o Cabeção

O plano de arquitetura está **validado por provas de conceito**. A fundação do projeto existe (monorepo, CI e CLI mínima); as funcionalidades começam no marco 1. A melhor contribuição agora é discutir o desenho ou validar um dos pontos em aberto.

## Como ajudar hoje
- Leia a [documentação](docs/) e abra uma *issue* com dúvidas, furos ou sugestões.
- Os pontos ainda não validados estão em "O que ainda precisa de prova" no [roadmap](docs/10-roadmap.md). Testes que confirmem ou derrubem algum deles são muito bem-vindos, principalmente em provedores git reais.
- Mudanças de arquitetura entram como uma linha nova no [registro de decisões](docs/adr/README.md), com motivo e evidência.

## Convenções
- **Commits do projeto:** [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat:`, `fix:`, `docs:`, `chore:`...). Os commits que o Cabeção faz no repositório de um cérebro têm um [padrão próprio](docs/12-commits.md).
- **Idioma:** documentação em português (com versão em inglês planejada); código, identificadores e schema em inglês.
- **Código:** TypeScript estrito, pnpm, testes com Vitest, lint e formatação com Biome.
- **Antes de abrir um PR:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Os comandos estão em [13 · Desenvolvimento, CI e publicação](docs/13-publicacao.md).
- **Dados de teste:** use o cérebro de exemplo em [`fixtures/vault`](fixtures/README.md), que só tem dados inventados.

## Segurança
Nunca inclua dados do seu cérebro pessoal em issues, PRs ou *fixtures*. Para relatar uma vulnerabilidade, use o recurso de *private vulnerability reporting* do GitHub em vez de uma issue pública.
