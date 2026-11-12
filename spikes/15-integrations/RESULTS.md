# Spike 15 — RESULTS

Executado em 2026-11-12, macOS (Darwin 27.0.0).

| Componente | Versão |
|---|---|
| Claude Code | 2.1.322 |
| Node | v24.21.0 |
| `@modelcontextprotocol/sdk` | 1.32.2 |
| `@anthropic-ai/mcpb` (CLI) | 2.1.2 |
| Obsidian | 1.15.0 (instalador 1.6.7) |
| Modelos nos testes | `claude-sonnet-5-5`, `claude-haiku-5-5` |

Legenda: **PROVADO** = executei e vi a saída. **DOC** = li na documentação oficial, não executei.
**PARCIAL** = parte executada, parte só documentada. **DERRUBADO** = a hipótese do plano não se sustenta.
**NÃO TESTADO** = sem evidência.

## Resumo dos vereditos

| # | Pergunta | Veredito |
|---|---|---|
| 1 | Plugin carrega MCP + skill via `--plugin-dir` | PROVADO |
| 2a | `SessionStart` injeta contexto | PROVADO (JSON e stdout puro) |
| 2b | Hook de fim roda em `claude -p` | PROVADO, com orçamento de 1,5 s que `timeout` de plugin não aumenta |
| 2c | `Stop` + `decision: block` para handoff sem loop | PROVADO com guarda; versão ingênua entra em laço longo |
| 2d | `PostToolUse` / `UserPromptSubmit` para captura bruta | PROVADO |
| 3 | Marketplace no mesmo repositório, subpasta | PROVADO com marketplace local; instalação a partir do GitHub é DOC |
| 4 | `claude mcp add --scope user` e idempotência | PROVADO |
| 5 | Onde pôr as instruções do agente | PROVADO (n=5 por mecanismo, 2 modelos) |
| 6 | Bundle `.mcpb` | PROVADO até `pack` + simulação do host; instalação no Desktop NÃO TESTADA |
| 7 | Outros clientes | DOC (pesquisa) |
| 8a | Pastas com ponto são ignoradas | PROVADO no app |
| 8b | `graph.json` com grupos de cor | PROVADO no app (com Obsidian fechado na hora de escrever) |
| 8c | Bases | PROVADO no motor do app; duas hipóteses de sintaxe DERRUBADAS |
| 8d | Relações tipadas no frontmatter | PROVADO; lista de objetos DERRUBADA como formato principal |
| 8e | JSON Canvas | PROVADO no app |
| 8f | Template do Web Clipper | PARCIAL (validado contra o código do importador, não importado na extensão) |
| 8g | `app.json` | PROVADO no app para 5 chaves |
| 8h | Obsidian Git + worktree | PARCIAL (git e indexação provados; plugin não executado) |
| 9 | CLI do Obsidian | PROVADO para os comandos listados |
| 10 | `cabecao obsidian setup` com merge seguro | PROVADO por script |

---

## Parte A — Claude Code

### 1. Plugin — PROVADO

Estrutura usada (`repo/integrations/claude-code/`), aceita por `claude plugin validate` (só um aviso de ícone ausente):

```
.claude-plugin/plugin.json
.mcp.json                      # "args": ["${CLAUDE_PLUGIN_ROOT}/server/cabecao-fake.mjs", "mcp"]
hooks/hooks.json               # chave "hooks" no topo
skills/cabecao-memory/SKILL.md
server/cabecao-fake.mjs        # bundle de arquivo único (esbuild), 1,4 MB
```

`claude -p ... --plugin-dir repo/integrations/claude-code` (`evidence/a1-plugin.summary.txt`):

- `init` reporta `mcp_servers: [{"name":"plugin:cabecao:cabecao","status":"connected","source":"plugin"}]`.
- Tools: `mcp__plugin_cabecao_cabecao__recall` e `mcp__plugin_cabecao_cabecao__remember`. O modelo chamou as duas; `calls.jsonl` do servidor registrou as chamadas.
- Skill listada como `cabecao:cabecao-memory` e invocável: `claude -p "/cabecao:cabecao-memory qual e a senha da skill?"` respondeu `JABUTICABA-7`, que só existe no `SKILL.md` (`evidence/a1-skill-invoke.summary.txt`).

Achados que mudam o desenho:

- **As tools MCP chegam adiadas.** Em todas as execuções o modelo precisou chamar `ToolSearch` antes de usar `recall`/`remember`. Isso custa um turno e faz o agente "esquecer" a memória quando nada o manda procurar (ver item 5).
- **`--strict-mcp-config` desliga o servidor MCP do plugin.** Com a flag, `init` veio com `mcp_servers: []`.
- **Servidor e hooks herdam o ambiente do shell** (`CABECAO_HOME` exportado antes do `claude` chegou aos dois).
- **Deduplicação:** com um servidor de escopo `user` de comando idêntico ao do plugin, `claude mcp list` mostrou só o do usuário; ao removê-lo, apareceu `plugin:cabecao-npx:cabecao`. Instalar plugin e `claude mcp add` ao mesmo tempo não duplica, mas um esconde o outro.

### 2. Hooks

#### (a) `SessionStart` injeta contexto — PROVADO

Prompt: "Sem usar nenhuma tool: qual é o codinome secreto do deploy? Responda NAO SEI se não tiver." (sonnet)

| Variante | Saída do hook | Resposta |
|---|---|---|
| `h1-sessionstart-json` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` | `ABACAXI-42` |
| `h1-sessionstart-plain` | texto puro no stdout | `ABACAXI-42` |
| `h1-control` | sem hook | `NAO SEI` |

Os dois formatos funcionam. O JSON é o recomendado porque permite outros campos (`sessionTitle`, `watchPaths`) e não mistura logs com contexto. DOC: `additionalContext` acima de 10.000 caracteres vira arquivo e o modelo recebe só o caminho e uma prévia de 2.000 caracteres, então o briefing precisa caber nesse limite.

Entrada recebida em stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` (`"startup"`). Duração medida: 155 ms.

#### (b) Hook de fim — PROVADO, com uma armadilha

`SessionEnd` roda em `claude -p`, com `reason: "other"`. `Stop` também roda, uma vez por turno.

| Experimento | Resultado |
|---|---|
| `SessionEnd` em settings, `sleep 5`, `"timeout": 30` | completou (5003 ms) |
| `SessionEnd` em settings, `sleep 5`, sem `timeout` | **cancelado em ~1,5 s** (`Hook cancelled`) |
| `SessionEnd` **de plugin**, `sleep 5`, `"timeout": 30` | **cancelado em ~1,5 s** |
| idem, com `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=20000` | completou |
| `SessionEnd` em settings, `sleep 90`, `"timeout": 120` | cancelado aos 60 s (teto) |
| `SessionEnd` que se destaca (`spawn` com `detached` + `unref`) | hook retorna de imediato, o sync termina 8 s depois, com o `claude` já encerrado |
| `SessionEnd` com exit 1 ou 2 | mensagem em stderr (`SessionEnd hook [...] failed: ...`), **exit do `claude` continua 0** |
| `Stop` com `sleep 4` | completou; atrasa o resultado do `-p` em 4 s |
| `Stop` com exit 1 | notificação `Stop hook error occurred`, turno termina normalmente, exit 0 |

A documentação confirma o comportamento: orçamento padrão de 1,5 s, elevado pelo maior `timeout` dos arquivos de settings até 60 s, e "timeouts set on plugin-provided hooks don't raise the budget". Timeout padrão dos demais hooks de comando: 600 s (30 s em `UserPromptSubmit`) — DOC.

Consequência: **um `cabecao sync` com `git push` não cabe num `SessionEnd` de plugin.** O hook precisa disparar o sync num processo destacado e retornar na hora. O plugin final faz isso e foi verificado (`evidence/a2-plugin-final/sync.log`: o `claude` saiu em 3 s e o sync terminou 6 s depois).

#### (c) `Stop` pedindo handoff — PROVADO com guarda; não recomendado como padrão

Hook devolve `{"decision":"block","reason":"...grave um handoff em <arquivo>..."}`.

- **Com guarda** (`stop_hook_active` verdadeiro ou arquivo de handoff da sessão já existe → `exit 0`): 1 continuação, o modelo gravou o arquivo com `Write` e encerrou. 3 turnos, US$ 0,068, contra 1 turno e US$ 0,022 da mesma pergunta sem hook.
- **Ingênuo** (bloqueia sempre, pedindo uma escrita): 15 disparos do `Stop`, 23 turnos, 64 s. O teto só atuou quando o modelo parou de chamar tools: "A hook blocked the turn from ending 9 consecutive times — overriding and ending turn". A documentação explica: a contagem de continuações consecutivas zera a cada chamada de tool. Um hook que pede uma ação com tool pode girar muito além do teto.

Vale a pena? Como padrão, não: triplica o custo de sessões triviais, atrasa todo fim de turno e depende de uma guarda que, se falhar, cria laço caro. Melhor capturar sem LLM (item d) e deixar o handoff como ação explícita (skill ou instrução "ao encerrar um trabalho relevante, chame `remember`/`handoff`").

#### (d) `PostToolUse` / `UserPromptSubmit` — PROVADO

Payloads reais em `evidence/a1-plugin/observations.jsonl`.

| Evento | Campos | Tamanho na amostra |
|---|---|---|
| `UserPromptSubmit` | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`, `prompt` | 643 bytes |
| `PostToolUse` | os comuns + `effort`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`; para tool MCP também `mcp_server: {name, source}` | 722–914 bytes |

Custo: 47–104 ms de parede por evento medidos pelo Claude Code, quase tudo arranque do Node (o trabalho interno do script levou 0,6–1,7 ms). O hook é síncrono, então esse tempo soma a cada tool. `tool_response` vem inteiro; não medi com saídas grandes (um `Read` de arquivo longo). A documentação cita `async: true` para hooks de comando; não testei.

### 3. Marketplace no mesmo repositório — PROVADO local, DOC para GitHub

`repo/.claude-plugin/marketplace.json`:

```json
{
  "name": "cabecao",
  "owner": { "name": "..." },
  "plugins": [{ "name": "cabecao", "source": "./integrations/claude-code", "description": "..." }]
}
```

Há CLI não interativa. Executado com `CLAUDE_CONFIG_DIR` isolado:

```bash
claude plugin validate <repo>                    # ✔ Validation passed
claude plugin marketplace add <caminho-do-repo>  # ✔ Successfully added marketplace: cabecao
claude plugin install cabecao@cabecao            # ✔ Successfully installed plugin (scope: user)
claude plugin list                               # Version 0.0.1, enabled
claude mcp list                                  # plugin:cabecao:cabecao ... ✔ Connected
```

Arquivos escritos: `settings.json` ganha `extraKnownMarketplaces` e `enabledPlugins`; `plugins/known_marketplaces.json` e `plugins/installed_plugins.json` guardam origem e versão.

Comando do usuário final (DOC; não executei contra o GitHub):

```bash
claude plugin marketplace add <owner>/cabecao
claude plugin install cabecao@cabecao
```

Dentro de uma sessão: `/plugin marketplace add <owner>/cabecao` e `/plugin install cabecao@cabecao`.

Atualização — PROVADO localmente:

- Mudar conteúdo sem mudar `version`: `claude plugin update` respondeu "already at the latest version (0.0.1)".
- Subir para `0.0.2`: `claude plugin marketplace update cabecao && claude plugin update cabecao@cabecao` → "updated from 0.0.1 to 0.0.2 ... Restart to apply changes".
- DOC: com `version` no `plugin.json`, o usuário só recebe atualização quando a string muda; sem `version`, a versão é o SHA do commit e cada commit é uma atualização. Não declarar `version` nos dois lugares.
- Marketplace adicionado por caminho local carrega o plugin "in place" (edições valem na próxima sessão), então o cache por versão só importa para origem git.
- Atualização automática de marketplace: não verifiquei.

`npx` no `.mcp.json` do plugin — PROVADO que funciona (`variants/plugin-npx-userconfig`, conectou via `npx -y --package=file:<tgz> cabecao-fake mcp`). Medidas com tarball local:

| Forma de subir | Tempo |
|---|---|
| `node <bundle>` | 0,05 s |
| `npx` com cache quente | 1,4 s |
| `npx` frio (tarball local, sem download de registro) | 2,9 s |

É melhor que embutir? **Para os hooks, não**: 1,4 s de `npx` quente consome quase todo o orçamento de 1,5 s do `SessionEnd` e soma a cada `PostToolUse`. Para o servidor MCP o `npx` é aceitável, mas cria duas versões em jogo (hooks do plugin e servidor do npm). Não medi `npx` baixando do registro.

Pasta do cérebro via `userConfig` — PROVADO: `plugin.json` com `userConfig.brain_dir`, `.mcp.json` com `"env": {"CABECAO_HOME": "${user_config.brain_dir}"}` e `claude plugin install cabecao-npx@cabecao-variants --config brain_dir=<pasta>`. O valor foi gravado em `settings.json` (`pluginConfigs`) e o servidor escreveu na pasta indicada. Não testei `${user_config.*}` dentro de comandos de hook.

### 4. Instalação sem plugin — PROVADO

```bash
claude mcp add cabecao --scope user -e CABECAO_HOME=<pasta> -- npx -y cabecao mcp
```

Escreve em `~/.claude.json` (no teste, `$CLAUDE_CONFIG_DIR/.claude.json`), na chave `mcpServers`:

```json
"cabecao": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "cabecao", "mcp"],
  "env": { "CABECAO_HOME": "<pasta>" }
}
```

`--scope project` escreve `.mcp.json` na pasta atual, com o mesmo formato.

Não é idempotente sozinho: repetir `mcp add` ou `mcp add-json` devolve "MCP server cabecao already exists in user config" com exit 1, e `mcp remove` de nome inexistente também sai com 1. Sequência idempotente verificada duas vezes seguidas (`install-claude-code.sh`):

```bash
claude mcp remove cabecao --scope user >/dev/null 2>&1 || true
claude mcp add-json cabecao --scope user '{"type":"stdio","command":"npx","args":["-y","cabecao","mcp"],"env":{"CABECAO_HOME":"<pasta>"}}'
```

Verificação pós-instalação: `claude mcp get cabecao` faz health-check (mostrou `CONNECTION_CLOSED` quando o comando estava errado e `✔ Connected` depois de corrigido).

Detalhe do `npx`: `npx -y <arquivo.tgz> mcp` falha ("Permission denied"); com pacote local é preciso `--package=file:<tgz> <bin>`. Com pacote publicado o formato `npx -y cabecao mcp` é o padrão, mas não foi executado (o pacote não existe).

### 5. Onde pôr as instruções — PROVADO (amostra pequena)

Seis mecanismos × cinco prompts, uma execução de `claude -p` por célula, em dois modelos (60 execuções). O servidor registra as chamadas em `calls.jsonl`, então a medida não depende do texto da resposta. `remember` era esperado em 2 dos 5 prompts ("Decidimos hoje que o banco oficial vai ser Postgres 17…", "Prefiro sempre usar pnpm…").

| Mecanismo | `recall` no início (sonnet) | `remember` quando devia (sonnet) | `recall` (haiku) | `remember` (haiku) |
|---|---|---|---|---|
| A. Só as tools, sem instrução | 1/5 | 0/2 | 0/5 | 0/2 |
| B. Campo `instructions` do servidor MCP | **5/5** | **2/2** | 4/5 | 1/2 |
| C. Só a skill do plugin | 2/5 | 1/2 | 0/5 | 0/2 |
| D. `CLAUDE.md` na pasta de trabalho | **5/5** | **2/2** | 4/5 | 1/2 |
| E. `SessionStart` injetando as regras | **5/5** | **2/2** | **5/5** | 1/2 |
| F. `SessionStart` injetando briefing + regra só de `remember` | 0/5 (não precisa) | **2/2** | 0/5 (não precisa) | 1/2 |

`remember` indevido: 0/3 em todos os mecanismos e modelos.

Leitura:

- Sem instrução o agente não usa a memória.
- A skill sozinha é o mecanismo mais fraco: só carrega quando o modelo decide invocá-la.
- `instructions`, `CLAUDE.md` e o hook empatam no sonnet; no haiku o hook foi o único com 5/5 de `recall`.
- O mecanismo F é o mais barato: o briefing já chega no contexto, então `recall` no início deixa de ser necessário (economiza o `ToolSearch` e a chamada) e `remember` continua sendo chamado.
- O haiku perdeu a preferência "pnpm" em todos os mecanismos (1/2): regra de `remember` é menos confiável em modelo pequeno.

Ressalvas: n=5 por célula, um prompt por execução, só Claude Code. O sandbox ficava dentro do repositório com `bypassPermissions`; no mecanismo A o modelo achou o codinome com `grep` nos arquivos do spike, e a única chamada de `recall` do baseline no sonnet veio depois desse `grep` (o 1/5 está inflado). `CLAUDE.md` só vale quando a sessão é aberta na pasta que o contém.

---

## Parte B — Claude Desktop (MCPB)

### 6. Bundle `.mcpb` — PROVADO até o empacotamento; instalação NÃO TESTADA

Pacote confirmado: `@anthropic-ai/mcpb` 2.1.2, binário `mcpb`, comandos `init`, `validate`, `pack`, `unpack`, `sign`, `verify`, `info`, `clean`. O repositório da spec passou para `modelcontextprotocol/mcpb`.

Manifest usado (`mcpb/bundle/manifest.json`), resumido:

```json
{
  "manifest_version": "0.4",
  "name": "cabecao", "version": "0.0.1", "description": "...", "author": { "name": "..." },
  "server": {
    "type": "node",
    "entry_point": "server/cabecao-fake.mjs",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/cabecao-fake.mjs", "mcp"],
      "env": { "CABECAO_HOME": "${user_config.brain_dir}" }
    }
  },
  "user_config": {
    "brain_dir": { "type": "directory", "title": "Pasta do cerebro", "description": "...", "required": true, "default": "${HOME}/cabecao" }
  },
  "compatibility": { "platforms": ["darwin", "win32", "linux"], "runtimes": { "node": ">=20.0.0" } }
}
```

Executado:

- `mcpb validate` → "Manifest schema validation passes!" com `manifest_version` 0.4 e também 0.3.
- Negativo: sem `author` e com `user_config.brain_dir.type: "folder"` → erro listando os dois campos, exit 1.
- `mcpb pack` → `cabecao-0.0.1.mcpb`, zip de 241,7 kB (1,4 MB descompactado, 2 arquivos), "Not signed".
- `mcpb unpack` + `simulate-desktop.mjs` (substitui `${__dirname}` e `${user_config.brain_dir}` como o host faria): `initialize`, `tools/list` (`recall`, `remember`) e `tools/call remember` funcionaram e a linha foi gravada na pasta escolhida.

Versão do manifest: `mcpb init -y` gera `"manifest_version": "0.2"`; o `MANIFEST.md` diz "Current version: 0.3"; o schema mais novo do pacote é 0.4. Usar **0.3**, que é o que a spec declara como atual e que validou. O valor de `compatibility.claude_desktop` que deixei no arquivo (`>=0.10.0`) é um exemplo meu, sem base: remover ou confirmar antes de publicar.

Embutir `node_modules` ou chamar `npx`?

| Variante | Tamanho do `.mcpb` | Arquivos |
|---|---|---|
| Bundle de arquivo único (esbuild) | 241,7 kB | 2 |
| `node_modules` de produção embutido | 3,8 MB | 2.374 |
| `command: "npx"` (`npx -y cabecao mcp`) | 928 bytes | 2 |

A variante `npx` passa na validação do schema, mas a spec diz "All dependencies must be bundled" e a doc vende o MCPB como "bundled Node.js runtime, no dependencies to manage"; o Node vem com o Claude Desktop em macOS e Windows, e não há garantia documentada de que `npx` esteja no PATH do host. Recomendação: bundle de arquivo único. Se o servidor real tiver dependência nativa (por exemplo SQLite ou embeddings), o arquivo único deixa de bastar e será preciso `node_modules` por plataforma; isso não foi testado aqui.

Distribuição e atualização (DOC, `claude.com/docs/connectors/building/mcpb`):

- O usuário instala com duplo clique, arrastando para a janela, ou em Settings > Extensions > Advanced settings > Install Extension.
- "Desktop extension listings in the directory are deprecated, and the directory no longer accepts MCPB submissions." Para aparecer no diretório, o servidor local tem de ir dentro de um plugin.
- A página não descreve atualização automática para `.mcpb` instalado à mão. Assumo reinstalação manual do arquivo novo; não verifiquei.
- Caminho prático: anexar `cabecao-<versão>.mcpb` a cada GitHub Release.

### 7. Outros clientes — DOC (pesquisa, nada executado)

Lido por um subagente via resumos das páginas oficiais; conferir flags literais antes de codificar.

| Cliente | Arquivo | Raiz | CLI para adicionar |
|---|---|---|---|
| Codex CLI | `~/.codex/config.toml` (projeto: `.codex/config.toml`) | `[mcp_servers.<nome>]` | `codex mcp add cabecao --env CABECAO_HOME=<pasta> -- npx -y cabecao mcp` |
| Cursor | `~/.cursor/mcp.json` (projeto: `.cursor/mcp.json`) | `mcpServers` | não há `add`; editar o JSON com merge ou gerar deeplink `cursor://anysphere.cursor-deeplink/mcp/install?name=cabecao&config=<base64>` |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` e `.mcp.json` do workspace (raiz `mcpServers`); legado `.vscode/mcp.json` (raiz `servers`) | ver ao lado | `code --add-mcp '<json>'` grava no formato legado |
| Gemini CLI | `~/.gemini/settings.json` (projeto: `.gemini/settings.json`) | `mcpServers` | `gemini mcp add -s user -e CABECAO_HOME=<pasta> cabecao npx -y cabecao mcp` |

```toml
# Codex
[mcp_servers.cabecao]
command = "npx"
args = ["-y", "cabecao", "mcp"]

[mcp_servers.cabecao.env]
CABECAO_HOME = "/caminho/do/cerebro"
```

```json
{ "mcpServers": { "cabecao": { "type": "stdio", "command": "npx", "args": ["-y", "cabecao", "mcp"], "env": { "CABECAO_HOME": "/caminho/do/cerebro" } } } }
```

Notas da pesquisa:

- VS Code: a doc marca `.vscode/mcp.json` como formato do harness antigo, com remoção anunciada para fevereiro de 2027. Para cobrir instalações antigas e novas seria preciso gravar os dois.
- Gemini: escopo padrão de `mcp add` é `project`; usar `-s user`. Servidores stdio só conectam em pasta confiável.
- Os quatro têm hooks de início e fim de sessão, com nomes e esquemas diferentes (`SessionStart`/`SessionEnd` no Codex e no Gemini, `sessionStart`/`sessionEnd` no Cursor e no VS Code, este em preview).
- Instruções: `AGENTS.md` (Codex), `GEMINI.md` (Gemini, configurável para aceitar `AGENTS.md`).
- Não confirmado: comportamento de `add` com nome repetido em Codex e Gemini, flag de escopo de projeto no Codex, caminho físico do `mcp.json` de perfil do VS Code, caminhos no Windows.

---

## Parte C — Obsidian

Método: segunda instância do Obsidian com `--user-data-dir` próprio, contendo só o vault de teste. A CLI recebeu a mesma flag e respondeu `vault-test`; o `obsidian.json` global ficou com a data de modificação original. Tudo que está como "PROVADO no app" veio dessa instância (1.15.0).

### 8a. Pastas com ponto — PROVADO no app

`vault-test/.cabecao/` contém uma nota com link para `[[Orfa]]` e um JSON.

- `obsidian files` lista 28 arquivos, nenhum em `.cabecao/`; `obsidian folders` não lista a pasta; o explorador de arquivos mostra só `bases`, `raw`, `wiki` (screenshots).
- `obsidian backlinks file=Orfa` → "No backlinks found." O link da nota oculta não foi indexado.
- O graph não tem nó de `.cabecao` (`hasHidden: false`).
- Uma cópia de `SQS.md` em `.cabecao/worktrees/sync/` não mudou a contagem de arquivos nem criou nota duplicada.

A ajuda oficial só afirma isso para o Sync ("Files and folders beginning with a `.` are treated as hidden and excluded from sync"); para o índice a evidência é a execução.

### 8b. `graph.json` — PROVADO no app

O formato não é documentado; as chaves vieram de arquivos reais e foram aceitas pelo app. Gerado por `setup-obsidian.mjs`:

```json
{
  "collapse-filter": false,
  "search": "-path:bases -path:maps",
  "showTags": false, "showAttachments": false, "hideUnresolved": false, "showOrphans": true,
  "collapse-color-groups": false,
  "colorGroups": [
    { "query": "tag:#cabecao/needs-review", "color": { "a": 1, "rgb": 14041247 } },
    { "query": "[status:superseded]",       "color": { "a": 1, "rgb": 5987174 } },
    { "query": "path:wiki/concepts",        "color": { "a": 1, "rgb": 5017087 } },
    { "query": "path:wiki/decisions",       "color": { "a": 1, "rgb": 15026253 } },
    { "query": "path:wiki/facts",           "color": { "a": 1, "rgb": 3187820 } },
    { "query": "path:wiki/memories",        "color": { "a": 1, "rgb": 16098596 } },
    { "query": "path:raw",                  "color": { "a": 1, "rgb": 9145752 } }
  ],
  "collapse-display": true, "showArrow": true,
  "textFadeMultiplier": 0, "nodeSizeMultiplier": 1, "lineSizeMultiplier": 1,
  "collapse-forces": true, "centerStrength": 0.5, "repelStrength": 10, "linkStrength": 1, "linkDistance": 250,
  "scale": 1, "close": false
}
```

Verificado lendo o renderer do graph e por screenshot (`evidence/obsidian/shot-graph.png`):

- `rgb` é inteiro decimal `0xRRGGBB`: os nós saíram com as cores `4c8dff`, `e5484d`, `30a46c`, `f5a524`, `8b8d98`.
- **O primeiro grupo que casa define a cor.** Com `[status:superseded]` depois de `path:wiki/decisions`, a decisão substituída ficou vermelha; com ele antes, ficou `5b5b66`. Grupos específicos vão primeiro.
- `search: "-path:bases -path:maps"` tira os `.base` e `.canvas` do graph (28 nós → 23). Sem isso eles aparecem como nós soltos, mesmo com "Attachments" desligado.
- Consultas testadas na busca do app: `path:wiki/facts` (4), `[type:decision]` (2), `tag:#cabecao/decision` (2), `[status:superseded]` (1), `[uses:SQS]` (2). O grupo `tag:` não foi testado com nota que case.
- **DERRUBADO: editar `graph.json` com o Obsidian aberto.** A edição externa não foi recarregada e foi sobrescrita quando a aba do graph fechou. O setup tem de rodar com o vault fechado.

### 8c. Bases — PROVADO no motor do app

Cinco arquivos em `vault-test/bases/`, todos executados com `obsidian base:query ... format=csv` em todas as views (`evidence/obsidian/bases-query.txt`), com resultados conferidos contra os dados sintéticos:

| Arquivo | Views | Resultado |
|---|---|---|
| `Memorias ativas.base` | `Ativas` (table), `Cartoes` (cards) | 3 memórias ativas; arquivada e `needs_review` fora |
| `Precisam de revisao.base` | `Fila de revisao` (table, `groupBy`) | 5 linhas: marcada, nunca revisada (3), revisão com mais de 90 dias |
| `Decisoes.base` | `Todas`, `Vigentes`, `Cartoes` | 2 e 1 linhas; `sort` por `decided_at DESC` respeitado |
| `Fatos validos hoje vs expirados.base` | `Validos hoje`, `Expirados`, `Todos por situacao` | 2 válidos (um sem `valid_until`), 1 expirado, 1 futuro |
| `Saude do cerebro.base` | `Orfas`, `Sem tipo`, `Sem ninguem apontando`, `Grau de conexao` | 1 órfã, 1 sem tipo, contagens de backlinks corretas |

Sintaxe confirmada em execução: `filters` com `and`/`or`, `file.inFolder("wiki")`, `file.hasProperty("type")`, `file.ext == "md"`, `file.backlinks.length`, `file.links.length`, `file.mtime.relative()`, `today()`, `reviewed_at < today() - "90d"`, `if(cond, a, b)`, `formulas`, `properties.<id>.displayName`, views `table` e `cards` com `order`, `groupBy: {property, direction}`, `sort: [{property, direction}]` e `filters` por view.

Duas hipóteses DERRUBADAS pela sonda `evidence/obsidian/bases-null-and-date-probe.csv`:

| Expressão sobre propriedade ausente | Resultado |
|---|---|
| `!reviewed_at` | vazio, **não** `true` — o filtro descarta a nota |
| `reviewed_at == null` | `true` |
| `reviewed_at.isEmpty()` | `true` |
| `file.hasProperty("reviewed_at")` | `false` |
| `if(reviewed_at, "tem", "nao tem")` | `nao tem` |

- **Nulo:** usar `prop == null`. `!prop` e `!prop || ...` falham em silêncio (a primeira versão de "Precisam de revisão" e de "Válidos hoje" perdia justamente as notas sem a propriedade).
- **Datas:** `(today() - date) / duration("1d")` dá "Error: Invalid operator between Duration and Duration". Funciona `(today() - reviewed_at).days` (256 para 2026-03-01).

Não validado visualmente: a aparência da view `cards` (só a consulta foi executada). Chaves de aparência (`image`, `cardSize`, `columnSize`) não são documentadas e não foram usadas.

### 8d. Relações tipadas no frontmatter — PROVADO

Quatro formatos, cada um como único link da nota (sem links no corpo):

| Formato | Exemplo | `frontmatterLinks` | Backlink | Aresta no graph | Painel de propriedades | Busca / grupo de cor |
|---|---|---|---|---|---|---|
| V1 lista de objetos | `relations: [{type: uses, target: "[[Postgres]]"}]` | `relations.0.target` | sim | sim | JSON cru em laranja, tipo desconhecido, não editável | `[relations:Postgres]` → nada |
| V2 lista por tipo | `uses: ["[[SQS]]"]` | `uses.0` | sim | sim | links clicáveis, editáveis | `[uses:SQS]` → 2 notas |
| V3 texto único | `depends_on: "[[Redis]]"` | `depends_on` | sim | sim | link | não testado |
| V4 mapa aninhado | `relations: {uses: ["[[Kafka]]"]}` | `relations.uses.0` | sim | sim | JSON cru em laranja (`{"uses":["[[Kafka]]"]}`), tipo desconhecido | não testado |

Evidência: `evidence/obsidian/frontmatter-links.json`, `graph-renderer.json` (19 arestas, incluindo `Servico de checkout -> Postgres` e `Gateway -> Kafka`), `shot-v1-list-of-objects.png`, `shot-v2-list-per-type.png`, `shot-v4-nested-map.png`.

- Wikilinks em propriedades viram backlinks e arestas no graph em todos os formatos, inclusive aninhados. Isso contraria a expectativa de que só propriedades planas fossem indexadas.
- O Obsidian não corrompeu a lista de objetos: `obsidian property:set name=confidence value=0.95` em notas V1, V2 e V4 mudou só a linha editada (`diff` de uma linha). Isso foi pela CLI; não editei pelo painel com o mouse.
- O que derruba V1 é a usabilidade: o painel mostra `[{"type":"uses","target":"[[Postgres]]"},...` como texto, sem edição, e a propriedade não é consultável em busca, grupo de cor ou coluna de Base. V2 aparece como coluna (`note.uses` na base de decisões mostrou `[[SQS]]`).

**Recomendação de modelo de dados: V2, uma propriedade de lista por tipo de relação**, com wikilinks entre aspas:

```yaml
uses:
  - "[[SQS]]"
replaces:
  - "[[RabbitMQ]]"
supersedes:
  - "[[Usar RabbitMQ]]"
```

Registrar cada tipo em `.obsidian/types.json` como `multitext`. Limite: V2 não carrega metadados por aresta (confiança, data, fonte). Se o Cabeção precisar disso, guardar no índice próprio em `.cabecao/` e manter no frontmatter só os links.

### 8e. JSON Canvas — PROVADO no app

`make-canvas.mjs` gera `maps/Mapa do cerebro.canvas` a partir das relações do frontmatter: 27 nós (4 `group`, 22 `file`, 1 `text`) e 10 arestas com `label` igual ao tipo da relação. `validate-canvas.mjs` confere campos obrigatórios, enums e referências segundo a spec 1.0. No app: `{"nodes":27,"edges":10,"fileNodesResolved":22,"labels":10}` e screenshot `shot-canvas.png` com grupos coloridos e arestas rotuladas. IDs são determinísticos (hash do caminho), então reexportar não embaralha o arquivo.

### 8f. Web Clipper — PARCIAL (não importado na extensão)

`obsidian/web-clipper/cabecao-article-clipper.json`: `schemaVersion: "0.1.0"`, `behavior: "create"`, `path: "raw/articles"`, `noteNameFormat: "{{date|date:\"YYYY-MM-DD\"}} {{title|safe_name}}"`, propriedades `type`, `status`, `title`, `source`, `site`, `author`, `published`, `captured`, `description`, `tags`.

Validado contra o código do importador (`src/utils/import-export.ts` do `obsidianmd/obsidian-clipper`): campos obrigatórios `name`, `behavior`, `properties`, `noteContentFormat` (mais `noteNameFormat` e `path` fora de daily note); tipos de propriedade aceitos `text`, `multitext`, `number`, `checkbox`, `date`, `datetime`. Não importei na extensão do navegador nem capturei uma página, então o resultado dos filtros (`split`, `wikilink`, `safe_name`) não foi visto.

### 8g. `app.json` — PROVADO no app para cinco chaves

```json
{
  "newLinkFormat": "shortest",
  "useMarkdownLinks": false,
  "alwaysUpdateLinks": true,
  "attachmentFolderPath": "raw/assets",
  "userIgnoreFilters": ["raw/assets/"]
}
```

`app.vault.getConfig(...)` devolveu exatamente esses valores. `types.json` também foi lido (`valid_until: date`, `confidence: number`, `uses: multitext`). `core-plugins.json` de vault novo já traz `bases: true` e `canvas: true`.

DOC sobre `userIgnoreFilters` ("Excluded files"): esconde de Search, Graph e menções não vinculadas, e reduz destaque no Quick Switcher e nas sugestões de link; não tira do explorador de arquivos. Não testei o efeito na prática, nem se Bases respeita a exclusão. Os nomes das chaves não são documentados oficialmente.

### 8h. Obsidian Git — PARCIAL (plugin não executado)

Do código do plugin (`src/constants.ts`, v2.43.0), os padrões já são passivos: `autoSaveInterval`, `autoPushInterval`, `autoPullInterval` em `0`, `autoPullOnBoot` e `autoBackupAfterFileChange` em `false`. Para conviver com um sync externo, manter esses valores e acrescentar `disablePush: true` e `refreshSourceControl: false` (`obsidian/obsidian-git/data.recommended.json`). Isso é leitura de código, sem execução.

Worktree extra dentro do vault — PROVADO no nível do git (`evidence/obsidian/git-worktree.txt`):

- `git worktree add .cabecao/worktrees/sync -b cabecao-sync` funciona; o `.git` do worktree é um arquivo `gitdir: ...`.
- Sem `.gitignore`, o worktree principal mostra `?? .cabecao/`. **`.cabecao/` precisa estar no `.gitignore`.**
- Cada worktree tem índice próprio (`.git/index` e `.git/worktrees/sync/index`), então commits do sync externo não disputam `index.lock` com o plugin.
- Commits no worktree não mexem nos arquivos do vault até um merge feito a partir do worktree principal.
- O git recusa mover o branch em uso ("cannot force update the branch 'main' used by worktree"). `git update-ref` direto contorna a proteção e deixa o vault com diferenças fantasma (`D wiki/C.md`): o sync não pode fazer isso.
- O Obsidian não enxerga o worktree (item 8a).

Não testado: o plugin Obsidian Git rodando com esse arranjo. A documentação dele não menciona worktrees.

### 9. CLI do Obsidian — PROVADO para os comandos abaixo

A CLI é o próprio binário do app (`/Applications/Obsidian.app/Contents/MacOS/Obsidian`); depende de `"cli": true` no `obsidian.json` e conversa com a instância em execução. Ajuda completa em `evidence/obsidian-help.txt`.

Executados na instância isolada: `version`, `vault`, `vaults verbose`, `files`, `folders`, `backlinks`, `orphans`, `unresolved`, `search`, `bases`, `base:query`, `open`, `command id=graph:open`, `property:set`, `eval`, `dev:screenshot`.

Úteis para um instalador ou para `cabecao doctor`:

- `obsidian vaults verbose` — descobre se o vault já está registrado e onde.
- `obsidian vault=<nome> open path=<arquivo>` — abre uma nota ou base depois do setup.
- `obsidian vault=<nome> base:query path=<x.base> format=json` — valida os `.base` gerados no motor real.
- `obsidian vault=<nome> backlinks|orphans|unresolved` — checagens de saúde sem reimplementar o índice.
- `plugin:install id=<id> enable`, `plugins:restrict`, `reload`, `restart` — constam na ajuda; não executei.

Limites vistos na ajuda: não há comando para registrar um vault novo por caminho, nem para escolher o perfil; `vault=<name>` só alcança vaults conhecidos. Registrar um vault continua sendo ação do usuário ("Open folder as vault") ou edição do `obsidian.json` global, que não fiz. O instalador é antigo (1.6.7) e a CLI avisa "Your Obsidian installer is out of date".

### 10. `cabecao obsidian setup` — PROVADO por script

Protótipo: `obsidian/setup-obsidian.mjs <vault> [--dry-run]`.

Vault novo — escreve três arquivos:

- `.obsidian/app.json` — o conteúdo do item 8g.
- `.obsidian/graph.json` — o conteúdo do item 8b.
- `.obsidian/types.json`:

```json
{
  "types": {
    "created": "date", "reviewed_at": "date", "decided_at": "date",
    "valid_from": "date", "valid_until": "date", "captured": "date", "published": "date",
    "confidence": "number",
    "uses": "multitext", "replaces": "multitext", "supersedes": "multitext", "about": "multitext", "depends_on": "multitext",
    "type": "text", "status": "text", "source": "text"
  }
}
```

Fora de `.obsidian/`, o setup também deve gerar `bases/*.base` (os cinco deste spike), acrescentar `.cabecao/` ao `.gitignore` e, opcionalmente, o template do Web Clipper.

Não escrever: `workspace.json`, `appearance.json`, `core-plugins.json` (o app cria; Bases e Canvas já vêm ligados) e nada em `.obsidian/plugins/`.

Vault existente — regras de merge, verificadas em `existing-vault-sample/` (`evidence/obsidian/merge-dry-run.txt`):

| Arquivo | Regra | Verificado |
|---|---|---|
| `app.json` | só define chave ausente; `userIgnoreFilters` é união | `newLinkFormat: "relative"` do usuário mantido; lista virou `["private/", "raw/assets/"]` |
| `graph.json` | acrescenta grupos cuja `query` não existe, depois dos do usuário; não toca em mais nada | filtros, forças e `scale` idênticos; grupo `path:wiki/facts` do usuário manteve a cor |
| `types.json` | acrescenta tipos ausentes; conflito mantém o do usuário e avisa | `created: datetime` mantido |

Também verificado: `--dry-run` imprime `diff -u` sem escrever; backup dos originais em `.cabecao/backups/obsidian-<timestamp>/`; escrita atômica (arquivo temporário + rename); segunda execução responde "sem mudanças" nos três arquivos; JSON inválido existente não é tocado (regra implementada, sem caso de teste).

Falta no protótipo: detectar o Obsidian aberto naquele vault e recusar. Hoje só há um aviso, e o item 8b mostrou que o app sobrescreve `graph.json`.

---

## Recomendações fechadas

### Distribuição

1. **Claude Code: plugin + marketplace no próprio repositório.** `.claude-plugin/marketplace.json` na raiz com `"source": "./integrations/claude-code"`. Usuário roda `claude plugin marketplace add <owner>/cabecao` e `claude plugin install cabecao@cabecao`.
2. **Servidor embutido no plugin como bundle de arquivo único**, chamado com `node "${CLAUDE_PLUGIN_ROOT}/server/..."`, por causa do custo de `npx` nos hooks. Como o marketplace clona o repositório sem passo de build, o bundle precisa estar commitado (ou num branch de release); isso é desenho, não foi testado contra o GitHub.
3. **Versão:** manter `version` só no `plugin.json` e subir a cada release.
4. **Caminho sem plugin:** `cabecao install-client claude-code` executando `claude mcp remove ... || true` seguido de `claude mcp add-json ... --scope user`. Não instalar os dois caminhos juntos (deduplicação).
5. **Claude Desktop:** `.mcpb` com o mesmo bundle de arquivo único, `manifest_version` 0.3, `user_config.brain_dir` do tipo `directory`, anexado ao GitHub Release. Sem diretório oficial e sem atualização automática documentada.

### Hooks

| Hook | Comando | Formato |
|---|---|---|
| `SessionStart` | `cabecao recall --hook` | stdout com `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<briefing + regras>"}}`, abaixo de 10.000 caracteres |
| `SessionEnd` | `cabecao sync --detach` | retorna em milissegundos e deixa o sync num processo destacado; nunca depender de `timeout` do plugin |
| `UserPromptSubmit`, `PostToolUse` | `cabecao observe` | lê o JSON de stdin e anexa a um JSONL; sem LLM; ~50–100 ms por evento |
| `Stop` com `decision: block` | não usar por padrão | se virar opção, exigir a guarda `stop_hook_active` + marcador por sessão |

### Instruções do agente

1. `SessionStart` injeta o briefing e uma regra curta de `remember` (mecanismo F). É o que cobre o Claude Code com menos turnos.
2. Campo `instructions` do servidor MCP com as mesmas regras, nomeando as tools. Cobre a instalação sem plugin e, em tese, outros clientes (só medi no Claude Code).
3. Skill como referência de procedimentos longos (handoff, manutenção), não como gatilho.
4. `CLAUDE.md`/`AGENTS.md` do vault só ajuda em sessões abertas dentro do vault.

### Frontmatter de relações

Uma propriedade de lista por tipo de relação, wikilinks entre aspas, tipos registrados como `multitext` (item 8d). Nulo em Bases sempre com `== null`.

### `cabecao obsidian setup`

Conteúdo e regras do item 10, rodando com o vault fechado, com `--dry-run`, backup e diff.

---

## O que ficou sem teste

| Item | Por quê |
|---|---|
| Instalação do plugin a partir do GitHub e atualização automática de marketplace | exigiria publicar o repositório; só marketplace local |
| Sessão real com plugin instalado (não `--plugin-dir`) | o `CLAUDE_CONFIG_DIR` isolado não tem login; validei com `plugin list` e `mcp list` |
| Sessão interativa (`/exit`, `/clear`, `Stop` em vários turnos) | só `claude -p` |
| `npx` baixando do registro; `npx -y cabecao mcp` literal | o pacote não existe; usei tarball local |
| `${user_config.*}` em comandos de hook; `async: true` | não executado |
| `PostToolUse` com `tool_response` grande | não medido |
| Instalar o `.mcpb` no Claude Desktop; assinatura; atualização | proibido pelo escopo; host simulado por script |
| Campo `instructions` no Claude Desktop e em outros clientes | só Claude Code |
| Codex, Cursor, VS Code, Gemini | pesquisa, nada instalado |
| Importar o template na extensão Web Clipper | sem navegador no escopo |
| Plugin Obsidian Git em execução | não instalado; só código e git |
| Edição de propriedades pelo painel com o mouse; aparência da view `cards` | usei a CLI e consultas |
| Efeito prático de `userIgnoreFilters`; grupo `tag:` com nota que case | não exercitados |
| Obsidian mobile, Windows e Linux | só macOS |
