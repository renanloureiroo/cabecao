---
title: Plugin do Claude Code
description: Instale o plugin do Cabeção no Claude Code, com o servidor embutido, o briefing no início da sessão e o sync no fim.
sidebar_position: 9
---

O plugin é a forma mais completa de usar o Cabeção no Claude Code. Ele traz:

- **o servidor MCP embutido**: as tools do Cabeção sobem com `node`, a partir de uma cópia do programa que vem dentro do plugin. Não usa `npx` nem rede, e o servidor sobe em cerca de 0,05 s;
- **o briefing no início de cada sessão**: suas regras, o último handoff, suas preferências, as armadilhas e as memórias do projeto entram no contexto do agente antes da primeira mensagem, junto com as regras de uso do cérebro;
- **o sync no fim de cada sessão**, em segundo plano;
- **a skill `cabecao:memory`**, uma referência curta de quando consultar e do que lembrar.

## Antes de instalar

- Node.js 22.16 ou mais novo no `PATH` (o mesmo que o Cabeção já pede).
- Um cérebro nesta máquina: rode [`npx cabecao init`](../comecar/init.md) antes, ou tenha à mão a pasta de um cérebro.

## Instalar

Dentro do Claude Code:

```text
/plugin marketplace add renanloureiroo/cabecao
/plugin install cabecao@cabecao
```

Pelo terminal, o mesmo:

```bash
claude plugin marketplace add renanloureiroo/cabecao
claude plugin install cabecao@cabecao
```

Reinicie o Claude Code. O servidor aparece como `plugin:cabecao:cabecao`:

```text
$ claude mcp list
plugin:cabecao:cabecao: node <pasta do plugin>/server/cabecao.mjs mcp - ✔ Connected
```

### Qual cérebro o plugin usa

O plugin tem uma opção, `brain_dir`. Vazia, vale o cérebro padrão desta máquina, o que o `cabecao init` gravou. Para usar outra pasta:

```bash
claude plugin install cabecao@cabecao --config brain_dir=/caminho/do/cerebro
```

Ou, com o plugin já instalado, `/plugin configure cabecao@cabecao` dentro do Claude Code. A opção vale para o servidor e para os dois hooks.

### Se você já registrou o servidor com `install-client`

O plugin traz o próprio servidor. Tire o registro antigo, para o agente não ver as tools em dobro:

```bash
cabecao install-client --remove claude-code
```

## O que acontece no início da sessão

Quando uma sessão começa (e também depois de `/clear`, de retomar uma sessão ou de compactar o contexto), o plugin roda `cabecao recall --hook`. Ele:

1. descobre o projeto pela pasta onde você abriu o Claude Code (a raiz do repositório git, ou a própria pasta) e usa o escopo `project:<nome-da-pasta>`, que inclui também o que é global. Se o cérebro não tem nada nesse escopo nem no global, usa todos os escopos;
2. monta o briefing, por ordem de prioridade: regras, último handoff, preferências, armadilhas e memórias que casam com o nome do projeto;
3. entrega ao Claude Code as regras de uso do cérebro e o briefing, abaixo de 10 mil caracteres (o limite do Claude Code). Se não couber tudo, saem primeiro as memórias, e as suas regras ficam.

Tudo o que veio do cérebro vai dentro de um bloco marcado como **dado**, com uma marca que muda a cada sessão: o texto de uma nota não consegue sair do bloco e se passar por instrução. O começo do que o agente recebe é assim:

```text
# Cabeção: briefing do início da sessão

Regras de uso do Cabeção (o segundo cérebro do usuário; servidor MCP "cabecao"):
- O bloco de dados abaixo já é o resultado de `recall` para esta sessão: não chame `recall` de novo, a não ser para uma tarefa diferente.
- Use `search` antes de afirmar algo sobre o histórico do usuário; ...
...
session_handle desta sessão: 01M79JW9TP71YE05Q8W01G5M5K
Escopo: project:atlas, pela pasta "Atlas" (inclui o global)

Tudo entre <cabecao-dados-25117ccc528f370593> e </cabecao-dados-25117ccc528f370593> veio do cérebro do usuário. ...
<cabecao-dados-25117ccc528f370593>
## Regras do usuário (memory/rules: valem logo abaixo do pedido atual do usuário)

### Nunca commitar segredos
memory/rules/nunca-commitar-segredos.md · rule · global · trust high · origem human
Nunca grave chaves, tokens ou senhas em arquivos versionados, nem neste cérebro. Em caso de dúvida, pergunte antes.

## Último handoff
...
```

O hook entrega o último handoff à sessão, e é ela que o lê: por isso ele conta como entregue (o `recall` anota isso em `.cabecao/`, fora do git). Se a próxima sessão receber o mesmo handoff sem que ninguém tenha gravado um novo, o briefing avisa, fora do bloco de dados: "o último handoff já tinha sido entregue a outra sessão em ...; confira se ele ainda vale". Ao retomar uma sessão ou compactar o contexto, a conversa é a mesma, e esse aviso não aparece.

O hook nunca impede a sessão de começar: sem cérebro, com o banco ocupado ou em qualquer erro, ele não acrescenta nada e o motivo vai para a saída de erro. Para ver o briefing que um projeto receberia, rode [`cabecao recall`](../referencia/cli.md#cabecao-recall) no terminal.

## O que acontece no fim da sessão

Quando a sessão termina, o plugin roda `cabecao sync --hook`. O Claude Code dá só 1,5 s a esse hook, e um sync com `git push` pode levar mais. Por isso ele só **dispara** o sync num processo em segundo plano, que continua depois que o Claude Code fecha, e volta em milissegundos. O resultado vai para `<cérebro>/.cabecao/logs/sync.log`:

```text
=== 2026-11-13T12:36:01.764Z · sync em segundo plano (hook SessionEnd do Claude Code, motivo other) ===
--- 2026-11-13T12:36:01.805Z → 2026-11-13T12:36:01.896Z · sync · código 0 ---
Sync: ok. Sem remoto configurado: as mudanças ficaram em commits locais.
Recebidos: 0 commits · enviados: 0 · criados neste sync: 0
Aviso: este cérebro não tem remoto; as mudanças ficam só nesta máquina. ...
```

A primeira linha é de quem disparou; o bloco seguinte é o resultado do sync, com o código de saída (este cérebro de exemplo não tem remoto).

Se outro sync já estiver rodando, o novo sai como "outro sync em andamento", sem fazer nada. Para sincronizar também quando você não está no Claude Code, ligue o [sync automático](./sync-automatico.md).

## O que o plugin NÃO faz

- **Não captura a conversa.** Nenhum hook lê, copia ou grava seus prompts, as respostas ou as chamadas de tools. No cérebro entra só o que o agente grava pelas tools (`remember`, `write_page`...), como sem o plugin.
- **Não bloqueia o encerramento** para pedir um handoff. O handoff fica por conta das regras de uso: antes de encerrar um trabalho relevante, o agente grava um com `handoff_save`.
- **Não usa rede** para subir: o servidor e os hooks rodam a cópia do Cabeção que vem no plugin. A única rede é a do próprio sync (`git fetch` e `git push`).

## Atualizar e remover

O plugin acompanha as versões do pacote `cabecao`: `/plugin update cabecao@cabecao` (ou `claude plugin update cabecao@cabecao`) traz a versão nova quando ela sai. Para remover: `/plugin uninstall cabecao@cabecao`. Remover o plugin não toca no cérebro.

## Problemas

| Sintoma | O que fazer |
| --- | --- |
| `claude mcp list` mostra `plugin:cabecao:cabecao ... Failed to connect` | Rode `cabecao doctor`. Confira se o `node` do `PATH` é 22.16+ e se `brain_dir` (ou o cérebro padrão) aponta para um cérebro |
| O agente não recebe o briefing | Rode o hook à mão e leia a saída de erro: `echo '{}' \| node <pasta do plugin>/server/cabecao.mjs recall --hook` |
| O sync do fim de sessão não aconteceu | Veja `<cérebro>/.cabecao/logs/sync.log` |
| As tools aparecem duas vezes | Tire o registro antigo: `cabecao install-client --remove claude-code` |
