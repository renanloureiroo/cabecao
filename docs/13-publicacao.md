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
| `changeset` | Só em Pull Request. Avisa, sem falhar, quando o PR mexe em `packages/` e não traz changeset. Falha se um changeset citar outro pacote além do `cabecao` |

## Publicar no npm

Só o pacote `cabecao` é publicado. A versão e o `CHANGELOG.md` saem dos **changesets**: arquivos curtos em `.changeset/`, escritos no próprio PR da mudança, que dizem o tipo de versão (`patch`, `minor` ou `major`) e o texto do changelog. A publicação é feita pelo workflow [`release.yml`](../.github/workflows/release.yml), por *trusted publishing*, sem token guardado no repositório.

### O fluxo

1. **PR com a mudança e um changeset.** Rode `pnpm changeset`, marque o pacote `cabecao`, escolha `patch`, `minor` ou `major` e escreva o texto do changelog. Commite o arquivo gerado junto com a mudança.
2. **Merge na `main`.** O workflow `release` vê o changeset pendente e abre o PR **"Version Packages (beta)"**, na branch `changeset-release/main`. Esse PR consome os changesets, sobe a versão em `packages/cli/package.json` e escreve o `packages/cli/CHANGELOG.md`. Cada novo merge com changeset atualiza o mesmo PR: várias mudanças saem juntas numa versão só.
3. **CI no PR de versão.** O workflow dispara o `ci.yml` na branch do PR de versão (veja [abaixo](#o-ci-do-pr-de-versão) por quê).
4. **Decisão de lançar.** Quando quiser lançar, alguém revisa e junta o PR "Version Packages". Esse é o único passo humano.
5. **Publicação.** O merge dispara o `release` de novo. Agora não há changeset pendente e a versão do `package.json` ainda não está no npm, então ele roda lint, typecheck, testes, build, smoke e o teste de ponta a ponta, empacota (`npm pack`), roda `npm publish --dry-run`, publica esse mesmo tarball com a etiqueta certa e cria a tag `vX.Y.Z` e a release no GitHub, com as notas daquela versão tiradas do `CHANGELOG.md`. Versões com `-beta.` saem como pré-lançamento.

PR sem changeset não gera versão nem publicação: o merge passa pelo `release` sem fazer nada. Um push na `main` cuja versão já está no npm também não faz nada, então rodar o workflow de novo nunca republica.

### O que é automático e o que é decisão humana

| Automático | Humano |
|---|---|
| Abrir e atualizar o PR "Version Packages" | Escrever o changeset no PR da mudança e escolher patch, minor ou major |
| Calcular a versão e escrever o `CHANGELOG.md` | Revisar e juntar o PR "Version Packages": é isso que decide **quando** sai uma versão |
| Rodar todas as conferências antes de publicar | Entrar e sair do beta (`changeset pre enter` / `pre exit`, num PR) |
| Publicar no npm com a etiqueta certa | Corrigir uma publicação que falhou no meio (abaixo) |
| Criar a tag `vX.Y.Z` e a release no GitHub | |

### Quero... o que faço

| Quero | O que faço | O que sai (hoje, no beta) |
|---|---|---|
| Lançar uma correção (**patch**) | `pnpm changeset` → `cabecao` → `patch`, no PR da correção | `0.1.0-beta.N` seguinte |
| Lançar algo novo (**minor**) | `pnpm changeset` → `cabecao` → `minor` | Também o `0.1.0-beta.N` seguinte (veja a sequência abaixo) |
| Lançar uma quebra de compatibilidade (**major**) | `pnpm changeset` → `cabecao` → `major` | `1.0.0-beta.N`. No 0.x, use só se for mesmo para a 1.0 |
| Juntar um PR que não deve gerar versão | Nada. Para silenciar o aviso do CI: `pnpm changeset --empty` | Nada |
| Continuar no **beta** | Nada: o modo de pré-lançamento já está ligado (`.changeset/pre.json`) | `0.1.0-beta.N` com a etiqueta `beta` |
| **Sair do beta** | Num PR: `pnpm changeset pre exit` e commite o `.changeset/pre.json` alterado. Antes, revise `.changeset/pre/`: esses changesets viram o changelog da versão final | O PR de versão passa a propor `0.1.0`, publicada com a etiqueta `latest` |
| Voltar ao beta depois de uma versão final | Num PR: `pnpm changeset pre enter beta` | Ex.: de `0.1.0`, um `minor` vira `0.2.0-beta.0` |
| Trocar a etiqueta do pré-lançamento (ex.: `rc`) | Edite `"tag"` em `.changeset/pre.json`, num PR | `X.Y.Z-rc.N` com a etiqueta `rc` |
| **Hotfix** urgente | PR normal com a correção e um changeset `patch`; junte; junte em seguida o PR "Version Packages" | A próxima versão (no beta, `0.1.0-beta.N`). Não há branch de release |
| Simular a publicação | Actions > release > Run workflow, na `main`, com **dry-run** marcado | Nada publicado: confere, empacota e roda `npm publish --dry-run` |

#### A sequência de versões no beta

No modo de pré-lançamento, o Changesets soma o tipo de versão à base do beta atual e numera os betas em sequência. Como `0.1.0-beta.1` já é um pré-lançamento da `0.1.0`, um `patch` ou um `minor` só incrementam o número do beta. Simulado com `changeset version` (Changesets 3.0.3) a partir do estado atual:

| Changeset | Versão |
|---|---|
| (ponto de partida) | `0.1.0-beta.1` |
| `minor` | `0.1.0-beta.2` |
| `patch` | `0.1.0-beta.3` |
| `minor` | `0.1.0-beta.4` |
| `patch` | `0.1.0-beta.5` |
| `--empty` | `0.1.0-beta.5` (não muda) |
| `major` | `1.0.0-beta.6` |
| `pre exit` (a partir de `0.1.0-beta.2`) | `0.1.0`, com todas as entradas do beta no changelog |

Ou seja: enquanto estiver no beta da `0.1.0`, tudo sai como `0.1.0-beta.N`, e a próxima minor em beta (`0.2.0-beta.0`) só aparece depois de lançar a `0.1.0` e entrar no beta de novo.

### Versões e etiquetas

| Versão | Etiqueta no npm | Quem recebe |
|---|---|---|
| `0.1.0-beta.0`, `0.1.0-beta.1`... | `beta` | Só quem pede: `npx cabecao@beta` |
| `0.1.0`, `0.2.0`... | `latest` | Todo mundo: `npx cabecao` |

A etiqueta sai da própria versão: `X.Y.Z-beta.N` vai para `beta`, `X.Y.Z` vai para `latest`. No modo de pré-lançamento, o workflow recusa publicar uma versão cuja etiqueta não seja a do `.changeset/pre.json`.

### O CI do PR de versão

Um PR criado pelo `GITHUB_TOKEN` do Actions não dispara o CI sozinho: o GitHub deixa as execuções de `pull_request` desse PR esperando alguém clicar em **Approve workflows to run**, para evitar laços entre workflows. Para não depender disso e sem guardar um token pessoal, o `release` dispara o `ci.yml` por `workflow_dispatch` na branch `changeset-release/main` logo depois de atualizar o PR (precisa de `actions: write`). Os checks dessa execução ficam presos ao commit e aparecem no PR.

O que continua manual: as execuções de `pull_request` daquele PR podem aparecer como esperando aprovação. Dá para ignorá-las (o CI já rodou pelo disparo) ou aprová-las no próprio PR. Se um dia isso incomodar, a saída sem clique é um GitHub App com o token passado à `changesets/action/version` (`github-token`), como a documentação do Changesets descreve.

### Se a publicação falhar no meio

| Situação | O que fazer |
|---|---|
| Falhou antes de publicar (lint, teste, build, rede) | Nada saiu. Se foi algo passageiro, em Actions abra a execução e use **Re-run failed jobs**. Se precisa de correção, faça um PR **sem changeset**: o merge encontra a versão ainda fora do npm e publica. Um PR **com** changeset abriria um novo PR de versão, e a versão não publicada ficaria pulada |
| Versão subida na `main` mas não publicada | Igual à linha acima. Também dá para rodar Actions > release > Run workflow com **dry-run** desmarcado |
| Publicada no npm, mas sem tag ou release | **Re-run failed jobs** na mesma execução (a tag vai no commit publicado). Rodar o workflow à mão com **dry-run** desmarcado também cria a tag e a release, mas no commit atual da `main` |
| Publicou uma versão com defeito | O npm não deixa republicar a mesma versão. Lance uma correção pelo fluxo normal e marque a ruim: `npm deprecate cabecao@X.Y.Z "use X.Y.W"` |
| O PR de versão não abriu (`GitHub Actions is not permitted to create or approve pull requests`) | Falta a configuração do repositório abaixo |

O workflow é idempotente: só publica se a versão não estiver no npm, e só cria a release se ela não existir. Duas execuções nunca rodam ao mesmo tempo (`concurrency`).

### Sem branch `release/x.y`

Hoje tudo sai da `main`: o beta é a própria `main` em modo de pré-lançamento, e um hotfix é um PR normal seguido do PR de versão. Uma branch `release/x.y` só passa a fazer sentido quando houver **duas linhas vivas ao mesmo tempo**, por exemplo corrigir a `1.x` enquanto a `main` está no beta da `2.0`, ou manter um beta numa branch separada enquanto a `main` lança versões finais. Aí a branch precisa do próprio `baseBranch` do Changesets, de um gatilho no `release.yml` para ela e de uma etiqueta própria no npm (ex.: `release-1.x`). O guia de [*backporting*](https://changesets.dev/guide/backporting-changes) do Changesets descreve esse caminho.

### Configuração do repositório (uma vez)

1. **Trusted publisher no npm** (já feito): em npmjs.com > pacote `cabecao` > Settings > Trusted Publisher, GitHub Actions, usuário `renanloureiroo`, repositório `cabecao`, workflow `release.yml`, ambiente em branco. O cadastro amarra o **nome do arquivo**: renomear o `release.yml` quebra a publicação.
2. **Deixar o Actions abrir pull requests**, para o PR "Version Packages": em Settings > Actions > General > Workflow permissions, marque **Allow GitHub Actions to create and approve pull requests** e salve. Pelo terminal:

   ```bash
   gh api -X PUT repos/renanloureiroo/cabecao/actions/permissions/workflow \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
   ```

A primeira publicação (`0.1.0-beta.0`) já foi feita e o trusted publishing está ligado, então o workflow não aceita mais token do npm.
