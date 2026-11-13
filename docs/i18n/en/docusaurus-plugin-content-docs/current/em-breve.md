---
title: Coming soon
description: What is in development and does not exist yet in the published version.
---

:::note[Nothing on this page exists yet]
The features below are in development or planned. They are not in version `0.1.0-beta.1` and may change shape, name, or order before they arrive. When they arrive, they go into the [release notes](./novidades.md) and the reference.
:::

## In development

### Semantic search

Today, search is by keyword: it finds "queue", not "messaging". Semantic search will find notes by topic, with an embeddings model that runs **on your machine**: nothing is sent to an external service. It will be optional and off by default, and the model will only be downloaded when you turn it on. The model choice will live in `.cabecao.json` (the `embedding` field, reserved today), so it applies to every machine of the brain, and the computed vectors will travel through git, so one machine does not recompute what another already computed. You will be able to choose keyword search, search by meaning, or both combined.

### Index compaction

A command to compact the semantic search index that travels through git, removing what is no longer needed, so the repository does not grow unnecessarily.

### Search evaluation

A command to measure search quality on your own brain, with your own questions, useful for comparing embeddings models.

## Planned

- **Scheduled consolidation**: run the consolidation with a non-interactive agent, without you opening a session. Today it is prepared and closed by `cabecao consolidate`, and an agent in a session of yours does the work.
- **Delete for good** (`cabecao purge`): remove a note from the git history, for the rare case of something that should never have been there. Today `forget` archives, and the archived note stays in git.
- **Graph explorer inside Claude**, to browse notes and relations in a window of the conversation.

Want to follow along or share your opinion? Open an [issue](https://github.com/renanloureiroo/cabecao/issues).
