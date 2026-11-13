// Copia o bundle da CLI (`packages/cli/dist`, gerado por `pnpm build`) para dentro do plugin do Claude Code, em
// `integrations/claude-code/server/`, e acerta a versão do `plugin.json` com a do pacote `cabecao`.
//
// Por que o bundle vai commitado: o Claude Code instala um plugin de marketplace clonando o repositório e copiando a
// pasta do plugin, sem passo de build, e não copia nada de fora dela (code.claude.com/docs, "Plugin marketplaces" e
// "Plugins reference"). O servidor MCP e os hooks rodam `node ${CLAUDE_PLUGIN_ROOT}/server/cabecao.mjs`, sem `npx` e
// sem rede (0,05 s contra 1,4 s; ADR 32).
//
// Quando roda: no PR "Version Packages" (`pnpm version-packages`, chamado pelo workflow release), depois de a versão
// subir; ou à mão, com `pnpm build:plugin`. O teste `packages/cli/test/plugin.test.ts` falha quando o bundle do plugin
// fica com outra versão que a do pacote ou quando um arquivo dele não bate com o `build.json`.
//
// Uso: node scripts/build-plugin.mjs [--check]
//   --check  não grava nada; sai com 1 se o plugin não corresponde ao dist atual.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dist = join(repo, 'packages', 'cli', 'dist');
const plugin = join(repo, 'integrations', 'claude-code');
const server = join(plugin, 'server');
const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
const check = process.argv.includes('--check');

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (!existsSync(join(dist, 'cabecao.mjs'))) {
  console.error(`o bundle não existe em ${dist}: rode "pnpm build" antes (ou "pnpm build:plugin", que faz os dois).`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(repo, 'packages', 'cli', 'package.json'), 'utf8'));
const files = readdirSync(dist)
  .filter((name) => name.endsWith('.mjs'))
  .sort();
const build = {
  comment:
    'Gerado por scripts/build-plugin.mjs a partir de packages/cli/dist. Não edite: rode "pnpm build:plugin". Os hashes são conferidos por packages/cli/test/plugin.test.ts.',
  version,
  files: Object.fromEntries(files.map((name) => [name, sha256(join(dist, name))])),
};
// só a linha da versão muda: o resto do manifesto fica como está (e com a formatação do Biome)
const manifestText = readFileSync(manifestPath, 'utf8');
const VERSION_LINE = /^ {2}"version": "[^"]*",$/m;
if (!VERSION_LINE.test(manifestText)) {
  console.error(`não achei a linha "version" em ${manifestPath}`);
  process.exit(1);
}
const nextManifest = manifestText.replace(VERSION_LINE, `  "version": ${JSON.stringify(version)},`);
const nextBuild = `${JSON.stringify(build, null, 2)}\n`;

if (check) {
  const current = existsSync(join(server, 'build.json')) ? readFileSync(join(server, 'build.json'), 'utf8') : '';
  const stale = current !== nextBuild || readFileSync(manifestPath, 'utf8') !== nextManifest;
  console.log(stale ? 'o plugin está defasado: rode "pnpm build:plugin"' : 'o plugin corresponde ao dist atual');
  process.exit(stale ? 1 : 0);
}

mkdirSync(server, { recursive: true });
for (const name of readdirSync(server)) {
  if (name.endsWith('.mjs') || name === 'build.json') rmSync(join(server, name));
}
for (const name of files) copyFileSync(join(dist, name), join(server, name));
writeFileSync(join(server, 'build.json'), nextBuild);
writeFileSync(manifestPath, nextManifest);
console.log(`plugin do Claude Code: ${files.length} arquivos do bundle ${version} em ${server}`);
