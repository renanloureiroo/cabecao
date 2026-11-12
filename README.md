<p align="center">
  <strong>🧠 Cabeção</strong><br/>
  <em>O segundo cérebro local-first para você e seus agentes de IA, servido por MCP.</em>
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>Português</strong>
</p>

> **Status: 🚧 em planejamento.** A arquitetura, as decisões e o roadmap estão abertos em [`docs/`](docs/). Ainda não existe versão instalável; acompanhe o [roadmap](docs/10-roadmap.md).

---

O nome é uma homenagem ao **Cabeção** de *Malhação*: aquele personagem que sabe de tudo e lembra de tudo. A ideia é a mesma: um cérebro externo que **lembra por você e pelos seus agentes**, entre sessões, ferramentas e máquinas.

## O que é

O Cabeção é um **segundo cérebro** guardado em **Markdown dentro de um repositório git**: na sua máquina e, se você quiser, num repositório privado no GitHub. Ele expõe esse cérebro para qualquer agente de IA (Claude Code, Claude Desktop, Codex, Cursor...) por meio de um **servidor MCP**.

- 📝 **Markdown é a fonte da verdade.** Você lê e edita tudo no Obsidian (ou em qualquer editor).
- 🔎 **Busca híbrida:** palavra-chave (BM25) + semântica (embeddings) + grafo de links, com orçamento de tokens.
- 🕸️ **Grafo de conhecimento:** wikilinks, relações tipadas, entidades e **fatos com validade no tempo**.
- 🧠 **Memória de agente:** `remember`/`recall` com escopo, tipo, proveniência e resolução de conflitos (ADD/UPDATE/SUPERSEDE).
- 🔄 **Sincroniza tudo**, incluindo **embeddings, grafo e índices**, via git, sem recalcular o que já foi calculado em outra máquina.
- 🧹 **Manutenção automática:** *lint*, consolidação e esquecimento. As mudanças chegam como **Pull Request** para você aprovar.
- 🔒 **Local-first e privado:** embeddings locais por padrão, scanner de segredos e conteúdo externo marcado como não confiável.
- 🔌 **MCP moderno:** especificação **2026-07-28** (núcleo *stateless*), compatível com clientes da geração anterior.
- 🖥️ **Visual:** Obsidian (grafo, Bases, Canvas) e um **MCP App** com explorador do grafo dentro do Claude.

## Como funciona (resumo)

```
 Claude Code · Claude Desktop · Codex · Cursor            Obsidian
             │ MCP (stdio / HTTP local)                      │
             ▼                                               ▼
 ┌───────────────────── cabecao (daemon + MCP) ─────────────────────┐
 │ search · read · write · remember · recall · graph · facts ·      │
 │ ingest · handoff · lint · consolidate · sync                     │
 └──────────┬──────────────────────────────────────┬───────────────┘
            ▼                                      ▼
  Repositório git do seu cérebro          .cabecao/cache/cabecao.db
  ├─ raw/  wiki/  memory/   (conteúdo)    (SQLite: FTS5 + sqlite-vec +
  └─ .cabecao/ embeddings/ graph/          tabelas de grafo; reconstruído
     (derivados sincronizados)              incrementalmente)
            │
            ▼ cabecao sync (pull → reindex incremental → push)
     GitHub (repo PRIVADO do seu cérebro)
```

Detalhes em [docs/02-arquitetura.md](docs/02-arquitetura.md).

## Instalação (planejada)

```bash
npx cabecao@latest init
```

O assistente de instalação:
1. cria (ou adota) a pasta do cérebro com a estrutura e o schema;
2. inicializa o git e, se você quiser, cria um **repo privado** no GitHub;
3. configura os embeddings (local por padrão, sem chave de API);
4. registra o MCP nos clientes encontrados (Claude Code, Claude Desktop, Codex, Cursor);
5. configura o Obsidian (grafo colorido, dashboards em Bases);
6. roda `cabecao doctor`.

Outras formas: **plugin do Claude Code** (`/plugin marketplace add renanloureiroo/cabecao`) e **MCPB** com um clique para o Claude Desktop. Veja [docs/08-instalacao-e-operacao.md](docs/08-instalacao-e-operacao.md).

> ⚠️ **O código do Cabeção é público; o seu cérebro não deve ser.** Guarde o repositório do seu cérebro como **privado**.

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 · Visão](docs/01-visao.md) | Problema, objetivos, não-objetivos, princípios |
| [02 · Arquitetura](docs/02-arquitetura.md) | Componentes, processos e fluxos |
| [03 · Modelo de dados](docs/03-modelo-de-dados.md) | Estrutura do vault, frontmatter, SQLite |
| [04 · Sincronização](docs/04-sincronizacao.md) | Como embeddings, grafo e índices são sincronizados |
| [05 · Servidor MCP](docs/05-mcp.md) | Tools, resources, prompts e extensões (spec 2026-07-28) |
| [06 · Busca e grafo](docs/06-busca-e-grafo.md) | Recuperação híbrida, relações, fatos temporais, comunidades |
| [07 · Ciclo de vida e segurança](docs/07-ciclo-de-vida-e-seguranca.md) | Consolidação, esquecimento, confiança, segredos |
| [08 · Instalação e operação](docs/08-instalacao-e-operacao.md) | Instalar, atualizar, diagnosticar |
| [09 · Guia do Obsidian](docs/09-obsidian.md) | Visualizar e navegar o cérebro no Obsidian |
| [10 · Roadmap](docs/10-roadmap.md) | Marcos e entregas |
| [ADRs](docs/adr/) | Registro das decisões de arquitetura |

## Contribuindo

O projeto está no começo e toda ajuda é bem-vinda, principalmente para discutir a arquitetura. Leia o [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE) © Renan Pereira Loureiro
