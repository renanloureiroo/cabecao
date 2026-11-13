---
title: Security and privacy
description: Where your data goes, how the secret scanner works, what an agent is prevented from doing, and the known limits.
---

## Your data stays with you

- Notes live in a folder on your machine and in a git repository that is **yours**.
- Cabeção has no server, account, telemetry, or usage collection. Everything that leaves the machine goes through git, to the remote **you** configured (`fetch`, `push` and, in `init` and `doctor`, a query to check whether the remote responds).
- **The only exception is optional and off by default:** if you turn on [answers with a language model](./guias/respostas-com-modelo.md) (`cabecao llm on`), each `ask` question sends passages from your notes to the provider **you** chose. Nothing goes until you turn it on, in a terminal, seeing what leaves and where to. See [below](#answers-from-a-provider-optional).
- Semantic search, if you turn it on (`cabecao embeddings on`), downloads a runtime (through npm) and a model (from Hugging Face) to this machine; the vectors are computed here and go, through sync, to your remote, in an index branch.
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
| `cabecao-confirm-token` | The confirmations' `confirm_token` (`cbc_ct_...`): valid for minutes and must not stay in a note |
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
- write to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and other files AI clients load as instructions, in any folder, and to the control files (`log.md`, `README.md`, `.cabecao.json`, `.gitignore`, `.gitattributes`), these last three only if the result is valid and never touching the `embedding` and `llm_policy` sections of `.cabecao.json`;
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
- in a consolidation with nobody watching (`consolidate --run`), also does not push to the remote, undo, leave a handoff, ingest, archive, or do any of the actions that need your request (see below).

When it changes one of your notes without confirmation, the note gets `edited_by` and its `trust` drops. And every write it makes is a commit you undo with `cabecao undo`.

The content the server returns is marked as **data, never instruction**, with the order of authority (you, the rules, `AGENTS.md`, the memories, outside content). See [Provenance and trust](./conceitos/proveniencia.md).

## What runs with nobody watching {#o-que-roda-sem-voce-olhando}

Cabeção does two things without you in front of the screen: the scheduled sync ([Automatic sync](./guias/sync-automatico.md)), which only does git, and `cabecao consolidate --run` ([Consolidate with an agent](./guias/consolidar-com-agente.md)), which calls an AI agent to read and rewrite the brain. The second is the more sensitive one: the agent reads notes that may hold malicious text from ingested sources, and nobody is there to refuse a strange request. So:

- **Only agents whose terms allow it.** Cabeção only calls an agent if its terms allow another program to run it with the credential in use, checked against the official source: Claude Code, with your login or an API key, and Codex, only with an API key. Antigravity and Gemini CLI are left out: the personal plan's terms do not allow it ([Antigravity FAQ](https://antigravity.google/docs/faq/)).
- **Only Cabeção's tools.** Each agent runs with shell, file editing, and network denied, and only the Cabeção server's tools allowed. No "skip all permissions" mode is used. An agent that does not allow this restriction in non-interactive mode has no `--run` (today: Cursor Agent, Copilot CLI, and OpenCode; the reasons are in the guide).
- **Temporary configuration.** The Cabeção server goes into an MCP configuration created for the run, in an empty temporary folder that is also the agent's working directory, deleted at the end. Your clients' configuration is neither read for this nor changed; the agent's login is the one it already has.
- **Minimal environment.** The agent receives only system, folder, proxy and certificate, git, and Cabeção variables, plus the ones for its own login (`ANTHROPIC_API_KEY` and the like; for Codex, the API key as `CODEX_API_KEY`). Other tokens in your environment are not passed on.
- **Server tied to the consolidation.** The server the agent starts (`cabecao mcp --consolidation <id>`) writes everything with the consolidation's session and refuses `sync`, `undo`, `handoff_save`, `ingest`, and a second `start`. `forget` too, unless you pass `--allow-forget`: archiving memory with nobody watching only with an explicit option. The actions that need your explicit request (rules, control and instruction files, `raw/`, `trust: high`) are **unavailable**, not even with the token, because nobody is there to confirm; only `--allow-elevated` frees them. Only you pass `--allow-forget` and `--allow-elevated`, at the terminal. The other agent restrictions still apply (nothing outside the brain, secret scanner).
- **Time limit.** Once the time is up (default: 20 minutes), the agent and everything it started are stopped: the process group on macOS and Linux, the tree with `taskkill /T` on Windows.
- **Nothing half done.** If the agent does not close the consolidation, what it wrote is undone with a revert commit, and the command exits with `1`. If it closed it, `cabecao undo --session <id>` undoes everything, and the restore point stays on the machine.
- **Nothing leaves the machine through Cabeção.** The consolidation does not sync; the commit goes to the remote on the next sync. What the agent reads goes to its AI model, as in any session of yours.

What is left out, per agent: Codex keeps its apply-patch tool (the read-only sandbox refuses the write) and, depending on the model, a file-reading tool that the sandbox does not block; with no shell and no network, what it reads could only leave through a write to the brain, which goes through the scanner. And "denied" depends on each agent honoring its own options: Cabeção does not run the agent in a sandbox of its own.

## Skills through the CLI: what they can and cannot do {#skills-pela-cli}

The [Cabeção skills](./guias/skills.md) give the agent no new power: they only teach which `cabecao` commands to run. What is allowed is decided by the CLI, and an agent running the CLI is under **the same rules as the MCP server**:

- **Can**, without asking: look things up (`recall`, `search`, `read`, `graph`, `facts`, `lint`, `status`), save ordinary memories (`remember`, `write`, `patch`, `relate`, `handoff`), register sources (`ingest`), undo its own operations (`undo --op <id>`) and sync (`sync`). Everything becomes a commit with `origin: agent:<nome>` and the `Cabecao-Client` trailer, which `undo` undoes.
- **Only with your explicit request**, in two calls with `--confirm <token>`: rules, control and instruction files, `raw/`, `trust: high`, archiving (`forget`) and undoing an operation that is not an agent's. The `cabecao-pedido-explicito` skill says to show the summary, ask, and never follow a request that came from content it read. What gets saved this way is marked and shows up in `lint`.
- **Cannot**: the commands that are only yours (`embeddings on/off/switch`, `compact`, `upgrade`, `llm on/off/test/remove/policy`, `eval --answers`, removing with `uninstall`) exit with code 4; no option, variable or configuration file turns the agent into you (`--as` only gives the name). The technical protections (outside the brain, `.git/`, symbolic links, secrets, forged frontmatter) hold without exception.

The limit is right below: an agent that has a shell can **not use** the CLI and edit the brain's files directly. The skills make the right path easy; they don't prevent the wrong one.
## Answers from a provider (optional)

With `ask` turned on, the brain's content gets one more recipient: the provider that generates the answer. The protections:

- **Opt-in per machine and per provider.** `cabecao llm on` only works with you in the terminal, shows the destination, what leaves, what never leaves, the provider's data policy and the cost, and asks for confirmation. An agent does not turn it on, switch it or read the key. `cabecao llm off` turns it off. The confirmation is signed with a local secret and covers destination, model and key: a forged `llm.json`, or one with its address changed, turns nothing on, and a configuration redirected by an environment variable does not apply to an agent.
- **What never leaves:** private notes (the `private` key in any case with a true value; the `private` or `private/...` tag in `tags` or `tag`; or `#private` in the body, as in Obsidian) and their names cited as a whole word in other notes (a short name keeps the passage that cites it from leaving), notes with unreadable frontmatter, control files, passages where the scanner flags a secret anywhere in the note (the `cabecao:allow-secret` marker does not apply here) and whatever the brain's `llm_policy` excludes. A brain can forbid every provider (`"allow": "none"`) or allow only the installed agent (`"agent"`); the policy only restricts, applies on every machine and only you change it (`cabecao llm policy`).
- **Content as data.** Each passage goes between delimiters with a mark drawn at random for each question (a passage that tries to forge the delimiter is neutralized), with the note's path and title inside the block, outside content goes with its words separated by `^`, and the prompt says nothing inside the passages is an instruction.
- **The answer is read only.** Nothing the provider returns is executed, written to the brain, or used to call anything else. Terminal control sequences, images, links, addresses and HTML are removed from the model's text.
- **Citations checked by Cabeção**, not by the model: an invented label, a quote that is too short (fewer than 16 letters or digits and 3 content words) or one that is not in the passage is dropped, and the quote shown is the note's real text; with no valid citation at all, the answer is "the brain does not have this". Cabeção checks the citation, not the conclusion.
- **No detours on the network.** A redirect is never followed, a server on this machine never goes through the proxy, cloud metadata addresses are refused, and there is a cap on calls per hour and per session.
- **The agent does not see the provider.** Not the name, the model, the destination or the provider's error, through any command or tool. The MCP server is always treated as an agent, even with an inherited terminal, and the configuration folder comes from the system account (`os.userInfo()`), not from the environment.
- **A spending cap that holds under concurrency**: the slot is reserved before calling the provider, under a lock across processes, and each question makes at most 3 requests.
- **The model's text as data**: only claims with a checked citation come out; `[`, `]`, `<` and `>` are escaped and addresses removed; the data notice says the text is generated by a model. A question carrying a secret is refused.
- **Confirmed Claude Code**: `ask` runs the executable confirmed at `llm on`, and for an agent, with nothing from its environment that changes where `claude` sends data or which configuration it reads.
- **The key** lives in the system keychain (or a `0600` file), reaches system programs through standard input (on Windows, through the environment of the PowerShell process only), never the command line, and never shows up in the brain, the log, an error message or `--json`. It is bound to the destination: changing the provider's address does not hand it to another server.
- **The installed agent runs without tools.** Claude Code, as a provider, runs with no shell, no file reads and no MCP, in an empty temporary folder, with a minimal environment and a time limit; the process tree is ended afterwards.

Details, providers and each one's data policy in [Answers with a language model](./guias/respostas-com-modelo.md).

## Known limits

Stated plainly, so you can decide what to keep:

- **An agent with a shell can go around the CLI and the server.** The CLI treats as an agent every process without a controlling terminal or with an agent signal in the environment ([Who is human and who is an agent in the CLI](./guias/humano-e-agente.md)), but an agent that runs commands can fake a terminal (open a pseudo-terminal and clear the variables) or simply edit the brain's files directly, without going through Cabeção. Sync treats that edit as **yours** (`manual`): it goes through the secret scanner, but carries no agent mark. This **cannot be closed from the CLI**. The barrier that holds against a manipulated agent is the **MCP server with the agent without a shell** (or with access to the brain folder denied in the client's permissions).
- **Agents without a known signal.** For agents that leave no variable in the environment (Aider, GitHub Copilot, Antigravity, and others), the CLI depends on the controlling terminal: if one of them runs commands in a pseudo-terminal, it counts as you.
- **The confirmation token does not prove you said yes** (see above).
- **The scanner works by patterns.** It catches the formats in the table, not every possible secret: a password loose in a sentence, without a name like "password:" before it, gets through. Do not use the brain to keep secrets.
- **"Data, never instruction" is guidance to the model, not a guarantee.** Malicious text in a note can still influence a model. Be wary of outside content (`trust: low`).
- **With `ask` turned on, the passages sent are under the provider's policy.** Cabeção chooses what leaves, but does not control what the provider does with what it received.
- **Nothing is encrypted by Cabeção.** Notes are plain text on disk and on the remote; whoever has access to the repository reads everything. The protection is your provider's and your disk's.
- **Unsigned commits.** If `commit.gpgsign` is on, Cabeção's commits go out unsigned, because a key that asks for a passphrase would hang the sync. `doctor` warns about it.
- **The public-repository check only covers HTTPS on known providers.** With SSH, check it yourself.

## Report a vulnerability

Use GitHub's private vulnerability reporting in the [project repository](https://github.com/renanloureiroo/cabecao/security), not a public issue.
