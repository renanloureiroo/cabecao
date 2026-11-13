---
title: Consolidar com um agente
description: Deixe o Cabeção chamar o Claude Code, o Codex ou o Antigravity para consolidar a memória sozinho, sem você olhando, e desfaça se não gostar.
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

O agente trocou o link quebrado `[[Kafka]]` por texto e pôs o link que faltava em "RabbitMQ", os dois achados do `lint` daquele cérebro. Quando não há o que fazer, a saída é assim (Antigravity, no mesmo cérebro, logo depois):

```text
Agente: Antigravity (escolhido com --agent), 1 min 4 s, 1 turno(s).
Consolidação 01M7AJH12H5436AYTWHT74164W: o agente terminou sem gravar nada; o cérebro está como antes.

Última mensagem do agente:
Nenhuma nota tocada (material vazio: sem episódios repetidos, duplicatas ou itens de lint).
```

A saída completa do agente fica em `~/.cache/cabecao/consolidate-runs/<id>.log`, só para o seu usuário.

## Desfazer

```bash
cabecao undo --session 01M7AJDQ796TP2A9ZCSAV7R9VT
```

desfaz a consolidação inteira com um commit de revert; desfazer esse undo refaz tudo. O ponto de restauração continua na máquina: `git reset --hard <tag>` volta a ele, descartando tudo o que veio depois (inclusive o que não é da consolidação). Mais em [Desfazer](./desfazer.md).

## Agentes

| Agente | `--agent` | `--run` | Por quê |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | sim | Dá para carregar só o servidor do Cabeção e tirar todas as tools embutidas |
| Codex | `codex` | sim | Dá para ignorar a configuração do usuário, tirar o shell e prender a escrita numa caixa de areia somente leitura |
| Antigravity (`agy`) | `antigravity` | sim | Dá para passar permissões só da sessão e negar comandos, escrita e web |
| Gemini CLI | `gemini` | não | Deixou de atender contas pessoais em 18/06/2026; use `antigravity`. Para quem ainda o tem (licença Enterprise ou chave paga), o modo não interativo não foi testado |
| Cursor Agent | `cursor` | não | Em modo não interativo ele tem acesso a todas as tools, inclusive shell e escrita, e a documentação não diz o que acontece com uma ação não liberada sem ninguém olhando |
| GitHub Copilot CLI, OpenCode | `copilot`, `opencode` | não | Têm opções para restringir as tools, mas ainda não foram testados com o Cabeção |
| VS Code, Claude Desktop | `vscode`, `claude-desktop` | não | Não têm modo não interativo |

Sem `--agent`, o Cabeção usa o `"agent"` do `config.json` da máquina (`~/.config/cabecao/config.json`; no Windows, `%APPDATA%\cabecao\config.json`) e, sem ele, o primeiro instalado na ordem `claude-code`, `codex`, `antigravity`. A saída diz qual escolheu e por quê. Para fixar um:

```json
{
  "machine": "meu-mac",
  "defaultBrain": "/Users/voce/cabecao",
  "agent": "codex"
}
```

O agente precisa estar instalado e com login feito: o Cabeção usa o login que ele já tem, sem tocar na configuração dele. O modelo padrão é o mais barato que o agente deixa escolher (`haiku` no Claude Code; esforço `low` no Codex e no Antigravity); troque com `--model`.

## O que o agente pode e não pode fazer

Pode, só pelas tools do Cabeção: `recall`, `search`, `read`, `graph`, `facts`, `status`, `lint`, `remember`, `write_page`, `patch_page`, `relate` e `consolidate` com `action: "finish"`.

Não pode:

- rodar comandos, ler ou editar arquivos por outro meio, nem acessar a rede (cada agente com as opções da tabela abaixo);
- criar ou alterar regras (`memory/rules/`): uma regra só pode ser **proposta**, numa nota em `wiki/syntheses/`;
- escrever em `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, no `index.md`, no `log.md` ou fora do cérebro;
- enviar ao remoto (`sync`), desfazer (`undo`), deixar recado para a próxima sessão (`handoff_save`) ou trazer conteúdo de fora (`ingest`);
- arquivar notas (`forget`), a não ser que você passe `--allow-forget`;
- gravar fora da sessão da consolidação: toda escrita vai com o id dela, e por isso `undo --session` alcança tudo.

As restrições de agente de sempre continuam valendo; estas são a mais. Como cada agente é contido:

| Agente | Como |
| --- | --- |
| Claude Code | `--strict-mcp-config --mcp-config <temporário>` (só o servidor do Cabeção), `--tools ""` (nenhuma tool embutida), `--allowedTools mcp__cabecao__*`, `--permission-mode dontAsk --permission-prompts none` (qualquer outro pedido é negado), `--restricted` (sem as suas configurações), `--no-session-persistence` |
| Codex | `codex exec --ignore-user-config --ignore-rules --ephemeral --sandbox read-only`, `approval_policy = "never"`, `web_search = "disabled"`, sem as tools de shell, navegador, tela, imagem, subagentes, apps e plugins; o servidor entra por `-c mcp_servers.cabecao.*`, com as tools dele aprovadas |
| Antigravity | `agy --print` com o servidor em `.agents/mcp_config.json` da pasta temporária (nome `cabecao-run`) e `--settings` só da sessão: liberado `mcp(cabecao-run/*)`; negados `command(*)`, `write_file(*)`, `read_url(*)` e `execute_url(*)`; `--sandbox` |

Os detalhes, com o que fica de fora em cada um, estão em [Segurança](../seguranca.md#o-que-roda-sem-voce-olhando).

## Ver antes de rodar

`--dry-run` mostra o comando, a configuração temporária e o roteiro, sem executar nada e sem criar ponto de restauração:

```text
$ cabecao consolidate --run --agent codex --dry-run
Agente: Codex (~/.local/bin/codex; escolhido com --agent).
Simulação (--dry-run): nada foi executado, nenhum ponto de restauração foi criado.

Diretório de trabalho: <pasta temporária> (vazia, apagada no fim)
Tempo limite: 20 min 0 s
Comando: ~/.local/bin/codex exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox read-only --cd '<pasta temporária>' --json --color never -c 'approval_policy="never"' -c 'web_search="disabled"' -c 'model_reasoning_effort="low"' --disable shell_tool --disable unified_exec --disable view_image --disable browser_use ...
O roteiro vai pela entrada padrão.
Ambiente do agente (só estes nomes): HOME, LANG, LOGNAME, PATH, TMPDIR, USER
```

Em seguida vêm as restrições, a configuração temporária e o roteiro inteiro.

## Agendar {#agendar}

O `cabecao schedule` agenda só o sync. Para consolidar de tempos em tempos, use o agendador do sistema com o caminho completo do Cabeção e um `PATH` em que o agente seja achado (o do `cron` é mínimo). Num `crontab` (macOS e Linux), todo domingo às 3h:

```text
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/voce/.local/bin
0 3 * * 0  cabecao consolidate --run --agent claude-code --timeout 20 >> /Users/voce/cabecao-consolidate.log 2>&1
```

Rode o mesmo comando à mão antes. O login de cada agente numa tarefa agendada não foi testado: no macOS, uma credencial guardada no Keychain pode não estar disponível fora da sessão gráfica, e aí a execução falha (sem gravar nada). O resultado de cada execução fica no log e em `~/.cache/cabecao/consolidate-runs/`. A consolidação não envia nada ao remoto: o próximo sync (o seu ou o agendado) leva o commit.
