# Contribuindo com o Cabeção

O plano de arquitetura está **validado por provas de conceito** e o código ainda não foi escrito. A melhor contribuição agora é discutir o desenho ou validar um dos pontos em aberto.

## Como ajudar hoje
- Leia a [documentação](docs/) e abra uma *issue* com dúvidas, furos ou sugestões.
- Os pontos ainda não validados estão em "O que ainda precisa de prova" no [roadmap](docs/10-roadmap.md). Testes que confirmem ou derrubem algum deles são muito bem-vindos, principalmente em provedores git reais.
- Mudanças de arquitetura entram como uma linha nova no [registro de decisões](docs/adr/README.md), com motivo e evidência.

## Convenções
- **Commits do projeto:** [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat:`, `fix:`, `docs:`, `chore:`...). Os commits que o Cabeção faz no repositório de um cérebro têm um [padrão próprio](docs/12-commits.md).
- **Idioma:** documentação em português (com versão em inglês planejada); código, identificadores e schema em inglês.
- **Código:** TypeScript estrito, pnpm, testes com Vitest, lint e formatação com Biome.

## Segurança
Nunca inclua dados do seu cérebro pessoal em issues, PRs ou *fixtures*. Para relatar uma vulnerabilidade, use o recurso de *private vulnerability reporting* do GitHub em vez de uma issue pública.
