<p align="center">
  <strong>🧠 Cabeção</strong><br/>
  <em>Seu segundo cérebro pessoal, em Markdown e git, para você e seus agentes de IA.</em>
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>Português</strong>
</p>

> **Status: 🚧 marco 1 implementado e em revisão; nada publicado no npm ainda.** A CLI (`init`, `status`, `doctor`, `sync`, `search`, `undo`, `mcp`, `install-client`), o sync por git, a busca por palavra-chave e o servidor MCP com 9 tools existem na branch `feat/m1-nucleo` e têm 1.181 testes, mais um teste de ponta a ponta com duas máquinas. **Ainda não foram validados** provedores git reais (GitHub, GitLab, Bitbucket, Gitea), SSH e gerenciadores de credencial, commits assinados nem clientes MCP reais (Claude Code, Claude Desktop, Codex, Cursor). Busca por significado, grafo e plugin são dos marcos 2 a 4. Cada decisão de arquitetura foi testada em uma prova de conceito antes de entrar no plano; veja as [evidências](docs/11-evidencias.md) e o [roadmap](docs/10-roadmap.md).

---

O nome homenageia o **Cabeção** de *Malhação*: o personagem que sabe e lembra de tudo.

## O que é

Um **segundo cérebro pessoal** que vive num **repositório git seu**, em qualquer provedor (GitHub, GitLab, Bitbucket, Gitea, servidor próprio), e que qualquer agente de IA acessa por **MCP**. Você usa em quantas máquinas quiser: tudo sincroniza, inclusive embeddings e grafo.

- 📝 **Markdown é a fonte da verdade.** Você lê e edita no Obsidian ou em qualquer editor.
- 🔗 **Qualquer remoto git.** Sem depender de API de provedor, Pull Request ou CI.
- 🔄 **Sincroniza tudo o que o git não ignora.** Hoje: notas, anexos e configuração. Planejado (marco 2): embeddings e grafo, para que uma máquina nunca recalcule o que outra já calculou.
- 🔎 **Busca** por palavra-chave (hoje) e, no marco 2, também por significado, com um modelo local que você escolhe (nada sai da sua máquina).
- 🕸️ **Wiki com grafo** (marco 3): wikilinks, relações tipadas e fatos com validade no tempo, que o agente navega.
- 🧠 **Memória de agente:** o que você ensinou numa sessão está disponível na próxima, em qualquer cliente.
- ↩️ **Tudo reversível:** cada operação é um commit, com comando para desfazer.
- 🪶 **Leve:** um pacote de 241 kB compactado (cerca de 840 kB instalado), sem dependências de runtime nem nativas; `cabecao --version` leva cerca de 26 ms. O modelo de embeddings (marco 2) será baixado só quando você ativar a busca semântica.

## Instalação

> **Ainda não é possível instalar pelo npm.** O pacote `cabecao` não foi publicado, então `npx cabecao` só vai funcionar depois da publicação. Até lá, rode a partir do repositório: `pnpm install && pnpm build` e `node packages/cli/dist/cabecao.mjs init <url>`.

Depois de publicado, você informa só a URL do repositório:

```bash
npx cabecao init git@gitlab.com:voce/meu-cerebro.git
```

O Cabeção descobre o resto:

| O repositório... | O que acontece |
|---|---|
| está vazio | cria a estrutura, o primeiro commit e envia |
| já tem um cérebro Cabeção | baixa e monta o índice local (a partir do marco 2, sem recalcular embeddings) |
| tem um vault de Obsidian ou Markdown comum | adota, sem mover nenhum arquivo |
| tem outra coisa (código, por exemplo) | recusa e explica |

Sem URL, ele cria um cérebro só local. Depois ele registra o servidor MCP nos clientes que encontrar (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Gemini CLI). A configuração do Obsidian é do marco 5.

Requisitos: Node.js 22.16 ou superior (recomendado: 24) e git 2.38 ou superior.

> ⚠️ **O código do Cabeção é público; o seu cérebro não deve ser.** Use um repositório **privado**.

## Como funciona

```
 Claude Code · Claude Desktop · Codex · Cursor            Obsidian
             │ MCP (stdio)                                   │
             ▼                                               ▼
 ┌──────────────────────── cabecao ────────────────────────────┐
 │ no marco 1: recall · search · read · status · remember ·    │
 │ write_page · patch_page · sync · undo                       │
 │ planejadas: graph · facts · relate · ingest · handoff_save ·│
 │ forget · lint · consolidate                                 │
 └──────────┬──────────────────────────────────┬───────────────┘
            ▼                                  ▼
  Repositório git do cérebro            Índice local (fora do git)
  ├─ branch principal: suas notas       SQLite com busca por texto
  └─ branch cabecao/index (marco 2):    + vetores em memória (marco 2)
     embeddings e grafo                 + grafo (marco 3)
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
