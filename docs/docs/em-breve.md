---
title: Em breve
description: O que está em desenvolvimento e ainda não existe na versão publicada.
---

:::note[Nada desta página existe ainda]
Os recursos abaixo estão em desenvolvimento ou planejados. Eles não estão na versão `0.1.0-beta.1` e podem mudar de forma, de nome ou de ordem antes de chegar. Quando chegarem, entram nas [novidades](./novidades.md) e na referência.
:::

## Em desenvolvimento

### Busca por significado

Hoje a busca é por palavra-chave: ela acha "fila", não "mensageria". A busca por significado vai achar notas pelo assunto, com um modelo de embeddings que roda **na sua máquina**: nada é enviado a um serviço externo. Ela vai ser opcional e desligada por padrão, e o modelo só vai ser baixado quando você a ligar. A escolha do modelo vai ficar no `.cabecao.json` (o campo `embedding`, hoje reservado), para valer em todas as máquinas do cérebro, e os vetores calculados vão viajar pelo git, para uma máquina não recalcular o que outra já calculou. Você vai poder escolher entre a busca por palavra-chave, a por significado ou as duas combinadas.

### Compactação do índice

Um comando para compactar o índice da busca por significado que viaja pelo git, removendo o que não serve mais, para o repositório não crescer sem necessidade.

### Avaliação da busca

Um comando para medir a qualidade da busca no seu próprio cérebro, com as suas perguntas, útil para comparar modelos de embeddings.

## Planejado

- **Consolidação agendada pelo próprio Cabeção**: o `cabecao consolidate --run` já chama um agente sozinho, mas o `cabecao schedule` só agenda o sync; hoje, agendar a consolidação é com o agendador do sistema (veja [Consolidar com um agente](./guias/consolidar-com-agente.md#agendar)).
- **Mais agentes no `consolidate --run`**: o GitHub Copilot CLI e o OpenCode têm opções para restringir as tools, mas ainda não foram testados.
- **Apagar de vez** (`cabecao purge`): tirar uma nota do histórico do git, para o caso raro de algo que não podia estar lá. Hoje o `forget` arquiva, e o arquivado continua no git.
- **Explorador do grafo dentro do Claude**, para navegar pelas notas e relações numa janela da conversa.
- **Mais do provedor de respostas** (o [`ask`](./guias/respostas-com-modelo.md) já chega na próxima versão): resumos por tema e ajuda na consolidação escritos pelo provedor, sempre com as mesmas restrições de um agente; um modelo que rode embutido, sem servidor; e busca por significado com o Ollama.

Quer acompanhar ou opinar? Abra uma [issue](https://github.com/renanloureiroo/cabecao/issues).
