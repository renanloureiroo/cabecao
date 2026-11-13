---
title: Consolidar com um agente
description: Deixe o Cabeção chamar o Claude Code ou o Codex para consolidar a memória sozinho, sem você olhando, e desfaça se não gostar.
sidebar_position: 11
---

A consolidação junta episódios que se repetem num fato, num procedimento ou numa armadilha, funde notas duplicadas e corrige o que o `lint` acha. Quem raciocina é um agente de IA: o Cabeção não tem modelo próprio. Com `cabecao consolidate --run`, o Cabeção chama o agente sozinho, em modo não interativo, e confere o resultado.

```bash
cabecao consolidate --run
```

## O que acontece

1. O Cabeção cria o ponto de restauração (a tag `cabecao/restore/<data>-<id>`) e separa o material: episódios parecidos, notas parecidas e achados do `lint`.
2. Chama o agente com um roteiro e esse material. O agente lê o cérebro, grava pelas tools do Cabeção e termina chamando `consolidate` com `action: "finish"`.
3. Quando o agente sai, o Cabeção olha o git:
   - **fechou:** mostra uma linha por nota tocada e como desfazer;
   - **terminou sem gravar nada:** diz isso, e nada muda;
   - **não fechou** (erro, tempo limite, Ctrl+C, ou saiu sem `finish`): desfaz o que o agente gravou, diz o motivo e sai com código `1`. Fechar a metade num commit deixaria uma fusão pela metade (a nota nova sem a sobra arquivada, por exemplo) sem ninguém ter olhado; desfazer é o caminho reversível.

Uma execução real, no cérebro de exemplo:

```text
$ cabecao consolidate --run --agent claude-code --timeout 5
cabecao: Claude Code (escolhido com --agent) vai consolidar o cérebro sem ninguém olhando; tempo limite 5 min 0 s. Ponto de restauração: cabecao/restore/2026-11-13-104416-388-01M7AJDQ796TP2A9ZCSAV7R9VT.
Agente: Claude Code (escolhido com --agent), 13 s, 9 turno(s), US$ 0.0069.
Consolidação 01M7AJDQ796TP2A9ZCSAV7R9VT fechada no commit ce3fb9fee3:
  - update fact: Projeto Atlas uses_queue SQS
  - update concept: Fila de mensagens

Para desfazer: cabecao undo --session 01M7AJDQ796TP2A9ZCSAV7R9VT
Ponto de restauração: cabecao/restore/2026-11-13-104416-388-01M7AJDQ796TP2A9ZCSAV7R9VT (git reset --hard cabecao/restore/2026-11-13-104416-388-01M7AJDQ796TP2A9ZCSAV7R9VT volta a ele, descartando o que veio depois).
```

O agente trocou o link quebrado `[[Kafka]]` por texto e pôs o link que faltava em "RabbitMQ", os dois achados do `lint` daquele cérebro. Quando o agente termina bem sem ter o que mudar, a saída diz "o agente terminou sem gravar nada; o cérebro está como antes" e o código é `0`.

A saída completa do agente fica em `~/.cache/cabecao/consolidate-runs/<id>.log`, só para o seu usuário.

## Desfazer

```bash
cabecao undo --session 01M7AJDQ796TP2A9ZCSAV7R9VT
```

desfaz a consolidação inteira com um commit de revert; desfazer esse undo refaz tudo. O ponto de restauração continua na máquina: `git reset --hard <tag>` volta a ele, descartando tudo o que veio depois (inclusive o que não é da consolidação). Mais em [Desfazer](./desfazer.md).

## Agentes {#agentes}

O Cabeção só chama um agente sozinho quando duas coisas valem, conferidas na fonte oficial: os **termos** do agente permitem que outro programa o rode com a credencial em uso, e dá para **restringi-lo** às tools do Cabeção em modo não interativo.

| Agente | `--agent` | Registro de MCP (`install-client`) | `--run` | Por quê |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | sim | sim | Os termos permitem rodar o `claude` sem modificação com a sua assinatura ou chave de API ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)); dá para carregar só o servidor do Cabeção e tirar todas as tools embutidas |
| Codex | `codex` | sim | só com chave de API | A OpenAI orienta usar chave de API em uso programático ([Authentication](https://learn.chatgpt.com/docs/auth)): o `--run` exige `CODEX_API_KEY` ou `OPENAI_API_KEY` e não usa o login do ChatGPT. Dá para ignorar a sua configuração, tirar o shell e prender a escrita numa caixa de areia somente leitura |
| Antigravity (`agy`) | `antigravity` | sim | não | A [FAQ do Antigravity](https://antigravity.google/docs/faq/) diz que chamar o `agy` de dentro de outros agentes ou aplicativos "is not supported under consumer plans" e que usar software de terceiros para acessá-lo viola os termos, com risco de suspensão da conta. Consolide numa sessão do próprio Antigravity: peça para seguir o prompt `consolidate` do Cabeção, com o servidor registrado por `cabecao install-client antigravity` |
| Gemini CLI | `gemini` | sim | não | Deixou de atender contas pessoais em 18/06/2026 e foi substituído pelo Antigravity, com os mesmos termos |
| Cursor Agent | `cursor` | sim | não | Em modo não interativo ele tem acesso a todas as tools, inclusive shell e escrita, e a documentação não diz o que acontece com uma ação não liberada sem ninguém olhando |
| GitHub Copilot CLI, OpenCode | `copilot`, `opencode` | VS Code: sim | não | Têm opções para restringir as tools, mas os termos e as restrições ainda não foram conferidos com o Cabeção |
| VS Code, Claude Desktop | `vscode`, `claude-desktop` | sim | não | Não têm modo não interativo |

Sem `--agent`, o Cabeção usa o `"agent"` do `config.json` da máquina (`~/.config/cabecao/config.json`; no Windows, `%APPDATA%\cabecao\config.json`) e, sem ele, o primeiro disponível na ordem `claude-code`, `codex` (este, só com chave de API). A saída diz qual escolheu e por quê. Para fixar um:

```json
{
  "machine": "meu-mac",
  "defaultBrain": "/Users/voce/cabecao",
  "agent": "codex"
}
```

O agente precisa estar instalado e com a credencial pronta: o Claude Code usa o login que ele já tem (ou `ANTHROPIC_API_KEY`), sem o Cabeção tocar na configuração dele; o Codex usa a chave de API do ambiente. O modelo padrão é o mais barato que o agente deixa escolher (`haiku` no Claude Code; esforço `low` no Codex); troque com `--model`.

## O que o agente pode e não pode fazer

Pode, só pelas tools do Cabeção: `recall`, `search`, `read`, `graph`, `facts`, `status`, `lint`, `remember`, `write_page`, `patch_page`, `relate` e `consolidate` com `action: "finish"`.

Não pode:

- rodar comandos, ler ou editar arquivos por outro meio, nem acessar a rede (cada agente com as opções da tabela abaixo);
- criar ou alterar regras (`memory/rules/`): uma regra só pode ser **proposta**, numa nota em `wiki/syntheses/`;
- escrever em `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, no `log.md` e nos demais arquivos de controle, alterar fontes de `raw/` ou gravar `trust: high`. Numa sessão sua, essas ações acontecem com o seu pedido explícito, confirmado ([Quem é humano e quem é agente na CLI](./humano-e-agente.md)); aqui não há ninguém para confirmar, então ficam indisponíveis, nem com o token, a não ser que você passe `--allow-elevated`;
- escrever no `index.md` ou fora do cérebro;
- enviar ao remoto (`sync`), desfazer (`undo`), deixar recado para a próxima sessão (`handoff_save`) ou trazer conteúdo de fora (`ingest`);
- arquivar notas (`forget`), a não ser que você passe `--allow-forget`;

`--allow-forget` e `--allow-elevated` só você passa, no seu terminal: um processo sem terminal controlador (um agendamento, outro agente) que as tente sai com o código 4. Sem elas, o `--run` roda também sem terminal (agendado), e conta como agente;
- gravar fora da sessão da consolidação: toda escrita vai com o id dela, e por isso `undo --session` alcança tudo.

As restrições de agente de sempre continuam valendo; estas são a mais. Como cada agente é contido:

| Agente | Como |
| --- | --- |
| Claude Code | `--strict-mcp-config --mcp-config <temporário>` (só o servidor do Cabeção), `--tools ""` (nenhuma tool embutida), `--allowedTools mcp__cabecao__*`, `--permission-mode dontAsk --permission-prompts none` (qualquer outro pedido é negado), `--restricted` (sem as suas configurações), `--no-session-persistence` |
| Codex | `CODEX_API_KEY` (a chave de API, que passa na frente do login do ChatGPT), `codex exec --ignore-user-config --ignore-rules --ephemeral --sandbox read-only`, `approval_policy = "never"`, `web_search = "disabled"`, sem as tools de shell, navegador, tela, imagem, subagentes, apps e plugins; o servidor entra por `-c mcp_servers.cabecao.*`, com as tools dele aprovadas |

Os detalhes, com o que fica de fora em cada um, estão em [Segurança](../seguranca.md#o-que-roda-sem-voce-olhando).

## Ver antes de rodar

`--dry-run` mostra o comando, a configuração temporária e o roteiro, sem executar nada e sem criar ponto de restauração:

```text
$ cabecao consolidate --run --agent codex --dry-run
Agente: Codex (~/.local/bin/codex; escolhido com --agent).
Simulação (--dry-run): nada foi executado, nenhum ponto de restauração foi criado.
Aviso: o Codex só é chamado com chave de API (CODEX_API_KEY ou OPENAI_API_KEY): a OpenAI orienta usar chave de API em uso programático, e o login do ChatGPT não é usado. Fonte: https://learn.chatgpt.com/docs/auth

Diretório de trabalho: <pasta temporária> (vazia, apagada no fim)
Tempo limite: 20 min 0 s
Comando: ~/.local/bin/codex exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox read-only --cd '<pasta temporária>' --json --color never -c 'approval_policy="never"' -c 'web_search="disabled"' -c 'model_reasoning_effort="low"' --disable shell_tool --disable unified_exec ...
O roteiro vai pela entrada padrão.
Ambiente do agente (só os nomes; os valores não são mostrados): HOME, LANG, LOGNAME, PATH, TMPDIR, USER
```

Em seguida vêm as restrições, a configuração temporária e o roteiro inteiro.

Pedir um agente que não entra no `--run` responde com o motivo e não cria nada:

```text
$ cabecao consolidate --run --agent antigravity
cabecao: o Cabeção não chama o agente "antigravity" sozinho: os termos do Antigravity não permitem: "Wrapping agy inside third-party coding agents or applications [...] is not supported under consumer plans", e usar software de terceiros para acessar o Antigravity viola os termos e pode suspender a conta (https://antigravity.google/docs/faq/). Para consolidar com o Antigravity, abra uma sessão nele e peça para seguir o prompt "consolidate" do Cabeção (ou os passos de "cabecao consolidate"), com as tools do servidor MCP registrado por "cabecao install-client antigravity".
Agentes que o Cabeção pode chamar: claude-code, codex.
```


## Agendar {#agendar}

O `cabecao schedule` agenda só o sync. Para consolidar de tempos em tempos, use o agendador do sistema com o caminho completo do Cabeção e um `PATH` em que o agente seja achado (o do `cron` é mínimo). Num `crontab` (macOS e Linux), todo domingo às 3h:

```text
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/voce/.local/bin
0 3 * * 0  cabecao consolidate --run --agent claude-code --timeout 20 >> /Users/voce/cabecao-consolidate.log 2>&1
```

Rode o mesmo comando à mão antes. O login de cada agente numa tarefa agendada não foi testado: no macOS, uma credencial guardada no Keychain pode não estar disponível fora da sessão gráfica, e aí a execução falha (sem gravar nada). O resultado de cada execução fica no log e em `~/.cache/cabecao/consolidate-runs/`. A consolidação não envia nada ao remoto: o próximo sync (o seu ou o agendado) leva o commit.
