---
title: Create rules
description: Rules are instructions every agent follows. Only you create them; here is how to write one.
sidebar:
  order: 6
---

A rule is a `type: rule` note in `memory/rules/`. It comes first in the `recall` of every task, above preferences and memories, and only your instruction of the moment outranks it.

## Only you create them

An agent cannot write a rule. If it tries, it gets:

```json
{
  "error": {
    "code": "rule_requires_human",
    "message": "regras (type: rule) só o usuário cria e altera; um agente não pode gravá-las",
    "next_step": "Grave como preferência (type: preference) ou proponha a regra ao usuário; ele a cria com a CLI ou no Obsidian."
  }
}
```

This protects you from a malicious note or a confused agent trying to change the behavior of all the others. An agent can **propose** a rule: it writes it as a synthesis in `wiki/syntheses/` and you decide.

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
- `origin: human`: without it, the note does not enter `recall` as a rule. It is your signature;
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

Edit the file. To retire it without erasing history, add `valid_until: AAAA-MM-DD` or write a new rule with `supersedes: ["[[regra-antiga]]"]`. An agent note that claims to supersede your rule does not bring it down: only another rule of yours does that.
