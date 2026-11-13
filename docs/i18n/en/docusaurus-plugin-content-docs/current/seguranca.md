---
title: Security and privacy
description: Where your data goes, how the secret scanner works, what an agent is prevented from doing, and the known limits.
---

## Your data stays with you

- Notes live in a folder on your machine and in a git repository that is **yours**.
- Cabeção has no server, account, telemetry, or usage collection. The package makes no network calls of its own: everything that leaves the machine goes through git, to the remote **you** configured (`fetch`, `push` and, in `init` and `doctor`, a query to check whether the remote responds).
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

## What an agent only does with your request

Through the MCP tools and through the CLI (which follows the same rules when the one running it is an agent), these actions need your **explicit request, confirmed**: the first call does nothing and returns the exact summary and a short-lived confirmation token; the agent only repeats with the token if you say yes. In a client that can ask (elicitation), the server asks you directly.

- create or change rules (`type: rule`, `memory/rules/`);
- write to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and other files AI clients load as instructions, in any folder, and to the control files (`log.md`, `README.md`, `.cabecao.json`, `.gitignore`, `.gitattributes`), these last three only if the result is valid and never touching the `embedding` section;
- change sources that already exist in `raw/`;
- save `trust: high`;
- undo one of your operations;
- archive (`forget`) any note.

What is done this way **does not become `origin: human`**: it stays `origin: agent:<client>`, plus `approved_by: user` and `approved_at` in the note and the `Cabecao-Approved` trailer in the commit. Only Cabeção writes these marks; the ones an agent sends in the frontmatter are ignored. The `agent_approved` rule of `cabecao lint` lists everything for you to review.

**The cost, stated plainly:** the token proves the action was intentional and is exactly the one shown (another action, other content, another session, an expired or forged token are refused). It **does not prove you said yes**: in a client without elicitation, the one claiming you asked is the agent. An agent manipulated by some content can make both calls. The safety net is what gets recorded: the identified commit, `cabecao undo`, and the `lint` listing.

## What an agent never does

These are technical protections and hold with or without confirmation:

- write outside the brain folder, in `.git/` or `.cabecao/`, or through a symbolic link;
- write `index.md` (the catalog is derived from the notes);
- create a fake conflict copy, or edit one;
- save something that looks like a secret, in the text, the path, the title, or the frontmatter (the `cabecao:allow-secret` marker does not count for it);
- forge frontmatter with a BOM or a `---` at the start of the content (the final text is re-read and checked);
- choose its own provenance (`origin`, `edited_by`, `approved_by`, `approved_at`);
- exceed the size limits, or use an invalid file name or one with an invisible character;
- make `ingest` read files outside the brain;
- change the embeddings model or compact the index branch (that is machine administration, only yours, at the terminal).

When it changes one of your notes without confirmation, the note gets `edited_by` and its `trust` drops. And every write it makes is a commit you undo with `cabecao undo`.

The content the server returns is marked as **data, never instruction**, with the order of authority (you, the rules, `AGENTS.md`, the memories, outside content). See [Provenance and trust](./conceitos/proveniencia.md).

## Known limits

Stated plainly, so you can decide what to keep:

- **An agent with a shell can go around the CLI and the server.** The CLI treats as an agent every process without a controlling terminal or with an agent signal in the environment ([Who is human and who is an agent in the CLI](./guias/humano-e-agente.md)), but an agent that runs commands can fake a terminal (open a pseudo-terminal and clear the variables) or simply edit the brain's files directly, without going through Cabeção. Sync treats that edit as **yours** (`manual`): it goes through the secret scanner, but carries no agent mark. This **cannot be closed from the CLI**. The barrier that holds against a manipulated agent is the **MCP server with the agent without a shell** (or with access to the brain folder denied in the client's permissions).
- **Agents without a known signal.** For agents that leave no variable in the environment (Aider, GitHub Copilot, Antigravity, and others), the CLI depends on the controlling terminal: if one of them runs commands in a pseudo-terminal, it counts as you.
- **The confirmation token does not prove you said yes** (see above).
- **The scanner works by patterns.** It catches the formats in the table, not every possible secret: a password loose in a sentence, without a name like "password:" before it, gets through. Do not use the brain to keep secrets.
- **"Data, never instruction" is guidance to the model, not a guarantee.** Malicious text in a note can still influence a model. Be wary of outside content (`trust: low`).
- **Nothing is encrypted by Cabeção.** Notes are plain text on disk and on the remote; whoever has access to the repository reads everything. The protection is your provider's and your disk's.
- **Unsigned commits.** If `commit.gpgsign` is on, Cabeção's commits go out unsigned, because a key that asks for a passphrase would hang the sync. `doctor` warns about it.
- **The public-repository check only covers HTTPS on known providers.** With SSH, check it yourself.

## Report a vulnerability

Use GitHub's private vulnerability reporting in the [project repository](https://github.com/renanloureiroo/cabecao/security), not a public issue.
