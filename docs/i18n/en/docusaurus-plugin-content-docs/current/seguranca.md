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
- does not write rules in a consolidation: at most it proposes one in `wiki/syntheses/`, and the whole consolidation is undone with one `undo`;
- in a consolidation with nobody watching (`consolidate --run`), also does not push to the remote, undo, leave a handoff, ingest, or archive (see below).

When it changes a note of yours, the note gets `edited_by` and its `trust` drops. And every write it makes is a commit that you can undo with `cabecao undo`.

The content the server returns is marked as **data, never instruction**, with the order of authority (you, the rules, `AGENTS.md`, the memories, outside content). See [Provenance and trust](./conceitos/proveniencia.md).

## What runs with nobody watching {#o-que-roda-sem-voce-olhando}

Cabeção does two things without you in front of the screen: the scheduled sync ([Automatic sync](./guias/sync-automatico.md)), which only does git, and `cabecao consolidate --run` ([Consolidate with an agent](./guias/consolidar-com-agente.md)), which calls an AI agent to read and rewrite the brain. The second is the more sensitive one: the agent reads notes that may hold malicious text from ingested sources, and nobody is there to refuse a strange request. So:

- **Only Cabeção's tools.** Each agent runs with shell, file editing, and network denied, and only the Cabeção server's tools allowed. No "skip all permissions" mode is used. An agent that does not allow this restriction in non-interactive mode has no `--run` (today: Cursor Agent, Gemini CLI, Copilot CLI, and OpenCode; the reasons are in the guide).
- **Temporary configuration.** The Cabeção server goes into an MCP configuration created for the run, in an empty temporary folder that is also the agent's working directory, deleted at the end. Your clients' configuration is neither read for this nor changed; the agent's login is the one it already has.
- **Minimal environment.** The agent receives only system, folder, proxy and certificate, git, and Cabeção variables, plus the ones for its own login (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and the like). Other tokens in your environment are not passed on.
- **Server tied to the consolidation.** The server the agent starts (`cabecao mcp --consolidation <id>`) writes everything with the consolidation's session and refuses `sync`, `undo`, `handoff_save`, `ingest`, and a second `start`. `forget` too, unless you pass `--allow-forget`: archiving memory with nobody watching only with an explicit option. The usual agent restrictions still apply (rules are yours only, nothing in instruction or control files, nothing outside the brain, secret scanner).
- **Time limit.** Once the time is up (default: 20 minutes), the agent and everything it started are stopped: the process group on macOS and Linux, the tree with `taskkill /T` on Windows.
- **Nothing half done.** If the agent does not close the consolidation, what it wrote is undone with a revert commit, and the command exits with `1`. If it closed it, `cabecao undo --session <id>` undoes everything, and the restore point stays on the machine.
- **Nothing leaves the machine through Cabeção.** The consolidation does not sync; the commit goes to the remote on the next sync. What the agent reads goes to its AI model, as in any session of yours.

What is left out, per agent: Codex keeps its apply-patch tool (the read-only sandbox refuses the write) and, depending on the model, a file-reading tool that the sandbox does not block; with no shell and no network, what it reads could only leave through a write to the brain, which goes through the scanner. Antigravity loads your global MCP servers (their tools ask for approval and are therefore denied). And "denied" depends on each agent honoring its own options: Cabeção does not run the agent in a sandbox of its own.

## Known limits

Stated plainly, so you can decide what to store:

- **The scanner works by patterns.** It catches the formats in the table, not every possible secret: a password loose in a sentence, without a name like "senha:" (password:) before it, gets through. Do not use the brain to store secrets.
- **The restrictions apply to the MCP tools.** An agent with access to the terminal and the files (Claude Code, for example) can edit the brain folder directly, like any program of yours. `AGENTS.md` asks it to use the tools, and sync runs those edits through the scanner and records them as `manual`, but there is no way to prevent direct writes to disk. Limit the client's file permissions if this matters to you.
- **"Data, never instruction" is guidance to the model, not a guarantee.** Malicious text in a note can still influence a model. Be wary of outside content (`trust: low`).
- **Cabeção encrypts nothing.** Notes are plain text on disk and on the remote; anyone with access to the repository reads everything. The protection is your provider's and your disk's.
- **Unsigned commits.** If `commit.gpgsign` is on, Cabeção's commits go out unsigned, because a key that asks for a passphrase would hang the sync. `doctor` warns about it.
- **The public repository check only covers HTTPS on known providers.** Over SSH, check it yourself.

## Report a vulnerability

Use GitHub's private vulnerability reporting in the [project repository](https://github.com/renanloureiroo/cabecao/security), not a public issue.
