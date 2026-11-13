---
title: Primeiro uso com um agente
description: O que pedir ao agente, o que ele grava e como isso aparece na próxima sessão.
sidebar_position: 4
---

Com o servidor registrado, você não precisa chamar nenhuma tool à mão. O servidor MCP do Cabeção entrega ao agente, na conexão, instruções curtas: chamar `recall` no começo da tarefa, buscar antes de afirmar algo sobre o seu histórico, gravar o que for durável e deixar um handoff no fim. O `AGENTS.md` do cérebro diz o mesmo para quem lê os arquivos direto.

## Uma sessão de exemplo

Você abre o Claude Code num projeto e pede:

> Revise o PR de estorno parcial do serviço de pagamentos. Lembre que eu prefiro revisões em tópicos curtos, por gravidade. E guarde que esses testes só passam com `TZ=UTC`.

Um agente que segue as instruções faz as chamadas abaixo. Quantas e quais ele faz depende do modelo e do pedido; as respostas são as reais do servidor, resumidas (sem o aviso fixo `data_notice`, que acompanha toda leitura, e sem alguns campos):

1. **O agente chama `recall`** com a tarefa. Num cérebro novo, o briefing vem vazio, com um identificador de sessão:

   ```json
   {
     "session_handle": "01M79DRQR6B9HR9GVZZZQ2JBHJ",
     "task": "revisar o PR do serviço de pagamentos",
     "rules": [],
     "handoff": null,
     "preferences": [],
     "gotchas": [],
     "memories": [],
     "used_tokens": 192,
     "truncated": false
   }
   ```

2. **O agente grava com `remember`** o que você pediu para lembrar. Cada chamada vira uma nota e um commit:

   ```json
   {
     "op": "01M79DRQR9648E1JZ60MF0EBNN",
     "path": "memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md",
     "id": "01M79DRQS4GV8HP3RTD5REZXQ0",
     "action": "add",
     "changed": true,
     "commit": "1af64e1dc48f5627dd086474c571b22326eaa3c0",
     "warnings": []
   }
   ```

3. **No fim, o agente deixa um handoff** (`handoff_save`): o que fez, o que falta, as decisões e as armadilhas.

A nota gravada é um arquivo Markdown comum, que você abre em qualquer editor:

```markdown
---
id: 01M79DRQS4GV8HP3RTD5REZXQ0
type: gotcha
title: Testes de pagamento precisam do fuso fixo
scope: project:pagamentos
tags: [pagamentos, testes]
sources: []
trust: medium
origin: agent:claude-code
created: 2026-11-13
updated: 2026-11-13
---
Os testes do serviço de pagamentos falham perto da meia-noite se o fuso não for fixo. Rode com `TZ=UTC npm test`.
```

`origin: agent:claude-code` e `trust: medium` dizem quem escreveu. Veja [Proveniência e confiança](../conceitos/proveniencia.md).

## Na próxima sessão

Em outra máquina (depois de um `cabecao sync` na primeira), o mesmo pedido traz tudo de volta. Este é o `recall` real da segunda máquina, com `scope: project:pagamentos`:

```json
{
  "handoff": {
    "path": "memory/handoffs/2026-11-13-revisao-do-pr-de-pagamentos.md",
    "title": "Revisão do PR de pagamentos",
    "content": "# Revisão do PR de pagamentos\n\n## Feito\n\n- Revisei o PR de estorno parcial\n\n## Próximo passo\n\n- Conferir o teste de arredondamento em `refund.ts`"
  },
  "preferences": [
    {
      "path": "memory/preferences/revisao-de-pr-em-topicos-curtos.md",
      "title": "Revisão de PR em tópicos curtos",
      "content": "Nas revisões de PR, prefiro uma lista curta de problemas por gravidade, sem elogios genéricos."
    }
  ],
  "gotchas": [
    {
      "path": "memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md",
      "title": "Testes de pagamento precisam do fuso fixo",
      "content": "Os testes do serviço de pagamentos falham perto da meia-noite se o fuso não for fixo. Rode com `TZ=UTC npm test`."
    }
  ],
  "used_tokens": 516,
  "truncated": false
}
```

(Cada item traz também `id`, `type`, `scope`, `validity`, `trust`, `origin`, `edited_by`, `sources` e `content_kind`, e a resposta traz também `session_handle`, `rules`, `memories` e outros campos; foram tirados aqui para caber.)

## Confira pelo terminal

O que o agente gravou aparece na busca e na lista do `undo`:

```text
$ cabecao search "testes pagamento"
1 resultado(s) para "testes pagamento", com todos os termos (validade em 2026-11-13):

1. Testes de pagamento precisam do fuso fixo  [gotcha · project:pagamentos]  vigente
   memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md
   Os «testes» do serviço de pagamentos falham perto da meia-noite se o fuso não for fixo. Rode com `TZ=UTC npm test`.

Modo: keyword (a busca por significado não está ativada neste cérebro ("cabecao embeddings on" ativa)).
```

```text
$ cabecao undo --list
Operações, da mais nova para a mais antiga (desfaça uma com "cabecao undo --op <id>"):

01M79DRR04ANKG57S1NNXWZD25  2026-11-13 00:03  add      claude-code @ notebook  sessão 01M79DRQR6B9HR9GVZZZQ2JBHJ
    add episode: Sessão: Revisei o PR de estorno parcial
    add handoff: Revisão do PR de pagamentos
01M79DRQWEN8YYG3GSWM0N6B9H  2026-11-13 00:03  add      claude-code @ notebook  sessão 01M79DRQR6B9HR9GVZZZQ2JBHJ
    add preference: Revisão de PR em tópicos curtos
01M79DRQR9648E1JZ60MF0EBNN  2026-11-13 00:03  add      claude-code @ notebook  sessão 01M79DRQR6B9HR9GVZZZQ2JBHJ
    add gotcha: Testes de pagamento precisam do fuso fixo
```

Não gostou de algo? `cabecao undo --session 01M79DRQR6B9HR9GVZZZQ2JBHJ` desfaz tudo o que essa sessão gravou, num commit só. Veja [Desfazer](../guias/desfazer.md).

## O que pedir

- "Lembre que eu prefiro X." vira uma `preference`.
- "Anote que isso quebra quando Y." vira um `gotcha`.
- "Registre que decidimos Z, porque W." vira uma `decision`.
- "Antes de parar, deixe um handoff." vira um `handoff`, que o próximo `recall` traz primeiro.
- "O que eu decidi sobre filas em março?" faz o agente buscar com `as_of`.

O que vale e o que não vale a pena guardar está em [O que lembrar](../guias/o-que-lembrar.md).
