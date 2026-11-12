<p align="center">
  <strong>🧠 Cabeção</strong><br/>
  <em>Seu segundo cérebro pessoal, em Markdown e git, para você e seus agentes de IA.</em>
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>Português</strong>
</p>

> **Status: 🚧 fundação pronta, funcionalidades em construção.** O monorepo, o CI e a CLI mínima (`cabecao --version`) existem; os comandos chegam no marco 1. Cada decisão de arquitetura foi testada em uma prova de conceito antes de entrar no plano. Veja as [evidências](docs/11-evidencias.md) e o [roadmap](docs/10-roadmap.md).

---

O nome homenageia o **Cabeção** de *Malhação*: o personagem que sabe e lembra de tudo.

## O que é

Um **segundo cérebro pessoal** que vive num **repositório git seu**, em qualquer provedor (GitHub, GitLab, Bitbucket, Gitea, servidor próprio), e que qualquer agente de IA acessa por **MCP**. Você usa em quantas máquinas quiser: tudo sincroniza, inclusive embeddings e grafo.

- 📝 **Markdown é a fonte da verdade.** Você lê e edita no Obsidian ou em qualquer editor.
- 🔗 **Qualquer remoto git.** Sem depender de API de provedor, Pull Request ou CI.
- 🔄 **Sincroniza tudo.** Uma máquina nunca recalcula o embedding que outra já calculou.
- 🔎 **Busca híbrida** por palavra-chave e por significado, com um modelo local que você escolhe (nada sai da sua máquina).
- 🕸️ **Wiki com grafo:** wikilinks, relações tipadas e fatos com validade no tempo, que o agente navega.
- 🧠 **Memória de agente:** o que você ensinou numa sessão está disponível na próxima, em qualquer cliente.
- ↩️ **Tudo reversível:** cada operação é um commit, com comando para desfazer.
- 🪶 **Leve:** um pacote de ~160 KB, sem dependência nativa. O modelo de embeddings é baixado só quando você ativa a busca semântica.

## Instalação (planejada)

Você informa só a URL do repositório:

```bash
npx cabecao init git@gitlab.com:voce/meu-cerebro.git
```

O Cabeção descobre o resto:

| O repositório... | O que acontece |
|---|---|
| está vazio | cria a estrutura, o primeiro commit e envia |
| já tem um cérebro Cabeção | baixa tudo e monta o índice sem recalcular nada |
| tem um vault de Obsidian ou Markdown comum | adota, sem mover nenhum arquivo |
| tem outra coisa (código, por exemplo) | recusa e explica |

Depois ele registra o servidor MCP nos clientes que encontrar (Claude Code, Claude Desktop, Codex, Cursor) e, se você quiser, configura o Obsidian.

Requisitos: Node.js 22.16 ou superior (recomendado: 24) e git 2.38 ou superior.

> ⚠️ **O código do Cabeção é público; o seu cérebro não deve ser.** Use um repositório **privado**.

## Como funciona

```
 Claude Code · Claude Desktop · Codex · Cursor            Obsidian
             │ MCP (stdio)                                   │
             ▼                                               ▼
 ┌──────────────────────── cabecao ────────────────────────────┐
 │ recall · search · read · graph · facts · remember · ingest  │
 │ handoff · forget · sync · lint · consolidate · undo         │
 └──────────┬──────────────────────────────────┬───────────────┘
            ▼                                  ▼
  Repositório git do cérebro            Índice local (fora do git)
  ├─ branch principal: suas notas       SQLite com busca por texto
  └─ branch cabecao/index:              + vetores em memória
     embeddings e grafo                 + grafo
            │
            ▼  cabecao sync
   Qualquer remoto git
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 · Visão](docs/01-visao.md) | Problema, objetivos, o que fica de fora |
| [02 · Arquitetura](docs/02-arquitetura.md) | Componentes, processos e escolhas técnicas |
| [03 · Modelo de dados](docs/03-modelo-de-dados.md) | Estrutura do cérebro, frontmatter, índice local |
| [04 · Sincronização](docs/04-sincronizacao.md) | Como conteúdo, embeddings e grafo sincronizam por git |
| [05 · Servidor MCP](docs/05-mcp.md) | Tools, confirmações, compatibilidade de protocolo |
| [06 · Busca e grafo](docs/06-busca-e-grafo.md) | Busca híbrida, validade temporal, grafo |
| [07 · Ciclo de vida e segurança](docs/07-ciclo-de-vida-e-seguranca.md) | Captura, manutenção, desfazer, segredos |
| [08 · Instalação e operação](docs/08-instalacao-e-operacao.md) | Instalar, usar, atualizar, diagnosticar |
| [09 · Guia do Obsidian](docs/09-obsidian.md) | Visualizar e navegar o cérebro |
| [10 · Roadmap](docs/10-roadmap.md) | Marcos e entregas |
| [11 · Evidências](docs/11-evidencias.md) | O que cada prova de conceito testou e concluiu |
| [12 · Padrão de commits](docs/12-commits.md) | Formato dos commits automáticos |
| [13 · Desenvolvimento, CI e publicação](docs/13-publicacao.md) | Como rodar o projeto, o que o CI confere e como publicar no npm |
| [ADRs](docs/adr/) | Registro das decisões de arquitetura |

## Contribuindo

Leia o [CONTRIBUTING.md](CONTRIBUTING.md). O projeto é escrito em TypeScript.

## Licença

[MIT](LICENSE) © Renan Pereira Loureiro
