<p align="center">
  <strong>🧠 Cabeção</strong><br/>
  <em>Seu segundo cérebro pessoal, em Markdown e git, para você e seus agentes de IA.</em>
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>Português</strong>
</p>

> **Status: 🚧 beta.** Publicado no npm como [`cabecao@beta`](https://www.npmjs.com/package/cabecao). Comandos e formatos ainda podem mudar antes da 1.0.

---

O nome homenageia o **Cabeção** de *Malhação*: o personagem que sabe e lembra de tudo.

## O que é

Um **segundo cérebro pessoal** que vive num **repositório git seu**, em qualquer provedor (GitHub, GitLab, Bitbucket, Gitea, servidor próprio), e que qualquer agente de IA acessa por **MCP**. Você usa em quantas máquinas quiser: tudo sincroniza, inclusive embeddings e grafo.

- 📝 **Markdown é a fonte da verdade.** Você lê e edita no Obsidian ou em qualquer editor.
- 🔗 **Qualquer remoto git.** Sem depender de API de provedor, Pull Request ou CI.
- 🔄 **Sincroniza tudo o que o git não ignora.** Hoje: notas, anexos e configuração. Planejado (marco 2): embeddings e grafo, para que uma máquina nunca recalcule o que outra já calculou.
- 🔎 **Busca** por palavra-chave (hoje) e, no marco 2, também por significado, com um modelo local que você escolhe (nada sai da sua máquina).
- 🕸️ **Wiki com grafo** (marco 3, em revisão na branch `feat/m3-grafo`): wikilinks, relações tipadas, menções sem link e fatos com validade no tempo, que o agente navega (`graph`, `facts`, `relate`, `as_of` na busca).
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
 │ marco 1: recall · search · read · status · remember ·       │
 │ write_page · patch_page · sync · undo                       │
 │ marco 3: graph · facts · relate                             │
 │ planejadas: ingest · handoff_save · forget · lint ·         │
 │ consolidate                                                 │
 └──────────┬──────────────────────────────────┬───────────────┘
            ▼                                  ▼
  Repositório git do cérebro            Índice local (fora do git)
  ├─ branch principal: suas notas       SQLite com busca por texto
  └─ branch cabecao/index (marco 2):    + grafo e validade (marco 3)
     embeddings e grafo                 + vetores em memória (marco 2)
            │
            ▼  cabecao sync
   Qualquer remoto git
```

## Documentação

O site de documentação está sendo escrito. Até ele ser publicado, `cabecao --help` e `cabecao <comando> --help` descrevem cada comando.

## Contribuindo

Leia o [CONTRIBUTING.md](CONTRIBUTING.md). O projeto é escrito em TypeScript.

## Licença

[MIT](LICENSE) © Renan Pereira Loureiro
