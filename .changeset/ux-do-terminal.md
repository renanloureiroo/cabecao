---
"cabecao": minor
---

O terminal ficou mais agradável de usar. O `init` abre com o símbolo do Cabeção na cor da marca e mostra cada passo numa linha, que termina em `✓` com o resultado; o resumo final ficou mais curto. As perguntas (`llm on`, `embeddings on`, `uninstall`, `forget`, `upgrade`) viraram listas para escolher com as setas, com uma dica curta ao lado de cada opção; no `llm on`, o aviso do que sai da máquina cabe em quatro linhas, com o texto completo a um Enter de distância. Cor e animação só aparecem quando a saída é um terminal: num pipe, com `--json`, para um agente, com `NO_COLOR` ou `TERM=dumb`, tudo continua em texto puro e as perguntas voltam a ser de uma linha. A ajuda (`--help`) segue sem cor.

A versão do Node agora é dita como "22.16 ou mais novo" em todo lugar (a faixa aceita não mudou; na linha 23, a mensagem explica por que ela não serve).
