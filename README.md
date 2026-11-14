<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/marca/banner-escuro.png">
    <img src="assets/marca/banner.png" alt="Cabeção: segundo cérebro em Markdown e git, servido por MCP">
  </picture>
</p>

<p align="center">
  Seu segundo cérebro em Markdown e git, para você e seus agentes de IA, servido por MCP.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cabecao"><img src="https://img.shields.io/npm/v/cabecao?color=14121c" alt="Versão no npm"></a>
  <a href="https://github.com/renanloureiroo/cabecao/actions/workflows/ci.yml"><img src="https://github.com/renanloureiroo/cabecao/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/renanloureiroo/cabecao?color=14121c" alt="Licença MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/cabecao?color=14121c" alt="Node.js"></a>
</p>

<!-- README-I18N:START -->

**Português** | [English](./README.en.md)

<!-- README-I18N:END -->

Suas notas são arquivos Markdown num repositório git seu, em qualquer provedor. Os agentes de IA (Claude Code, Codex, Cursor e outros) consultam e gravam nelas por MCP, e cada gravação vira um commit que você desfaz com um comando. O nome é uma homenagem ao Cabeção de *Malhação*.

## Como é

```text
$ cabecao init git@github.com:voce/cerebro.git
Pronto. Seu cérebro está em ~/cabecao (máquina notebook) e em git@github.com:voce/cerebro.git.

Repositório vazio: estrutura do cérebro criada na branch main e enviada para git@github.com:voce/cerebro.git.
Índice local: 0 notas indexadas em 2 ms.

Agentes:
  Codex   servidor MCP registrado
  Cursor  servidor MCP registrado
  Reinicie os que estiverem abertos.

Teste agora:
  1. No Codex, peça: "guarde que eu prefiro respostas curtas, em tópicos"
  2. Numa conversa nova, pergunte: "como eu prefiro as respostas?"
  3. Ou confira aqui: cabecao search "respostas curtas"

Opcional:
  cabecao install-skills  skills que ensinam Codex e Cursor a usar o cérebro
  ...
```

Numa sessão do Claude Code, você pede "guarde que os testes de pagamento só passam com `TZ=UTC`", e o agente chama a tool `remember`:

```json
{
  "op": "01M79DRQR9648E1JZ60MF0EBNN",
  "path": "memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md",
  "action": "add",
  "commit": "1af64e1dc48f5627dd086474c571b22326eaa3c0"
}
```

A nota é um arquivo `.md` comum. Na próxima sessão, em qualquer máquina, ela volta no `recall` do agente. E também pelo terminal:

```text
$ cabecao search "testes pagamento"
1 resultado(s) para "testes pagamento", com todos os termos (validade em 2026-11-13):

1. Testes de pagamento precisam do fuso fixo  [gotcha · project:pagamentos]  vigente
   memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md
   Os «testes» do serviço de pagamentos falham perto da meia-noite se o fuso não for fixo. Rode com `TZ=UTC npm test`.
```

## Por quê

- **Seus dados, num formato seu.** Markdown num repositório git que você controla. Abre no Obsidian, em qualquer editor, e continua seu se você parar de usar o Cabeção.
- **Qualquer provedor.** GitHub, GitLab, Bitbucket, Gitea, um servidor seu ou só a sua máquina. Só git, sem API de provedor.
- **Memória entre sessões e máquinas.** O que você ensina numa conversa volta na próxima, em qualquer cliente MCP.
- **Tudo reversível.** Cada gravação é um commit identificado; `cabecao undo` desfaz uma operação ou uma sessão inteira de um agente.
- **Agentes com limites.** Regras e arquivos de instrução só mudam com o seu pedido explícito, confirmado; segredo nunca entra; e todo commit de agente leva a marca dele.
- **Manutenção sem você olhando.** `cabecao consolidate --run` chama o Claude Code ou o Codex para consolidar a memória, só com as tools do Cabeção, e desfaz o que ficar pela metade.

## Instalação

Requer Node.js 22.16 ou mais novo e git 2.38+. Crie antes um repositório **vazio e privado**.

```bash
npm i -g cabecao
cabecao init git@github.com:voce/cerebro.git
cabecao doctor
```

O `init` termina com o que pedir ao agente para testar e os próximos passos opcionais que ele detectou. Ele também adota um vault do Obsidian que está num repositório git (clonado numa pasta nova, sem mover nem renomear notas), e sem URL cria um cérebro só local.

## Conectar os agentes

O `init` já registra o servidor MCP nos clientes que encontrar: Claude Code, Claude Desktop, Codex, Cursor, VS Code, Antigravity e Gemini CLI. Para registrar depois, `cabecao install-client --all`.

Nos agentes com shell, as **skills** do Cabeção ensinam o agente a usar o cérebro pela linha de comando, sem o servidor MCP e com as mesmas regras:

```bash
cabecao install-skills
```

No Claude Code, o plugin traz tudo junto (servidor embutido, briefing no início da sessão, sync no fim e as skills): `/plugin marketplace add renanloureiroo/cabecao` e `/plugin install cabecao@cabecao`.

## Recursos

- `init` em qualquer remoto git, com adoção de vault do Obsidian, e um fim que leva ao primeiro teste
- `sync` sem perder nada: cópia de conflito em vez de sobrescrever; sync automático com `schedule`
- Busca por palavra-chave e, opcional, por significado com um modelo local; validade no tempo (`--as-of`)
- Grafo: wikilinks, relações tipadas, fatos e menções sem link
- Servidor MCP com 17 tools, plugin do Claude Code, pacote `.mcpb` do Claude Desktop e skills para os agentes com shell
- Memória com ciclo de vida: handoff, duplicatas resolvidas, `lint`, `consolidate` (também com um agente sozinho), `forget`
- `undo` por operação ou sessão; scanner de segredos; regras só com o seu pedido explícito
- Obsidian com um comando (`obsidian setup`); `upgrade` e `uninstall`
- Respostas com citações conferidas (`ask`), opcionais: desligadas por padrão, com o provedor que você ativar no terminal

O que vem depois está em [Em breve](https://renanloureiroo.github.io/cabecao/em-breve).

## Documentação

Tudo está no site: **[renanloureiroo.github.io/cabecao](https://renanloureiroo.github.io/cabecao/)**, em português e em inglês. Começo rápido, conceitos, guias (Obsidian, conflitos, desfazer, regras), referência da CLI e das tools MCP, segurança e solução de problemas.

## Contribuir

Issues e pull requests são bem-vindos. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) para rodar o projeto e as convenções. Para relatar uma vulnerabilidade, use o relato privado de vulnerabilidades do GitHub.

## Licença

[MIT](LICENSE) © Renan Pereira Loureiro
