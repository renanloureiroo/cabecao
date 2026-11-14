---
title: Claude Desktop
description: Instale o Cabeção no Claude Desktop com o pacote .mcpb, com o servidor embutido e a pasta do cérebro escolhida na instalação.
sidebar_position: 11
---

O Claude Desktop instala servidores MCP locais por um **pacote `.mcpb`** (MCP Bundle): um arquivo que você abre com dois cliques. O pacote do Cabeção traz o servidor embutido, então não depende de `npx`, de `node_modules` nem de rede para subir.

## Antes de instalar

O pacote não cria o cérebro: ele só conecta o Claude Desktop a um cérebro que já existe. Crie (ou conecte esta máquina) antes:

```bash
npx cabecao init git@github.com:voce/meu-cerebro.git
```

## Instalar

1. Baixe `cabecao-<versão>.mcpb` na [página de versões do projeto](https://github.com/renanloureiroo/cabecao/releases).
2. Abra o arquivo com dois cliques, ou arraste-o para a janela do Claude Desktop, ou use **Settings → Extensions → Advanced settings → Install Extension**.
3. Na tela de configuração, escolha a **pasta do cérebro** (o padrão é `~/cabecao`).

O Claude Desktop passa a ter as 17 tools do Cabeção (`recall`, `search`, `remember`, `sync`...). As regras de uso chegam pelas instruções do servidor; não há hooks como no [plugin do Claude Code](./claude-code.md), então o sync acontece quando o agente chama a tool `sync`, quando você roda `cabecao sync` ou pelo [sync automático](./sync-automatico.md).

:::warning[Não testado no aplicativo]
O pacote é gerado a cada versão e conferido pelos testes do projeto (manifesto conforme a especificação MCPB 0.3, conteúdo conferido e o servidor sobe a partir do pacote extraído, como o aplicativo faria); o manifesto também já passou pela ferramenta oficial `mcpb validate`. A **instalação no Claude Desktop de verdade ainda não foi testada**. Se algo der errado, use o caminho abaixo e conte numa [issue](https://github.com/renanloureiroo/cabecao/issues).
:::

## O que vem no pacote

Só três coisas, cerca de 490 kB:

| Arquivo | O que é |
| --- | --- |
| `manifest.json` | O manifesto (especificação MCPB 0.3): nome, versão, as tools, a opção `brain_dir` do tipo pasta e o comando `node ${__dirname}/server/cabecao.mjs mcp`, com a pasta escolhida em `CABECAO_BRAIN` |
| `icon.png` | O ícone |
| `server/*.mjs` | O mesmo programa publicado no npm, sem dependências |

O servidor roda com o Node.js que o Claude Desktop traz. O Cabeção precisa do Node.js 22.16 ou mais novo: num Node mais antigo, o servidor não sobe e a mensagem diz isso. O git do sistema continua necessário para o sync.

## Atualizar

O pacote não se atualiza sozinho: baixe o `.mcpb` da versão nova e instale por cima. O cérebro não muda com isso; se a versão nova trouxer migração do esquema, rode `cabecao upgrade` (veja [Atualizar](./atualizar.md)).

## Sem o pacote

`cabecao install-client claude-desktop` grava o registro do servidor no `claude_desktop_config.json` do aplicativo, preservando o que já existe (veja [Conectar aos clientes de IA](../comecar/conectar-clientes.md)). Use um ou outro: os dois juntos registram o Cabeção duas vezes.
