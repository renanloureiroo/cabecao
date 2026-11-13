---
title: Answers with a language model (optional)
description: cabecao ask and the ask tool answer with checked citations, using a provider you choose. Off by default; nothing leaves the machine until you turn it on.
sidebar_position: 11
---

Cabeção is good at retrieval: keywords, meaning, graph, validity over time and provenance. Normally the one who writes the answer is the agent you already use, reading the result of `search`. With **`cabecao ask`** (and the `ask` tool for agents), Cabeção can also **generate the answer**: it retrieves the passages, sends them to a language model **you** choose, and **checks every citation** before returning.

:::info[Optional and off by default]
None of this is needed to use Cabeção, and nothing leaves the machine until you run `cabecao llm on` in a terminal, see what starts leaving and where to, and confirm. Without it, `cabecao ask` shows the passages it found and how to turn it on, and the `ask` tool does not even show up for agents.
:::

## What `ask` does

1. **Retrieves** like `search` (hybrid when semantic search is on), with `--as-of`, `--scope` and `--type`, and reads the section of each note found.
2. **Filters what may leave** (see below) and builds the request: each passage is labeled (`S1`, `S2`...) with its validity and provenance, between delimiters carrying a mark drawn at random for each question. The note's path, title and sections go **inside** the delimited block (they are data, like the text), and outside content goes with its words separated by `^`.
3. **Calls the provider** enabled on this machine, asking for the answer as JSON: each claim with its sources and a verbatim quote.
4. **Checks every citation**: the label must exist and the quote must appear in the cited passage (ignoring differences in accents, case, quotes and spaces). The quote must be **substantive**: at least 16 letters or digits and 3 content words; with an ellipsis, at most 3 pieces, each one like that, in order. The quote you see is always the **note's real text**, never what the model wrote. What does not check out is dropped; a claim without any checked citation is marked `[sem apoio]` (unsupported); with none at all, the answer becomes "the brain does not have this".

The answer is **read only**: it is never written to the brain, executed, or used to call anything else. Images, links, addresses and HTML the model writes are stripped from the text (in a client that renders Markdown, an image would load by itself and carry data in its address).

:::note[The honest limit]
Cabeção **checks the citation, not the conclusion**: it guarantees the cited passage exists and says that, not that the claim follows from it. For anything important, open the source.
:::

## Turn it on

```bash
cabecao llm on
```

The command looks for what is already on your machine (Claude Code installed, an `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` or `GROQ_API_KEY` variable) and offers that first. You pick a number, confirm, and you are done. When a key has to be pasted, it is read without showing on screen.

Before turning on, it shows exactly what starts leaving and where to. The output below comes from the real CLI but is illustrative: a local test server answered in place of Ollama, which is why the test took 0.0 s (the output is in Portuguese):

```text
$ cabecao llm on --provider ollama --model llama3.2

Para responder ao "cabecao ask" e à tool "ask" dos seus agentes, o Cabeção vai enviar a: Ollama nesta máquina (localhost:11434)
  Provedor "ollama" · modelo llama3.2 · roda nesta máquina

O que sai, a cada pergunta: a pergunta e até ~3000 tokens de trechos das notas que a busca achar,
  com o caminho, o título, o tipo, a validade e a proveniência (trust, origin) de cada um.
O que NUNCA sai: notas com "private: true" no frontmatter; arquivos de controle (catálogo, diário, AGENTS.md,
  CLAUDE.md e afins, cópias de conflito); qualquer trecho em que o scanner de segredos acusar algo (o trecho é
  omitido e a omissão aparece na resposta); o que a "llm_policy" do .cabecao.json do cérebro excluir; a chave.
A resposta nunca é gravada no cérebro nem executada: é só lida.

Custo: roda nesta máquina, sem cobrança por pergunta. Limites: até 2048 tokens de saída e ~3000 de contexto por pergunta, 60 s por chamada.
Para desligar: cabecao llm off. Para apagar o provedor: cabecao llm remove ollama.

Ativar? [s/N] s
Respostas ativadas com Ollama (servidor local) (modelo llama3.2).
Teste: funcionou em 0,0 s.
Pergunte com: cabecao ask "o que decidimos sobre ...?"
Nos agentes, a tool "ask" aparece na próxima sessão (reinicie o cliente de IA).
```

Turning it on, off, testing, deleting and changing the policy are **up to you, in the terminal**: without a controlling terminal, or when run by an agent, `llm` refuses with exit code 4 (see [Who is human and who is an agent](./humano-e-agente.md)); only `llm status` runs for everyone, and for an agent it only says whether answers are on. An agent does not turn it on, switch it, test it or read the key, neither through the CLI nor through a tool, not even with a confirmation token. `cabecao ask` is a memory command: an agent may ask.

The `llm on` confirmation is **signed** in `llm.json` with a secret from this machine (`llm-consent.key`, `0600` permission) and covers the destination, the model and where the key comes from. An `llm.json` written by hand, copied from another machine or with its address changed afterwards turns nothing on: run `cabecao llm on` again.

### Where the configuration lives

`llm.json`, the confirmation secret, the spending-cap counter and file-stored keys live in **your user's default** configuration folder (`~/.config/cabecao`; on Windows, `%APPDATA%\cabecao`), computed from the system user. If the folder is redirected by an environment variable (`CABECAO_CONFIG_DIR`, `XDG_CONFIG_HOME`, `APPDATA` or `HOME`), the redirected configuration applies **only to you, in the terminal**; for an agent (which controls the environment of the commands it runs), answers stay off and nothing is read. That way an agent cannot point `ask` at an `llm.json` it wrote itself.

### Providers

| Provider | How to turn on | Default model | Key |
| --- | --- | --- | --- |
| **Claude Code** installed | `cabecao llm on --provider claude-code` | `haiku` | None: uses Claude Code's login |
| Anthropic (API) | `cabecao llm on --provider anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` or paste |
| OpenAI | `cabecao llm on --provider openai` | `gpt-6-luna` | `OPENAI_API_KEY` or paste |
| Google Gemini (API) | `cabecao llm on --provider gemini` | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` or paste |
| OpenRouter | `cabecao llm on --provider openrouter --model <model>` | (pick yours) | `OPENROUTER_API_KEY` or paste |
| Groq | `cabecao llm on --provider groq` | `openai/gpt-oss-20b` | `GROQ_API_KEY` or paste |
| Ollama, on this machine | `cabecao llm on --provider ollama --model <model>` | (the one you pulled) | None |
| LM Studio, on this machine | `cabecao llm on --provider lmstudio --model <model>` | (the one you loaded) | None |
| Another OpenAI-compatible service | `cabecao llm on --provider compatible --base-url <url> --model <model>` | (pick yours) | Optional |

The default models are the cheapest ones with structured output in each provider's documentation on 2026-11-13; change them with `--model`. The address (`--base-url`) only applies to `compatible`, `ollama` and `lmstudio`: providers with a fixed address refuse it, so the destination shown in the confirmation is always the real one. It must be `https`, or `http` only on this machine (`localhost`, `127.0.0.1`, `[::1]`); link-local and cloud metadata addresses (`169.254.*`, `fe80::`, `0.0.0.0`) are refused, and `llm.json` is checked again on every read. To use a key from a variable without storing it, pass `--key-env NAME`.

**Claude Code** is offered because Anthropic documents that `claude -p` draws from your subscription limits ([Anthropic support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), checked on 2026-11-13). To generate the answer it runs **without any tool**: no shell, no file reads, no MCP servers, none of your settings, in an empty temporary folder and with a time limit. If the agent in your conversation is also Claude Code, each `ask` opens a second session (it costs twice).

### Why the installed Antigravity is not offered

The [Antigravity FAQ](https://antigravity.google/docs/faq) (checked on 2026-11-13) says that wrapping `agy` inside another application "is not supported under consumer plans" and that using third-party software to access it violates the terms, putting the account at risk. So Cabeção does not call `agy`. For Google's models, use the **Gemini API with a key** (`--provider gemini`). Codex is not offered either: OpenAI only advises calling it from another program with an API key (not a ChatGPT login), and with that key the OpenAI API (`--provider openai`) does the same without starting an agent.

## What leaves the machine, and what never does

With each question, what goes **to the provider you turned on** is: the question and up to ~3,000 tokens of passages from the notes the search found, with path, title, type, validity and provenance. With a local server (Ollama, LM Studio), nothing leaves the machine, unless the model is one of Ollama's "-cloud" models, which run on ollama.com (`llm on` warns about it).

**Never leaves**, with any provider:

- **private notes**, and their names (see below);
- notes whose frontmatter cannot be read (when in doubt, it stays);
- control files: the catalog, `log.md`, `AGENTS.md`, `CLAUDE.md` and the like, conflict copies;
- any passage where the [secret scanner](../seguranca.md#secret-scanner) flags something, searched across the **whole note** (a private key block counts from `BEGIN` to `END`, and a passage touching it stays out too), ignoring `cabecao:allow-secret`, which clears a line for git, not for an outside provider;
- whatever the brain's policy excludes;
- the key.

What was left out shows in the answer ("Trechos não enviados ao provedor: 1 de nota privada"). And `cabecao ask "<question>" --show-context` shows exactly what **would** be sent, without sending anything.

### What counts as a private note

A note is private, and never goes to any provider, when its frontmatter has:

- the `private` key, in any case (`private`, `Private`, `PRIVATE`), with a true value: `true`, `yes`, `on`, `sim`, `1`, as text or in a list (`[true]`);
- or the `private` tag (with or without `#`) in `tags`.

A note whose frontmatter cannot be read does not leave either. And a private note's **name** does not leave even when another note cites it: its title, aliases (`aliases`), path and file name become `[nota privada]` in the text, title and sections of the passages that leave, and it never comes in as a note related through the graph.

### Per-brain policy

In `.cabecao.json` (which applies on every machine), the `llm_policy` field restricts what a provider receives from this brain:

```json
{
  "llm_policy": {
    "allow": "agent",
    "exclude_paths": ["memory/private/**", "wiki/entities/Someone.md"],
    "exclude_types": ["episode"],
    "exclude_trust": ["low"]
  }
}
```

| Field | What it does |
| --- | --- |
| `allow` | `"any"` (default): any enabled provider. `"agent"`: only the installed agent. `"none"`: never calls a provider for this brain; `ask` returns only the passages |
| `exclude_paths` | Paths that never leave (`*`, `**` and `?`; a folder covers everything inside it) |
| `exclude_types` | Note types that never leave |
| `exclude_trust` | `trust` levels that never leave (for example `["low"]`, ingested content) |

Without the field, the brain restricts nothing beyond what the machine configured. An invalid `llm_policy` **closes**: nothing is sent, and `doctor` says what to fix.

The policy **only restricts**: what enables a provider is always this machine's configuration (`cabecao llm on`); the brain can only close it further. Change it with `cabecao llm policy` (only you, in the terminal, with confirmation):

```bash
cabecao llm policy                          # shows the current policy
cabecao llm policy --allow agent            # only the installed agent
cabecao llm policy --exclude-path "memory/personal/**"
cabecao llm policy --clear                  # removes the policy
```

An agent **does not change** `llm_policy`, not through the CLI, not through a tool, not even with a confirmation token (like the `embedding` section). It goes into git and reaches the other machines through `sync`: a policy loosened on another machine (or by anyone with write access to the remote) is loosened here too. That is accepted on purpose: whoever writes to the remote can already change the notes themselves, and each machine still decides whether to turn any provider on.

## Each provider's data policy

Checked on 2026-11-13. Check the current page before turning one on:

| Provider | What the policy says | Source |
| --- | --- | --- |
| Anthropic (API) | By default, inputs and outputs from commercial products are not used to train models | [privacy.claude.com](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) |
| Claude Code with Free, Pro or Max | Use for improving the models depends on your account's privacy setting | [privacy.claude.com](https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training) |
| OpenAI | API data is not used for training without opt-in; abuse monitoring logs kept up to 30 days | [developers.openai.com](https://developers.openai.com/api/docs/guides/your-data) |
| Google Gemini (API) | **Free tier:** what you send is used to improve products, and people may read it. **Paid tier:** not used; logs kept for a limited time to detect abuse | [aistudio.google.com](https://aistudio.google.com/docs/terms) |
| OpenRouter | Does not store prompts or responses unless you turn logging on; Cabeção asks only for providers that do not collect data (`data_collection: "deny"`) | [openrouter.ai](https://openrouter.ai/docs/guides/privacy/data-collection) |
| Groq | Does not retain request data by default; may log it for up to 30 days to investigate errors or abuse | [console.groq.com](https://console.groq.com/docs/your-data) |
| Ollama, LM Studio | Run on your machine | — |

:::warning[Gemini on the free tier]
On the Gemini API's free tier, passages from your notes may be read by Google's reviewers and used to improve its products. `llm on --provider gemini` warns you and asks whether your key belongs to a project with active billing. For personal notes, use the paid tier.
:::

## Costs

- **APIs (Anthropic, OpenAI, Gemini, OpenRouter, Groq):** you pay, in the provider's account, per token. A question sends ~3,000 tokens of context and gets a few hundred back. For a spending cap, set it in the provider's dashboard.
- **Claude Code:** comes out of your subscription limits (or the key Claude Code uses). In this guide's test run, one question cost US$ 0.0017 with `haiku`, according to Claude Code itself.
- **Local server:** no per-question charge.

The limits live in `limits` in [`llm.json`](../referencia/arquivos.md#answer-provider-llmjson): per question, `context_tokens` (default 3000, up to 8000), `max_output_tokens` (2048) and `timeout_ms` (60000); and a **spending cap**: `max_calls_per_hour` (default 30, counting every question on this machine) and `max_calls_per_session` (default 20 per MCP server session, that is, per open AI client). Once the cap is reached, `ask` returns `unavailable` (`limit_reached`) with the passages found, without calling the provider: an agent in a loop does not drain your account. Transient errors (rate limit, server down) get up to two retries, and a connection failure at most one, within the time limit. A redirect from the server is never followed: the key and the passages do not go to another address.

## Ask

```bash
cabecao ask "Que fila o Projeto Atlas usa hoje e por quê?"
```

A real run with Claude Code (`haiku`) on the project's example brain, with `--verbose` (the output is in Portuguese):

```text
Hoje o Projeto Atlas usa SQS como fila. A migração de RabbitMQ para SQS ocorreu em maio de 2026, com status vigente. [1]
O motivo registrado para a troca foi o custo operacional de manter o RabbitMQ, que o time operava por conta própria. A decisão está resumida na fonte de reunião de arquitetura de 2026-05-03. [1]
O RabbitMQ foi a fila do Projeto Atlas de janeiro a maio de 2026, mas esse fato está vencido e não vale mais como resposta atual. [2]
A migração em andamento é de novembro de 2026: dois dos cinco consumidores do Projeto Atlas passaram a ler do SQS em lotes de 10 mensagens. [3]
A leitura em lote foi registrada como migração de novembro de 2026, mas as notas não dizem qual fila os três consumidores restantes usam nem quando eles migram. [3]

Faltou no cérebro: As notas não trazem o conteúdo da seção "Consequência" da síntese sobre SQS, que é embutida na linha do tempo. Também não dizem qual fila os três consumidores restantes do Projeto Atlas usam hoje, nem se eles já foram migrados. Os trechos não detalham as razões técnicas além do custo operacional.

Fontes:
  [1] memory/facts/fato-atlas-usa-sqs.md · vigente · trust high · origin agent:claude-code
      "O Projeto Atlas migrou de RabbitMQ para SQS em maio de 2026 por custo operacional."
  [2] memory/facts/fato-atlas-usa-rabbitmq.md · vencido · trust high · origin human
      "O Projeto Atlas usou RabbitMQ como fila de janeiro a maio de 2026."
  [3] memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md › Migração dos consumidores para leitura em lote · vigente · trust medium · origin agent:claude-code
      "Dois dos cinco consumidores do [[Projeto Atlas]] passaram a ler do [[SQS]] em lotes de 10."
3 citação(ões) descartadas: rótulo inexistente ou texto que não está no trecho.

Diagnóstico (só para você; o agente não vê):
  provedor: claude-code · modelo haiku · destino: Anthropic, pelo Claude Code instalado (com o login da sua conta)
  busca: keyword · trechos recuperados 11 · enviados 11
  tokens: entrada 2 · saída 1615 · custo US$ 0,0017 · 8,4 s
```

Notice the three dropped citations: the model cited passages that did not contain the sentence, and Cabeção removed those citations instead of trusting them. (In this run the input token count did not yet add the part read from the cache; that has been fixed.)

In the terminal, each claim appears as soon as it arrives complete and checked; the sources come at the end. With `--json`, you get the same object the `ask` tool returns to agents, without the provider's or the model's name (`--verbose` adds a `diagnostics` block, only for you in the terminal: for an agent, the option is ignored).

| Exit code | When |
| --- | --- |
| `0` | The command worked: answered, answered with little support (`low_confidence`) or the brain does not have this (`not_found`); the `--json` `status` says which |
| `5` | No provider generated the answer (off, failed or cap reached): shows the passages found |
| `2` | Usage error |

Codes 3 and 4 are left out on purpose: across the whole CLI, they mean "needs your explicit request" and "only you, in the terminal".

Ctrl+C cancels the question and stops the provider (including the Claude Code process and whatever it opened).

## In agents: the `ask` tool

With a provider turned on, the MCP server starts announcing the [`ask`](../referencia/mcp.md#ask) tool, right after `search`. The agent sends only the question and search options; it does not choose or see the provider or the model, and the answer always has the same shape. If the provider fails, the tool returns `unavailable` with the passages found, and the agent answers on its own. The tool shows up in the next session: restart the AI client after `llm on`.

**What an agent sees of the provider: nothing.** Not the name, the model, the destination or the provider's error message, through any path: the `ask` tool, `cabecao ask` (with `--verbose` or `--show-context`), `llm status` (only "on" or "off"), `status` and `doctor`. Those details show up only for you, in the terminal. The `cabecao-consultar` skill teaches the agent to use `ask` through the CLI the same way.

## Where the key lives

| System | Where |
| --- | --- |
| macOS | Keychain, service `cabecao` (written by the `security` command, with the key on standard input, never on the command line) |
| Linux | Secret Service, through `secret-tool` (libsecret), when it exists; otherwise, the protected file |
| Windows | Encrypted with your Windows user's DPAPI, in `%APPDATA%\cabecao\credentials.dpapi.json` |
| Any, with `--store file` | `~/.config/cabecao/credentials.json`, with `0600` permission |

The provider's environment variable, when set, takes precedence over the stored key. The key never goes into the brain, `llm.json`, the log or an error message, and `llm status` shows only its last four characters. Note: an MCP server started by the AI client may not inherit your terminal's variables; for agents' `ask`, prefer storing the key.

Behind a proxy: Node's `fetch` only uses `HTTPS_PROXY` when that is switched on. Cabeção switches it on by itself where Node allows (`http.setGlobalProxyFromEnv`), always with this machine's addresses in `NO_PROXY`: a local server (Ollama, LM Studio) **never** goes through a tunnel to the proxy. With `NODE_USE_ENV_PROXY=1` and without `localhost,127.0.0.1` in `NO_PROXY`, Cabeção refuses to call the local server and says how to fix it. `llm status` tells you what applies on your machine.

The stored key is bound to the destination (the keychain account is `<provider>@<address>`): changing the provider's address does not hand the key to another server. The key file is closed (`0600`) before it receives the key, and a configuration folder other users of the machine can change is refused.

## See, test, turn off and delete

```bash
cabecao llm status          # providers, model, destination, where the key is (masked)
cabecao llm test            # one minimal call, with nothing from the brain: did it work? how long did it take?
cabecao llm off             # turns it off: nothing else leaves; the configuration and the key stay
cabecao llm remove openai   # deletes the provider and the key Cabeção stored (asks for confirmation)
cabecao llm policy          # this brain's sending policy (see above)
```

If the system keychain refuses to delete the key, `llm remove` says so and exits with an error, instead of saying "deleted". [`cabecao uninstall`](./atualizar.md) also deletes the answers configuration and the stored keys (in the keychain and in the file).

`cabecao status` and `cabecao doctor` show a neutral "Respostas (ask)" line (on, off, or optional and off). The provider never shows up at the end of `init` nor in the list of optional steps: turning it on is on demand, whenever you want.

## Measure

```bash
cabecao eval --answers fixtures/eval/respostas.jsonl
```

Measures, with your questions: valid citations, unsupported claims, right source cited, correct refusal (a question the brain does not answer, marked `"answerable": false`) and wrong refusal, with time and tokens. Each question is one call to the provider. See [`cabecao eval`](../referencia/cli.md#cabecao-eval---answers).

## Known limits

- **Tested:** the whole flow with a fake provider, both adapters against local servers that mimic the APIs, and one real run with Claude Code. **Not tested with real keys** for Anthropic, OpenAI, Gemini, OpenRouter and Groq, nor with each system's real keychain (the tests use a fake runner; on Windows, DPAPI is tested for real).
- **The check verifies the citation, not the conclusion.** A claim can cite a true passage and draw a wrong conclusion from it. For anything important, open the source (`cabecao search`, or `read` with the citation's `id`).
- **The confirmation signature protects against a forged `llm.json`, not against whoever reads your files.** An agent with a shell that reads your user folder can read the local secret, just as it can read your notes directly. The protection holds for the path Cabeção controls: the CLI and the tools.
- **The brain's policy travels through git.** Anyone with write access to the remote can loosen it (see above); each machine still decides whether to turn a provider on.
- **"Data, never instruction" is still guidance to the model.** Content goes delimited, outside content goes marked, and the answer executes nothing; even so, malicious text can influence the answer. Citation checking limits the damage.
