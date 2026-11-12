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
```

`pnpm format` corrige a formatação. `node packages/cli/src/bin.ts --version` roda a CLI sem build, em Node 22.18 ou superior.

### Pacotes

| Pacote | Pasta | Publicado? |
|---|---|---|
| `cabecao` | `packages/cli` | Sim. É o único pacote no npm |
| `@cabecao/core` | `packages/core` | Não. Vai embutido no bundle |
| `@cabecao/server` | `packages/server` | Não. Vai embutido no bundle |
| `@cabecao/embeddings` | `packages/embeddings` | Não. Será instalado sob demanda no diretório de dados do usuário |

### O bundle

O `tsdown` gera dois arquivos em `packages/cli/dist`, sem dependências de runtime:

- `cabecao.mjs` é o bin. Ele só confere a versão do Node e carrega o resto.
- `main.mjs` é a CLI, com os pacotes do workspace e do npm embutidos.

A checagem fica num arquivo separado porque um `import` estático é avaliado antes de qualquer código. Num arquivo único, um Node antigo mostraria um erro cru em vez da mensagem.

## CI

O workflow [`ci.yml`](../.github/workflows/ci.yml) roda em todo Pull Request e em todo push na `main`:

| Job | O que confere |
|---|---|
| `check` | Lint, typecheck, testes, build e smoke em Linux, macOS e Windows, com Node 22, 24 e 26 (9 combinações) |
| `node-limits` | O bundle pronto roda no Node 22.16.0, o piso da faixa, e é recusado com a mensagem clara nos Nodes 20, 22.15.0 e 23 |
| `package` | `publint`, `npm publish --dry-run` sem avisos, e o comando `cabecao` instalado a partir do tarball |

## Publicar no npm

Só o pacote `cabecao` é publicado. A publicação nunca acontece por push ou por merge: alguém precisa disparar.

### Primeira publicação (reserva do nome)

O npm só permite ligar a publicação pelo GitHub Actions a um pacote que já existe. Por isso a primeira versão sai da sua máquina:

```bash
npm login
pnpm install && pnpm build
cd packages/cli
npm publish --dry-run     # confira a lista de arquivos
npm publish
```

### Ligar a publicação pelo GitHub Actions

Uma vez, depois da primeira publicação:

1. Em npmjs.com, abra o pacote `cabecao` e vá em **Settings**.
2. Em **Trusted Publisher**, escolha **GitHub Actions** e preencha: usuário `renanloureiroo`, repositório `cabecao`, workflow `release.yml`. Deixe o ambiente em branco.

Não existe `NPM_TOKEN` no repositório: o npm troca a identidade do job por uma credencial de curta duração e gera a atestação de proveniência.

### Publicar uma versão nova

1. Em cada mudança que mereça entrar no changelog, rode `pnpm changeset` e inclua o arquivo gerado no commit.
2. Na hora de lançar, rode `pnpm version-packages`. Ele sobe a versão do `cabecao` e escreve o `CHANGELOG.md`. Faça o commit e leve para a `main`.
3. No GitHub, abra **Actions > release > Run workflow**, na `main`. Rode primeiro com **dry-run** marcado; depois, desmarcado.

O workflow [`release.yml`](../.github/workflows/release.yml) repete lint, typecheck, testes, build e smoke antes de publicar.

> A publicação pelo GitHub Actions ainda não foi executada de ponta a ponta. A primeira execução real é a validação.
