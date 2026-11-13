# 13 · Desenvolvimento, CI e publicação

> Este documento trata do **repositório do projeto**. O Cabeção em uso não depende de GitHub, de CI nem de Pull Request ([ADR 03](adr/README.md)).

## Desenvolver

Requisitos: Node.js 22.16 ou superior (recomendado: 24) e pnpm 10.

```bash
pnpm install
pnpm lint         # Biome: lint e formatação
pnpm typecheck    # tsc --noEmit
pnpm test         # Vitest
pnpm build        # tsdown: gera packages/cli/dist
pnpm smoke        # roda o bundle pronto
pnpm e2e          # ponta a ponta: duas máquinas e um remoto local, sobre o bundle
```

`pnpm e2e` precisa do bundle pronto (`pnpm build` antes). Ele simula duas máquinas e um remoto em pasta local e exercita, pelo `cabecao` gerado, o ciclo completo: `init`, escrita, `sync` entre as duas, conflito e `undo`.

`pnpm format` corrige a formatação. `node packages/cli/src/bin.ts --version` roda a CLI sem build, em Node 22.18 ou superior.

### Pacotes

| Pacote | Pasta | Publicado? |
|---|---|---|
| `cabecao` | `packages/cli` | Sim. É o único pacote no npm |
| `@cabecao/core` | `packages/core` | Não. Vai embutido no bundle |
| `@cabecao/server` | `packages/server` | Não. Vai embutido no bundle |
| `@cabecao/embeddings` | `packages/embeddings` | Não. Será instalado sob demanda no diretório de dados do usuário |

### O bundle

O `tsdown` gera, em `packages/cli/dist`, um conjunto pequeno de arquivos (18 no pacote publicado, 241 kB compactado), sem dependências de runtime:

- `cabecao.mjs` é o bin. Ele só confere a versão do Node e carrega o resto.
- `main.mjs` é a CLI. Cada comando vira um arquivo à parte, carregado só quando roda; os pacotes do workspace e do npm vão embutidos. Mais da metade do peso é o SDK do MCP com o Zod, carregado só no `cabecao mcp`.

A checagem fica num arquivo separado porque um `import` estático é avaliado antes de qualquer código. Num arquivo único, um Node antigo mostraria um erro cru em vez da mensagem.

## CI

O workflow [`ci.yml`](../.github/workflows/ci.yml) roda em todo Pull Request e em todo push na `main`:

| Job | O que confere |
|---|---|
| `check` | Lint, typecheck, testes (1.181), build, smoke e o teste de ponta a ponta com duas máquinas (`pnpm e2e`), em Linux, macOS e Windows, com Node 22, 24 e 26 (9 combinações) |
| `node-limits` | O bundle pronto roda no Node 22.16.0, o piso da faixa, e é recusado com a mensagem clara nos Nodes 20, 22.15.0 e 23 |
| `package` | `publint`, `npm publish --dry-run` sem avisos, e o comando `cabecao` instalado a partir do tarball |

## Publicar no npm

Só o pacote `cabecao` é publicado. A publicação nunca acontece por push ou por merge: alguém precisa disparar o workflow [`release.yml`](../.github/workflows/release.yml), na `main`. Ele repete lint, typecheck, testes, build, smoke e o teste de ponta a ponta, publica, e cria a tag `vX.Y.Z` e a release no GitHub.

### Versões e etiquetas

| Versão | Etiqueta no npm | Quem recebe |
|---|---|---|
| `0.1.0-beta.0`, `0.1.0-beta.1`... | `beta` | Só quem pede: `npx cabecao@beta` |
| `0.1.0`, `0.2.0`... | `latest` | Todo mundo: `npx cabecao` |

O workflow recusa uma versão de pré-lançamento com a etiqueta `latest`, uma versão final com a etiqueta `beta`, e uma versão cuja tag já existe.

### Primeira publicação

O npm só deixa cadastrar a publicação pelo GitHub Actions num pacote que já existe. A documentação oficial não diz isso com todas as letras; é o que os guias da comunidade relatam. Por isso a primeira versão sai por um destes dois caminhos.

**Pela sua máquina** (mais simples):

```bash
npm login
pnpm install && pnpm build
cd packages/cli
npm publish --dry-run --tag beta    # confira a lista de arquivos
npm publish --tag beta
```

**Pelo GitHub Actions, com um token temporário:**

1. Em npmjs.com, crie um *granular access token* com permissão de leitura e escrita em pacotes, com validade curta.
2. No GitHub, em Settings > Secrets and variables > Actions, crie o secret `NPM_TOKEN` com esse token.
3. Em Actions > release > Run workflow, na `main`: rode uma vez com **dry-run** marcado; depois com **dry-run** desmarcado e **usar-token** marcado.
4. Apague o secret e revogue o token.

### Ligar o trusted publishing

Uma vez, depois da primeira publicação:

1. Em npmjs.com, abra o pacote `cabecao` e vá em **Settings**.
2. Em **Trusted Publisher**, escolha **GitHub Actions** e preencha: usuário `renanloureiroo`, repositório `cabecao`, workflow `release.yml`. Deixe o ambiente em branco.

A partir daí não existe token no repositório: o npm troca a identidade do job por uma credencial de curta duração e gera a atestação de proveniência. O cadastro precisa de uma publicação bem-sucedida em até 2 dias, senão expira.

### Publicar uma versão nova

1. Suba a versão em `packages/cli/package.json` (ou use `pnpm changeset` e `pnpm version-packages`, que também escrevem o `CHANGELOG.md`). Leve para a `main`.
2. Em Actions > release > Run workflow, na `main`: escolha a etiqueta, rode com **dry-run** marcado e depois desmarcado.

> A publicação pelo GitHub Actions ainda não foi executada de ponta a ponta. A primeira execução real é a validação.
