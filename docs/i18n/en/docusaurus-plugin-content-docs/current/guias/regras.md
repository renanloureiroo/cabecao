---
title: Create rules
description: Rules are instructions every agent follows. You create them, or ask an agent and confirm; here is how.
sidebar_position: 6
---

A rule is a `type: rule` note in `memory/rules/`. It comes first in the `recall` of every task, above preferences and memories, and only your instruction of the moment outranks it.

## Only with your request

An agent only saves a rule when you ask, and with confirmation. Without it, the first call saves nothing and returns the summary and a confirmation token:

```json
{
  "decision": "needs_confirmation",
  "status": "confirmation_required",
  "summary": "Criar (ou atualizar, se já houver uma parecida) a REGRA \"Testes antes do push\" em memory/rules/, escopo global. Conteúdo (34 caracteres): \"Rode os testes antes de cada push.\".",
  "confirm_token": "cbc_ct_...",
  "next_step": "Isto exige pedido explícito do usuário. Mostre o resumo (summary) ao usuário e pergunte; só repita a chamada de remember com os mesmos argumentos e confirm_token se ele disser sim, em até 5 minutos. ..."
}
```

The agent shows the summary and asks; it only repeats the call with the token if you say yes. In a client that can ask (elicitation), the server itself asks you. A rule saved this way gets `origin: agent:<client>`, `approved_by: user`, and `approved_at`, and shows up in `cabecao lint` (rule `agent_approved`) for you to review.

This protects you from a malicious note or an ingested source trying to make an agent change the behavior of all the others: a request that came from content that was read is not your request, and the response tells the agent so. **The token proves the action was intentional and is the one shown, not that you said yes**: in a client without elicitation, the one claiming it is the agent. So check `lint` now and then, and undo with `cabecao undo` what you did not ask for.

From the CLI, at your terminal, `cabecao remember --type rule` asks and you confirm by typing; see [Who is human and who is an agent in the CLI](./humano-e-agente.md).

## Write a rule

Create a file in `memory/rules/`, in Obsidian or any editor:

```markdown title="memory/rules/commits-em-portugues.md"
---
type: rule
title: Commits em português
scope: global
origin: human
---
Escreva mensagens de commit em português, no imperativo.
```

The fields that matter:

- `type: rule`;
- `origin: human`: without it (or without the approval mark of a rule an agent saved at your request), the note does not enter `recall` as a rule. It is your signature;
- `scope`: `global` to apply everywhere, or `project:<nome>` for one project;
- `title`: short, so you can find it later.

The `id` is optional in a hand-written note; without it, Cabeção identifies the note by its path.

Run `cabecao sync` to carry the rule to the other machines. On the same machine, it already applies on the next `recall`, without a sync. This is the real `recall` right after saving the file above:

```json
{
  "rules": [
    {
      "id": "path:memory/rules/commits-em-portugues.md",
      "path": "memory/rules/commits-em-portugues.md",
      "type": "rule",
      "title": "Commits em português",
      "scope": "global",
      "validity": "current",
      "trust": null,
      "origin": "human",
      "edited_by": null,
      "sources": [],
      "content_kind": "note",
      "content": "Escreva mensagens de commit em português, no imperativo."
    }
  ]
}
```

(Only the rules section; the rest of the briefing was omitted.)

## Good rules

- **One rule per note.** It is easy to find, change, and undo.
- **Imperative and concrete.** "Run `make db-reset` before the integration tests" is better than "take care of the database".
- **Only what always applies.** Personal taste that allows exceptions is a preference (`type: preference`); let agents write those.
- **Few of them.** Every current rule enters every `recall` and takes up room in the briefing's token budget.

## Change or retire a rule

Edit the file. To retire it without erasing history, add `valid_until: AAAA-MM-DD` or write a new rule with `supersedes: ["[[regra-antiga]]"]`. An agent note that claims to supersede your rule does not bring it down: only another rule of yours (or one you approved) does that.
