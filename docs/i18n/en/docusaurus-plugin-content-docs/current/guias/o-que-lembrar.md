---
title: What to remember (and what not to)
description: Good practices for a brain that helps instead of getting in the way.
sidebar_position: 8
---

A useful brain is small and reliable. Each memory takes up room in the `recall` briefing and can mislead an agent if it is wrong or stale. The brain's `AGENTS.md` passes these guidelines to agents; they apply to you too.

## Worth remembering

| What | Type | Example |
| --- | --- | --- |
| A preference of yours | `preference` | "I prefer PR reviews in short bullet points, by severity." |
| A correction you made to the agent | `preference` or `gotcha` | "In this project, tests run with `pnpm test`, not `npm test`." |
| A decision **and the why** | `decision` | "We moved to SQS because of operating cost; our own queue took 6 hours a month." |
| A gotcha you discovered | `gotcha` | "Integration tests fail if the local database is not cleaned first." |
| A step-by-step that repeats | `procedure` | "How to publish a new version." |
| A fact that changes over time, with the date | `fact` | "Bruno has led Atlas since 2026-09-01." |
| Where the session stopped | `handoff`, with the `handoff_save` tool | "Three consumers left; start with the billing one." |
| An outside source (article, meeting notes) | in `raw/`, with `ingest` | "The article on queue costs on AWS." |

## Not worth remembering

- **What is already in the code, in git, or in the documentation.** The agent reads it at the source, which is always up to date.
- **Details that only matter to the current conversation.**
- **Secrets.** Passwords, tokens, keys, the contents of a `.env`. Never, not even summarized. Cabeção blocks the known formats (see [Security](../seguranca.md)), but it does not recognize everything.
- **Other people's personal data** without a need for it.

## Habits that help

- **Ask for a handoff at the end.** "Before you stop, leave a handoff" makes the agent call `handoff_save`, and the next session starts where this one stopped. The handoff is valid for 30 days (`expires_at`) and the next one for the same project supersedes the previous one, because a stale handoff only confuses.
- **Let `remember` handle repetition.** Before writing, it looks for similar memories in the same scope and type: the same one is not written again, one that adds updates the existing one, and a fact that changed supersedes the old one, which stays in history. When the rule cannot decide, the agent gets the candidates and chooses. Still, ask for a search before saving something important.
- **Run `lint` now and then.** [`cabecao lint`](../referencia/cli.md#cabecao-lint) points out facts that contradict each other, broken links, memories nobody confirmed for months, and expired notes. For old memories: confirm the ones that hold (`confirmed` with today's date) and forget the ones that do not with [`cabecao forget`](../referencia/cli.md#cabecao-forget). An old memory never confirmed already loses weight in search.
- **Do not delete what changed: supersede it.** When a decision changes, the new note carries `supersedes: ["[[decisão-antiga]]"]`. The old one stays there, expired, and answers questions about the past with `--as-of`.
- **Use project scope.** What only applies to one project goes with `scope: project:<nome>`, so it does not show up in the others.
- **Review now and then.** `cabecao undo --list` shows what agents wrote. Undo or fix whatever is wrong.
- **Rules are few and yours.** See [Create rules](./regras.md).
