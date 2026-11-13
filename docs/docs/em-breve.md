---
title: Em breve
description: O que está planejado ou em estudo e ainda não existe no Cabeção.
---

:::note[Nada desta página existe ainda]
Os itens abaixo estão planejados ou em estudo. Eles podem mudar de forma, de nome ou de ordem antes de chegar. Quando chegarem, entram nas [novidades](./novidades.md) e na referência.
:::

## Em estudo

Estas mudanças de experiência já foram avaliadas, mas dependem de uma decisão antes de entrar:

- **Adotar um vault do Obsidian no lugar onde ele está**, sem clonar numa pasta nova, inclusive uma pasta que ainda não é um repositório git. Hoje o `init` clona o vault numa pasta nova, e você abre essa pasta no Obsidian (veja [Adotar um vault existente](./guias/adotar-vault.md)).
- **O plugin como caminho padrão no Claude Code**, instalado pelo próprio `init` quando o Claude Code existe na máquina. Hoje o `init` registra o servidor MCP direto, e o plugin é instalado à parte.
- **O sync automático ligado pelo `init`**. Hoje ele só aparece entre os opcionais do fim do `init`, do `status` e do `doctor` (`cabecao schedule on`).
- **Um `cabecao setup`**: uma lista do que está ligado e do que falta (skills, sync automático, busca por significado, Obsidian), com uma pergunta só para aplicar o recomendado.
- **Mensagens da CLI em inglês**, escolhidas pelo idioma do sistema. Hoje a CLI fala português; o site e os READMEs têm as duas línguas.
- **A versão mais nova no `npm i -g cabecao` sem etiqueta**. Hoje use `cabecao@beta`; a CLI já sugere o comando com a etiqueta certa.

## Planejado

- **Autocompletar no shell** (`cabecao completion bash|zsh|fish|powershell`).
- **Consolidação agendada pelo próprio Cabeção**: o `cabecao consolidate --run` já chama um agente sozinho, mas o `cabecao schedule` só agenda o sync; hoje, agendar a consolidação é com o agendador do sistema (veja [Consolidar com um agente](./guias/consolidar-com-agente.md#agendar)).
- **Mais agentes no `consolidate --run`**: o GitHub Copilot CLI e o OpenCode têm opções para restringir as tools, mas ainda não foram testados.
- **Apagar de vez** (`cabecao purge`): tirar uma nota do histórico do git, para o caso raro de algo que não podia estar lá. Hoje o `forget` arquiva, e o arquivado continua no git.
- **Explorador do grafo dentro do Claude**, para navegar pelas notas e relações numa janela da conversa.

Quer acompanhar ou opinar? Abra uma [issue](https://github.com/renanloureiroo/cabecao/issues).
