# Pacote `.mcpb` para o Claude Desktop

O Claude Desktop instala servidores MCP locais por um MCP Bundle (`.mcpb`, [especificação](https://github.com/modelcontextprotocol/mcpb)). O do Cabeção traz o servidor **embutido**: o mesmo bundle publicado no npm, sem `npx`, sem `node_modules` e sem rede.

| Arquivo | O que é |
|---|---|
| [`manifest.json`](manifest.json) | Manifesto (especificação 0.3). A versão acompanha a do pacote `cabecao` (o `pnpm build:plugin` acerta) |
| `../../scripts/build-mcpb.mjs` | Monta o pacote: `manifest.json`, `icon.png` (de `assets/marca/icone-512.png`) e `server/*.mjs` (o bundle) |
| `dist/` | Saída local, fora do git |

```bash
pnpm build:mcpb          # constrói a CLI e gera integrations/mcpb/dist/cabecao-<versão>.mcpb
node scripts/build-mcpb.mjs --dist <pasta do bundle> --out <pasta> --version <x.y.z>
```

O zip é reproduzível (entradas em ordem, data fixa, permissões fixas, sem campo extra): a mesma entrada dá os mesmos bytes. O `packages/cli/test/mcpb.test.ts` confere o manifesto, o conteúdo (só manifesto, ícone e bundle), a reprodutibilidade e sobe o servidor a partir do pacote extraído, substituindo `${__dirname}` e `${user_config.brain_dir}` como o aplicativo faria.

Na publicação, o workflow `release` monta o `.mcpb` com o bundle do mesmo tarball publicado no npm e o anexa à release do GitHub, num job que não impede a publicação se falhar.

O manifesto foi validado com a ferramenta oficial (`npx @anthropic-ai/mcpb validate`, versão 2.1.2) e o pacote, aberto por ela (`mcpb unpack`, `mcpb info`). **A instalação no Claude Desktop de verdade não foi testada.** O pacote não é assinado.

Uso: [Claude Desktop](https://renanloureiroo.github.io/cabecao/guias/claude-desktop).
