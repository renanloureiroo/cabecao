import { defineConfig } from 'tsdown';

// Dois arquivos ESM sem dependências de runtime:
// - cabecao.mjs: o bin. Só confere a versão do Node e carrega o resto.
// - main.mjs: a CLI inteira, com os pacotes do workspace e do npm embutidos.
// A separação existe porque um `import` estático é avaliado antes de qualquer código: se a checagem
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
});
