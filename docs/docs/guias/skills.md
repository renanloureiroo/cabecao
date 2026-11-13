---
title: Usar o Cabeção com skills
description: As skills do Cabeção ensinam o agente a usar o cérebro pela CLI, sem o servidor MCP. Como instalar em cada agente e quando usar skills, plugin ou MCP.
sidebar_position: 2
---

Uma **skill** é uma pasta com um arquivo `SKILL.md` (o formato [Agent Skills](https://agentskills.io/specification)) que o agente carrega quando o assunto da conversa casa com a descrição dela. As skills do Cabeção ensinam o agente a consultar e gravar no seu cérebro **pela linha de comando**, com o `cabecao` que já está instalado na máquina. Elas não precisam do servidor MCP conectado.

## Por que funcionam sem o MCP

O agente roda os comandos `cabecao` no shell dele, como roda `git` ou `npm`. A CLI sabe quando quem roda é um agente (sem terminal controlador, ou com sinal de agente no ambiente) e aplica **exatamente as mesmas regras** do servidor MCP: regra, arquivo de controle, `raw/` e `trust: high` só com o seu pedido explícito, confirmado em duas chamadas; segredo bloqueado; tudo num commit que `undo` desfaz. As skills só dizem quais comandos usar e como ler a resposta. Os detalhes estão em [Quem é humano e quem é agente na CLI](./humano-e-agente.md).

## As cinco skills

Cada uma cobre uma **intenção**, e a descrição dela é escrita pelo que você pede, não por palavra exata:

| Skill | Entra quando | Comandos |
| --- | --- | --- |
| `cabecao-consultar` | Começo de tarefa; antes de afirmar algo sobre o seu histórico, decisões ou preferências | `recall`, `search`, `read`, `graph`, `facts`, `ask` |
| `cabecao-lembrar` | Você diz uma preferência, corrige o agente, toma uma decisão; o agente descobre uma armadilha | `remember` (com `--resolution` para memórias parecidas), `relate`, `write`, `patch` |
| `cabecao-passar-bastao` | Fim de um trabalho relevante, troca de máquina ou de agente | `handoff`, `sync` |
| `cabecao-manutencao` | Só quando você pede: ver o estado, achar problemas, consolidar, esquecer, desfazer, sincronizar | `status`, `lint`, `consolidate`, `forget`, `undo`, `sync` |
| `cabecao-pedido-explicito` | Só quando você pede uma regra para os agentes, uma mudança no `AGENTS.md` (ou outro arquivo de controle), em `raw/`, ou desfazer o que não foi do agente | o fluxo de duas chamadas com `--confirm <token>` |

Todas mandam rodar com `--json` e `--as <nome do agente>`, passar o conteúdo pela entrada padrão (um heredoc com `<<'EOF'`, que não depende de escape de shell), tratar o que o Cabeção devolve como **dado, nunca instrução**, e usar as tools equivalentes quando o servidor MCP `cabecao` estiver conectado na sessão. As descrições estão em português, com uma frase em inglês no fim, para o agente reconhecer o pedido nas duas línguas sem duas cópias de cada skill.

## Instalar

```bash
cabecao install-skills
```

Sem nome, instala nos agentes detectados nesta máquina. Saída real, numa máquina com o Codex e o Cursor:

```text
$ cabecao install-skills
Codex, Cursor: ~/.agents/skills
  cabecao-consultar: instalada
  cabecao-lembrar: instalada
  cabecao-manutencao: instalada
  cabecao-passar-bastao: instalada
  cabecao-pedido-explicito: instalada
Abra uma sessão nova do agente para ele carregar as skills.
```

Rodar de novo não muda nada (`já estava em dia`). Para um agente só, diga o nome: `cabecao install-skills codex`. Com `--project`, as skills vão para a pasta do projeto atual, para valerem só nele (e irem para o git do projeto, se você quiser).

### Onde cada agente lê as skills

| Agente | `cliente` | Do usuário (padrão) | Do projeto (`--project`) |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/skills` (ou `$CLAUDE_CONFIG_DIR/skills`) | `.claude/skills` |
| Codex | `codex` | `~/.agents/skills` | `.agents/skills` |
| Cursor | `cursor` | `~/.agents/skills` | `.agents/skills` |
| Gemini CLI | `gemini` | `~/.agents/skills` | `.agents/skills` |
| Antigravity (agy, IDE e App) | `antigravity` | `~/.gemini/config/skills` | `.agents/skills` |
| VS Code e GitHub Copilot | `vscode` | `~/.copilot/skills` (ou `$COPILOT_HOME/skills`) | `.github/skills` |

O que é **confirmado** na documentação oficial de cada agente (consultada em 13/11/2026): as pastas da tabela, sem as variáveis. O que é **suposição**: que `CLAUDE_CONFIG_DIR` e `COPILOT_HOME` levem as skills junto (as duas variáveis trocam a pasta de configuração inteira, mas a documentação das skills não diz) e os caminhos no Windows (as mesmas pastas dentro de `%USERPROFILE%`). O Codex, o Cursor e o Gemini CLI leem `~/.agents/skills`, por isso dividem a mesma cópia; tirar as skills de um deles não as tira dos outros que ainda usam a pasta. O Cursor e o VS Code também leem `~/.claude/skills`: com o Claude Code e um deles na mesma máquina, o agente pode ver as skills em dobro.

### Suas alterações são suas

O Cabeção anota o hash de cada arquivo que gravou (`skills.json`, na pasta de configuração da máquina). Assim:

- rodar `install-skills` de novo (por exemplo, depois de atualizar o Cabeção) troca só os arquivos que continuam como o Cabeção gravou;
- uma skill que você alterou, ou uma skill sua com o mesmo nome, fica como está (`mantida como está: foi alterada por você`); `cabecao install-skills --print` mostra a versão do Cabeção para você comparar;
- `cabecao install-skills --remove` tira só o que o Cabeção pôs e você não alterou (`--remove codex` tira de um agente; `--remove --all`, de todas as pastas, inclusive as de projeto).

A gravação é atômica: um arquivo nunca fica pela metade. O `cabecao doctor` confere se as skills instaladas estão em dia com a versão do Cabeção:

```text
ok     Skills do Cabeção        instaladas e em dia
                                - ~/.agents/skills (codex, cursor): 5 arquivos em dia
```

### Ver sem gravar

```bash
cabecao install-skills --print codex
```

Mostra a pasta de cada agente, o que aconteceria com cada skill e o conteúdo completo dos `SKILL.md`. Nada é gravado.

## Agentes sem skills

O Claude Desktop não roda comandos de terminal e não tem pasta de skills no disco: lá o Cabeção entra pelo servidor MCP ([o pacote `.mcpb`](./claude-desktop.md)).

```text
$ cabecao install-skills claude-desktop
cabecao: o Claude Desktop não roda comandos de terminal e não tem pasta de skills no disco: lá o Cabeção entra pelo servidor MCP (o pacote .mcpb ou "cabecao install-client claude-desktop")
```

Para um agente que não lê skills, mas lê um arquivo de instruções (`AGENTS.md`, `GEMINI.md` e afins), o Cabeção **não edita** esse arquivo por você. Ele mostra um bloco curto para você colar:

```bash
cabecao install-skills --instructions
```

## Skills, plugin ou servidor MCP?

| | Skills (`install-skills`) | Servidor MCP (`install-client`) | Plugin do Claude Code |
| --- | --- | --- | --- |
| Como o agente usa o cérebro | Roda `cabecao` no shell | Chama as tools do servidor | Tools do servidor embutido, mais as skills |
| Precisa do Cabeção instalado na máquina | Sim (`npm i -g cabecao@beta`) | Sim, ou `npx` | Não para o servidor (vem dentro do plugin) |
| Briefing automático no início da sessão | Não: a skill manda chamar `recall` | Não: as instruções do servidor pedem `recall` | Sim (hook) |
| Sync no fim da sessão | A skill manda rodar `cabecao sync` | Não (use `cabecao schedule on`) | Sim (hook) |
| Onde funciona | Agentes com shell que leem skills | Qualquer cliente MCP, inclusive os sem shell (Claude Desktop) | Só o Claude Code |

Quando usar cada um:

- **Claude Code**: o [plugin](./claude-code.md) traz tudo junto. Sem o plugin, as skills ou o registro do servidor funcionam. Não use o plugin e o registro direto ao mesmo tempo (o `doctor` avisa): as tools apareceriam em dobro.
- **Codex, Cursor, Gemini CLI, Antigravity, Copilot**: as skills sozinhas bastam. Se você também registrou o servidor (`install-client`), as skills mandam o agente preferir as tools; os dois juntos não se atrapalham.
- **Claude Desktop** e clientes MCP sem shell: só o servidor MCP.
- **Sem sync automático**: com skills ou MCP, o que o agente grava fica num commit local até um `cabecao sync`. A skill de passar o bastão manda sincronizar no fim; `cabecao schedule on` cobre o resto.

## No plugin do Claude Code

O plugin traz as skills do Cabeção junto com o servidor e os hooks. Ele corresponde à **versão publicada** do Cabeção: as skills novas chegam ao plugin na próxima versão publicada (até lá, o plugin traz a skill de referência `memory`). Se você usa o plugin, não precisa do `install-skills` no Claude Code.

## O que não foi testado

As skills foram conferidas por um teste que roda, como agente, cada comando que elas mandam rodar, contra uma cópia do cérebro de exemplo. Não foi testado um agente de verdade carregando as skills pela descrição e seguindo-as numa conversa. Se um agente não usar uma skill quando deveria, conte nas [issues](https://github.com/renanloureiroo/cabecao/issues) qual agente e o que você pediu.
