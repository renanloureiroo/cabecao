# Contribuindo com o Cabeção

O projeto está na fase de **planejamento**. A melhor contribuição agora é discutir o desenho.

## Como ajudar hoje
- Leia a [documentação](docs/) e abra uma *issue* com dúvidas, furos ou sugestões.
- Os pontos ainda não validados estão listados em "Riscos a validar" no [roadmap](docs/10-roadmap.md). Experimentos que confirmem ou derrubem algum deles são muito bem-vindos.
- Mudanças de arquitetura entram por um **ADR** em [`docs/adr/`](docs/adr/) (copie o formato dos existentes).

## Convenções
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`feat:`, `fix:`, `docs:`, `chore:`...).
- **Idioma:** documentação em português (com versão em inglês planejada); código, identificadores e schema em inglês.
- **Código (quando existir):** TypeScript, pnpm, testes com Vitest. Todo PR precisa passar em lint, typecheck e testes.

## Segurança
Nunca inclua dados do seu cérebro pessoal em issues, PRs ou *fixtures*. Para relatar uma vulnerabilidade, use o recurso de *private vulnerability reporting* do GitHub em vez de uma issue pública.
