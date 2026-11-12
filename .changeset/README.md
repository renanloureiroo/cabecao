# Changesets

Cada mudança que deve aparecer no changelog do pacote `cabecao` entra aqui como um arquivo gerado por `pnpm changeset`.

- Só o pacote `cabecao` (em `packages/cli`) é publicado. Os pacotes `@cabecao/*` são privados e vão embutidos no bundle.
- `pnpm version-packages` consome os arquivos desta pasta, sobe a versão e escreve o `CHANGELOG.md`.
- O Biome não formata os arquivos desta pasta: a formatação quebra o cabeçalho do changeset.
