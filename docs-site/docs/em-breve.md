---
title: Em breve
description: O que está em desenvolvimento e ainda não existe na versão publicada.
---

:::note[Nada desta página existe ainda]
Os recursos abaixo estão em desenvolvimento ou planejados. Eles não estão na versão `0.1.0-beta.1` e podem mudar de forma, de nome ou de ordem antes de chegar. Quando chegarem, entram nas [novidades](./novidades.md) e na referência.
:::

## Em desenvolvimento

### Busca por significado

Hoje a busca é por palavra-chave: ela acha "fila", não "mensageria". A busca por significado vai achar notas pelo assunto, com um modelo de embeddings que roda **na sua máquina**: nada é enviado a um serviço externo. Ela vai ser opcional e desligada por padrão, e o modelo só vai ser baixado quando você a ligar. A escolha do modelo vai ficar no `.cabecao.json` (o campo `embedding`, hoje reservado), para valer em todas as máquinas do cérebro, e os vetores calculados vão viajar pelo git, para uma máquina não recalcular o que outra já calculou.

### Compactação do índice

Um comando para compactar o índice da busca por significado que viaja pelo git, removendo o que não serve mais, para o repositório não crescer sem necessidade.

### Avaliação da busca

Um comando para medir a qualidade da busca no seu próprio cérebro, com as suas perguntas, útil para comparar modelos de embeddings.

## Planejado

- **Plugin do Claude Code**, com hooks que chamam o `recall` no começo da sessão e lembram do handoff no fim, sem depender de o modelo seguir as instruções.
- **Revisão do cérebro (lint)**: links quebrados, menções que poderiam virar links, notas vencidas que ninguém substituiu, memórias repetidas.
- **Consolidação**: juntar memórias parecidas e propor sínteses, sempre como sugestão revisável.
- **Esquecer**: tirar uma memória de circulação, movendo-a para `memory/_archive/`, de forma reversível.
- **Integração com o Obsidian**: configuração do vault e painéis prontos em `dashboards/`.
- **Pacote para o Claude Desktop**, para instalar o servidor com um clique.

Quer acompanhar ou opinar? Abra uma [issue](https://github.com/renanloureiroo/cabecao/issues).
