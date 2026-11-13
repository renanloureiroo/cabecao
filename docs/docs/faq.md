---
title: Perguntas frequentes
description: Respostas curtas às dúvidas mais comuns sobre o Cabeção.
---

## É um GraphRAG?

Não no sentido usual. Um GraphRAG costuma usar um modelo de linguagem para extrair entidades e relações de documentos e montar um grafo à parte. O Cabeção não usa modelo para montar o grafo: ele sai do que já está nas notas (wikilinks, relações tipadas no frontmatter, fatos, substituições e menções a títulos de outras notas), e as notas continuam sendo a fonte da verdade. Quem raciocina sobre a busca é o agente que você já usa; se quiser uma resposta pronta, com citações conferidas, ative o [`ask`](./guias/respostas-com-modelo.md), que é opcional.

## Preciso do GitHub?

Não. Qualquer remoto git serve: GitHub, GitLab, Bitbucket, Gitea, Codeberg, um servidor seu por SSH ou até uma pasta em outro disco. O Cabeção não usa a API de nenhum provedor, só o git. E dá para usar sem remoto nenhum, só na sua máquina.

## Meus dados vão para algum servidor?

Só para o remoto git que você configurou, quando você (ou um agente) roda o sync. O Cabeção não tem servidor próprio, conta nem telemetria. O que um agente lê do cérebro passa a fazer parte da conversa com o modelo de IA do seu cliente, como qualquer outro texto. Detalhes em [Segurança e privacidade](./seguranca.md).

A única exceção é opcional: se você ativar as [respostas com um modelo de linguagem](./guias/respostas-com-modelo.md) (`cabecao llm on`), cada `ask` manda trechos das notas ao provedor que você escolheu (ou a um servidor na sua máquina, como o Ollama). Vem desligado; notas com `private: true` e trechos com segredo nunca saem.

## Funciona sem o Obsidian?

Sim. O Obsidian é opcional: as notas são arquivos Markdown que qualquer editor abre, e os agentes usam o cérebro pelo MCP. O Obsidian só é um bom jeito de ler e navegar. Veja [Usar com o Obsidian](./guias/obsidian.md).

## O que quer dizer "beta"?

Que o Cabeção funciona e está publicado, mas ainda pode mudar antes da versão 1.0: comandos, campos e formatos podem ganhar ajustes, e pode haver bugs que os testes não pegaram. Os seus dados são sempre Markdown num repositório git seu, então nada fica preso. Instale com `cabecao@beta`, use um repositório privado e leia as [novidades](./novidades.md) ao atualizar.

## Quais clientes de IA funcionam?

Qualquer cliente que fale MCP por stdio. O `install-client` registra o servidor sozinho no Claude Code, Claude Desktop, Codex, Cursor, VS Code, Antigravity e Gemini CLI. Para outro cliente, `cabecao install-client --print` mostra a configuração para copiar.

## O agente vai encher o cérebro de bobagem?

Ele grava o que as instruções pedem (o durável e não óbvio) e o que você pedir. Tudo vira commit com a sessão marcada, então `cabecao undo --list` mostra o que entrou e `cabecao undo --session <id>` tira uma sessão inteira. Regras, só você cria. Veja [O que lembrar](./guias/o-que-lembrar.md).

## Posso usar o mesmo cérebro em vários projetos?

Sim. Use `scope: project:<nome>` no que só vale num projeto. Uma busca ou um `recall` com escopo de projeto traz o projeto e as notas globais.

## E se eu parar de usar o Cabeção?

Nada muda nas suas notas: elas são Markdown num repositório git. Tire o registro dos clientes com `cabecao install-client --remove --all` e apague a pasta `.cabecao/` e `~/.config/cabecao`. O resto é seu.

## Por que "Cabeção"?

É uma homenagem ao Cabeção de *Malhação*.
