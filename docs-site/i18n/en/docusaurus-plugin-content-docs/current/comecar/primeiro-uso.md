---
title: First use with an agent
description: What to ask the agent, what it saves and how that shows up in the next session.
sidebar_position: 4
---

With the server registered, you do not need to call any tool by hand. When the agent connects, the Cabeção MCP server gives it short instructions: call `recall` at the start of the task, search before claiming anything about your history, save what is durable and leave a handoff at the end. The brain's `AGENTS.md` says the same for anyone reading the files directly.

## An example session

You open Claude Code in a project and ask:

> Review the partial refund PR for the payments service. Remember that I prefer reviews in short bullet points, by severity. And note that these tests only pass with `TZ=UTC`.

An agent that follows the instructions makes the calls below. How many and which ones it makes depends on the model and on the request; the responses are the server's real ones (without the fixed `data_notice` notice, which comes with every read):

1. **The agent calls `recall`** with the task. In a new brain, the briefing comes back empty, with a session identifier:

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

2. **The agent saves with `remember`** what you asked it to remember. Each call becomes a note and a commit:

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

3. **At the end, the agent leaves a handoff** (`remember` with `type: handoff`): what it did, what is left and where it stopped.

The saved note is a regular Markdown file that you can open in any editor:

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

`origin: agent:claude-code` and `trust: medium` say who wrote it. See [Provenance and trust](../conceitos/proveniencia.md).

## In the next session

On another machine (after a `cabecao sync` on the first one), the same request brings everything back. This is the real `recall` from the second machine, with `scope: project:pagamentos`:

```json
{
  "handoff": {
    "path": "memory/handoffs/2026-11-13-revisao-do-pr-de-pagamentos.md",
    "title": "Revisão do PR de pagamentos",
    "content": "Revisei o PR de estorno parcial. Falta conferir o teste de arredondamento. Parei no arquivo `refund.ts`."
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

(Each item also includes `id`, `type`, `scope`, `validity`, `trust`, `origin` and `sources`; they were removed here to save space.)

## Check from the terminal

What the agent saved shows up in search and in the `undo` list:

```text
$ cabecao search "testes pagamento"
1 resultado(s) para "testes pagamento", com todos os termos (validade em 2026-11-13):

1. Testes de pagamento precisam do fuso fixo  [gotcha · project:pagamentos]  vigente
   memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md
   Os «testes» do serviço de pagamentos falham perto da meia-noite se o fuso não for fixo. Rode com `TZ=UTC npm test`.
```

```text
$ cabecao undo --list
Operações, da mais nova para a mais antiga (desfaça uma com "cabecao undo --op <id>"):

01M79DRR04ANKG57S1NNXWZD25  2026-11-13 00:03  add      claude-code @ notebook  sessão 01M79DRQR6B9HR9GVZZZQ2JBHJ
    add handoff: Revisão do PR de pagamentos
01M79DRQWEN8YYG3GSWM0N6B9H  2026-11-13 00:03  add      claude-code @ notebook  sessão 01M79DRQR6B9HR9GVZZZQ2JBHJ
    add preference: Revisão de PR em tópicos curtos
01M79DRQR9648E1JZ60MF0EBNN  2026-11-13 00:03  add      claude-code @ notebook  sessão 01M79DRQR6B9HR9GVZZZQ2JBHJ
    add gotcha: Testes de pagamento precisam do fuso fixo
```

Did not like something? `cabecao undo --session 01M79DRQR6B9HR9GVZZZQ2JBHJ` reverts everything that session saved, in a single commit. See [Undo](../guias/desfazer.md).

## What to ask

- "Remember that I prefer X." becomes a `preference`.
- "Note that this breaks when Y." becomes a `gotcha`.
- "Record that we decided Z, because W." becomes a `decision`.
- "Before you stop, leave a handoff." becomes a `handoff`, which the next `recall` brings first.
- "What did I decide about queues in March?" makes the agent search with `as_of`.

What is and is not worth saving is covered in [What to remember](../guias/o-que-lembrar.md).
