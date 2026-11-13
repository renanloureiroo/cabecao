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
| Where the session stopped | `handoff` | "Three consumers left; start with the billing one." |

## Not worth remembering

- **What is already in the code, in git, or in the documentation.** The agent reads it at the source, which is always up to date.
- **Details that only matter to the current conversation.**
- **Secrets.** Passwords, tokens, keys, the contents of a `.env`. Never, not even summarized. Cabeção blocks the known formats (see [Security](../seguranca.md)), but it does not recognize everything.
- **Other people's personal data** without a need for it.

## Habits that help

- **Ask for a handoff at the end.** "Before you stop, leave a handoff" makes the next session start where this one stopped. Give it an `expires_at`, because a stale handoff only confuses.
- **Search before writing.** A repeated memory, worded differently, splits the agent's attention. The server instructions already ask for this; reinforce it if you notice repetition.
- **Do not delete what changed: supersede it.** When a decision changes, the new note carries `supersedes: ["[[decisão-antiga]]"]`. The old one stays there, expired, and answers questions about the past with `--as-of`.
- **Use project scope.** What only applies to one project goes with `scope: project:<nome>`, so it does not show up in the others.
- **Review now and then.** `cabecao undo --list` shows what agents wrote. Undo or fix whatever is wrong.
- **Rules are few and yours.** See [Create rules](./regras.md).
