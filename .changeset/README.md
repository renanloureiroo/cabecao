# Changesets

Cada mudança que deve sair numa versão nova do pacote `cabecao` entra aqui como um arquivo gerado por `pnpm changeset`, no mesmo PR da mudança. O arquivo diz o tipo de versão (`patch`, `minor` ou `major`) e traz o texto que vai para o `CHANGELOG.md`.

- Marque sempre o pacote **`cabecao`**. Ele é o único publicado; os pacotes `@cabecao/*` são privados e vão embutidos no bundle. O `pnpm changeset` nem oferece os privados; um changeset escrito à mão que cite um deles trava o PR de versão, e o CI recusa.
- PR sem changeset não gera versão nem publicação. Para registrar que um PR que mexe em `packages/` não precisa de versão, use `pnpm changeset --empty`.
- Depois do merge na `main`, o workflow `release` abre ou atualiza o PR "Version Packages", que consome os arquivos desta pasta, sobe a versão e escreve o `CHANGELOG.md`. Juntar esse PR publica no npm.
- O projeto está em **modo de pré-lançamento** (`pre.json`, etiqueta `beta`): as versões saem como `0.1.0-beta.N`. Enquanto isso, os changesets já usados vão para `pre/` e voltam no changelog da versão final. Para sair do beta: `pnpm changeset pre exit`.
- O Biome não formata os arquivos `.md` desta pasta: a formatação quebra o cabeçalho do changeset.

O passo a passo completo está em [docs/13-publicacao.md](../docs/13-publicacao.md).
