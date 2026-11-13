---
title: Security and privacy
description: Where your data goes, how the secret scanner works, what an agent is prevented from doing, and the known limits.
---

## Your data stays with you

- Notes live in a folder on your machine and in a git repository that is **yours**.
- Cabeção has no server, account, telemetry, or usage collection. Everything that leaves the machine goes through git, to the remote **you** configured (`fetch`, `push` and, in `init` and `doctor`, a query to check whether the remote responds).
- **The only exception is optional and off by default:** if you turn on [answers with a language model](./guias/respostas-com-modelo.md) (`cabecao llm on`), each `ask` question sends passages from your notes to the provider **you** chose. Nothing goes until you turn it on, in a terminal, seeing what leaves and where to. See [below](#answers-from-a-provider-optional).
- The MCP server runs on your machine, over stdio. It does not open a network port.
- What an agent reads from the brain goes to the AI model you use, like any other text in the conversation. That is up to the AI client, not Cabeção: choose what you store with that in mind.

## Use a private repository

Cabeção's code is public; your brain should not be. For HTTPS addresses of known providers (github.com, gitlab.com, bitbucket.org, codeberg.org, gitea.com, git.sr.ht, and dev.azure.com), `init` and `doctor` try to read the repository **without credentials**: if they succeed, they warn that it looks public.

Pointed at a public repository (here, the project's own), `doctor` shows:

```text
aviso  Visibilidade             https://github.com/renanloureiroo/cabecao.git parece PÚBLICO: o GitHub respondeu a uma leitura sem credenciais
                                Correção: Torne o repositório privado nas configurações do GitHub antes de gravar notas pessoais.
```

Over SSH, or on a server Cabeção does not know, there is no way to tell without the provider's API. `doctor` says so and asks you to check with the provider:

```text
ok     Visibilidade             não verificável (só dá para conferir em HTTPS de provedor conhecido): confirme no provedor que o repositório é privado
```

## Secret scanner

Every agent write and every sync goes through a scanner before any commit or push. If it finds something that looks like a secret, the operation stops and shows the file, line, and rule, **never the value**:

```text
$ cabecao sync
Sync: bloqueado. Possível segredo em 1 lugar (memory/procedures/acesso-ao-roteador.md:6, regra generic-assignment). Nada foi commitado nem enviado. Remova o segredo, ou marque a linha com "cabecao:allow-secret" se não for um, e rode o sync de novo.
Possíveis segredos (o valor não é mostrado):
  memory/procedures/acesso-ao-roteador.md:6:8  generic-assignment (Atribuição a um nome sensível (password, senha, secret, token, api_key, access_key, private_key, credential) cujo valor tem cara de segredo: senha com letras e dígitos, ou valor longo de alta entropia.; mudança ainda sem commit)
Próximo passo: Tire o segredo dos arquivos apontados em secrets (ou marque a linha com "cabecao:allow-secret" se não for um) e rode sync de novo.
```

What it recognizes:

| Rule | What |
| --- | --- |
| `private-key` | PEM or OpenSSH private key |
| `aws-access-key-id`, `aws-secret-access-key` | AWS keys |
| `github-token`, `gitlab-token` | GitHub and GitLab tokens |
| `slack-token`, `stripe-key`, `google-api-key` | Slack tokens, Stripe and Google keys |
| `anthropic-api-key`, `openai-api-key`, `npm-token` | Anthropic and OpenAI keys, and npm tokens |
| `jwt` | Signed JSON Web Tokens |
| `cabecao-confirm-token` | The `forget` `confirm_token` (`cbc_ct_...`): valid for minutes and must not stay in a note |
| `url-credentials` | URL with an embedded password (`esquema://usuario:senha@host`) |
| `generic-assignment` | A sensitive name (`password`, `senha`, `secret`, `token`, `api_key`...) being assigned a value that looks like a secret |

The scanner looks at everything that is about to be committed, not only notes: text attachments, configuration, frontmatter values.

### When it is not a secret

If the flagged line is not a secret (a documentation example, a public identifier), mark it with `cabecao:allow-secret`, on the line itself or alone on the line above:

```markdown
<!-- cabecao:allow-secret -->
exemplo_de_token: abc123def456ghi789
```

The marker only works in text that is **yours** (edited in Obsidian or an editor and carried by sync). In text sent by an agent, it is ignored: an agent cannot clear itself by writing the marker.

## What an agent is prevented from doing

Through the MCP tools, an agent:

- does not create or change rules (`type: rule`, `memory/rules/`);
- does not write to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or other files that AI clients load as instructions, in any folder;
- does not write to `index.md` or `log.md`, outside the note folders, or outside the brain folder;
- does not change sources that already exist in `raw/`, or conflict copies;
- does not choose its own provenance (`origin`, `edited_by`) or give itself `trust: high`;
- does not write anything that looks like a secret;
- does not undo your operations;
- does not archive (`forget`) your rules, sources in `raw/`, or conflict copies, and only archives after a two-call confirmation (or after you answer, when the client asks);
- does not make `ingest` read files outside the brain: a file of yours goes in through `cabecao ingest`, which is you;
- does not write rules in a consolidation: at most it proposes one in `wiki/syntheses/`, and the whole consolidation is undone with one `undo`.

When it changes a note of yours, the note gets `edited_by` and its `trust` drops. And every write it makes is a commit that you can undo with `cabecao undo`.

The content the server returns is marked as **data, never instruction**, with the order of authority (you, the rules, `AGENTS.md`, the memories, outside content). See [Provenance and trust](./conceitos/proveniencia.md).

## Answers from a provider (optional)

With `ask` turned on, the brain's content gets one more recipient: the provider that generates the answer. The protections:

- **Opt-in per machine and per provider.** `cabecao llm on` only works with you in the terminal, shows the destination, what leaves, what never leaves, the provider's data policy and the cost, and asks for confirmation. An agent does not turn it on, switch it or read the key. `cabecao llm off` turns it off.
- **What never leaves:** notes with `private: true`, control files, passages where the scanner flags a secret (the `cabecao:allow-secret` marker does not apply here) and whatever the brain's `llm_policy` excludes. A brain can forbid every provider (`"allow": "none"`) or allow only the installed agent (`"agent"`), and that applies on every machine.
- **Content as data.** Each passage goes between delimiters with a mark drawn at random for each question (a passage that tries to forge the delimiter is neutralized), outside content goes with its words separated by `^`, and the prompt says nothing inside the passages is an instruction.
- **The answer is read only.** Nothing the provider returns is executed, written to the brain, or used to call anything else. Terminal control sequences are removed.
- **Citations checked by Cabeção**, not by the model: an invented label or a quote that is not in the passage is dropped; with no valid citation at all, the answer is "the brain does not have this".
- **The key** lives in the system keychain (or a `0600` file), reaches system programs through standard input, never the command line, and never shows up in the brain, the log, an error message or `--json`.
- **The installed agent runs without tools.** Claude Code, as a provider, runs with no shell, no file reads and no MCP, in an empty temporary folder, with a minimal environment and a time limit; the process tree is ended afterwards.

Details, providers and each one's data policy in [Answers with a language model](./guias/respostas-com-modelo.md).

## Known limits

Stated plainly, so you can decide what to store:

- **The scanner works by patterns.** It catches the formats in the table, not every possible secret: a password loose in a sentence, without a name like "senha:" (password:) before it, gets through. Do not use the brain to store secrets.
- **The restrictions apply to the MCP tools.** An agent with access to the terminal and the files (Claude Code, for example) can edit the brain folder directly, like any program of yours. `AGENTS.md` asks it to use the tools, and sync runs those edits through the scanner and records them as `manual`, but there is no way to prevent direct writes to disk. Limit the client's file permissions if this matters to you.
- **"Data, never instruction" is guidance to the model, not a guarantee.** Malicious text in a note can still influence a model. Be wary of outside content (`trust: low`).
- **With `ask` turned on, the passages sent are under the provider's policy.** Cabeção chooses what leaves, but does not control what the provider does with what it received.
- **Cabeção encrypts nothing.** Notes are plain text on disk and on the remote; anyone with access to the repository reads everything. The protection is your provider's and your disk's.
- **Unsigned commits.** If `commit.gpgsign` is on, Cabeção's commits go out unsigned, because a key that asks for a passphrase would hang the sync. `doctor` warns about it.
- **The public repository check only covers HTTPS on known providers.** Over SSH, check it yourself.

## Report a vulnerability

Use GitHub's private vulnerability reporting in the [project repository](https://github.com/renanloureiroo/cabecao/security), not a public issue.
