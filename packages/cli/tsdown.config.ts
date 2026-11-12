import { defineConfig } from 'tsdown';

// ESM sem dependências de runtime, em vários arquivos:
// - cabecao.mjs: o bin. Só confere a versão do Node e carrega o resto.
// - main.mjs: o roteador de comandos e a ajuda. É o que `--version` e `--help` avaliam, e nada além disso.
// - um arquivo por comando (e pedaços compartilhados), gerados a partir do `import()` dinâmico de `commands.ts`,
//   com os pacotes do workspace e do npm embutidos. Só são lidos quando o comando roda.
// A separação do bin existe porque um `import` estático é avaliado antes de qualquer código: se a checagem
// morasse no mesmo arquivo, um Node antigo estouraria um erro cru em vez da mensagem (spike 14).
export default defineConfig({
  entry: { cabecao: 'src/bin.ts', main: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  minify: true,
  clean: true,
  deps: { alwaysBundle: [/.*/] },
  outExtensions: () => ({ js: '.mjs' }),
  treeshake: {
    // O núcleo é importado pelo índice (`@cabecao/core`), que reexporta tudo. Os módulos dele não têm efeito ao
    // serem carregados; marcá-los assim deixa o bundler descartar os que o comando não usa (e o `yaml` que vem
    // junto), em vez de embutir o núcleo inteiro em todo comando.
    moduleSideEffects: [{ test: /[\\/]packages[\\/]core[\\/]src[\\/]/, sideEffects: false }],
  },
});
