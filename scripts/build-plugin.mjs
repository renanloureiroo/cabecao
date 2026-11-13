// Copia o bundle da CLI (`packages/cli/dist`, gerado por `pnpm build`) para dentro do plugin do Claude Code, em
// `integrations/claude-code/server/`, copia as skills do Cabeção (`integrations/skills/<nome>/`, a fonte única) para
// `integrations/claude-code/skills/` (no lugar das que estavam lá) e acerta a versão do `plugin.json` (e a do manifesto
// do pacote `.mcpb` do Claude Desktop, `integrations/mcpb/manifest.json`) com a do pacote `cabecao`.
//
// Por que o bundle vai commitado: o Claude Code instala um plugin de marketplace clonando o repositório e copiando a
// pasta do plugin, sem passo de build, e não copia nada de fora dela (code.claude.com/docs, "Plugin marketplaces" e
// "Plugins reference"). O servidor MCP e os hooks rodam `node ${CLAUDE_PLUGIN_ROOT}/server/cabecao.mjs`, sem `npx` e
// sem rede (0,05 s contra 1,4 s; ADR 32).
//
// Quando roda: SÓ no PR "Version Packages" (`pnpm version-packages`, chamado pelo workflow release), depois de a versão
// subir. O plugin instalado a partir do repositório corresponde à VERSÃO PUBLICADA, não ao código do meio do
// desenvolvimento: um PR comum não refaz o bundle nem as skills do plugin (e não colide com os outros PRs por isso).
// O teste `packages/cli/test/plugin.test.ts` confere que o que está commitado é íntegro (cada arquivo bate com o
// `build.json`), sobe e é da versão declarada no `plugin.json`. Rodar à mão (`pnpm build:plugin`) só para conferir o
// passo; não commite o resultado fora do PR de versão.
//
// Uso: node scripts/build-plugin.mjs [--check]
//   --check  não grava nada; sai com 1 se o plugin não corresponde ao dist atual.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dist = join(repo, 'packages', 'cli', 'dist');
const plugin = join(repo, 'integrations', 'claude-code');
const server = join(plugin, 'server');
const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
const mcpbManifestPath = join(repo, 'integrations', 'mcpb', 'manifest.json');
const skillsSource = join(repo, 'integrations', 'skills');
const skillsTarget = join(plugin, 'skills');
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
/** Os arquivos das skills: `<skill>/<arquivo>` → caminho na fonte. */
function skillFiles() {
  const out = {};
  for (const name of readdirSync(skillsSource).sort()) {
    const dir = join(skillsSource, name);
    if (!statSync(dir).isDirectory()) continue;
    const walk = (current, prefix) => {
      for (const entry of readdirSync(current).sort()) {
        const path = join(current, entry);
        const rel = `${prefix}/${entry}`;
        if (statSync(path).isDirectory()) walk(path, rel);
        else out[rel] = path;
      }
    };
    walk(dir, name);
  }
  return out;
}
const skills = skillFiles();
const build = {
  comment:
    'Gerado por scripts/build-plugin.mjs a partir de packages/cli/dist e de integrations/skills, no passo de versão. Não edite. Os hashes são conferidos por packages/cli/test/plugin.test.ts.',
  version,
  files: Object.fromEntries(files.map((name) => [name, sha256(join(dist, name))])),
  skills: Object.fromEntries(Object.entries(skills).map(([rel, path]) => [rel, sha256(path)])),
};
// só a linha da versão muda: o resto do manifesto fica como está (e com a formatação do Biome)
const manifestText = readFileSync(manifestPath, 'utf8');
const VERSION_LINE = /^ {2}"version": "[^"]*",$/m;
if (!VERSION_LINE.test(manifestText)) {
  console.error(`não achei a linha "version" em ${manifestPath}`);
  process.exit(1);
}
const nextManifest = manifestText.replace(VERSION_LINE, `  "version": ${JSON.stringify(version)},`);
const mcpbText = readFileSync(mcpbManifestPath, 'utf8');
if (!VERSION_LINE.test(mcpbText)) {
  console.error(`não achei a linha "version" em ${mcpbManifestPath}`);
  process.exit(1);
}
const nextMcpb = mcpbText.replace(VERSION_LINE, `  "version": ${JSON.stringify(version)},`);
const nextBuild = `${JSON.stringify(build, null, 2)}\n`;

if (check) {
  const current = existsSync(join(server, 'build.json')) ? readFileSync(join(server, 'build.json'), 'utf8') : '';
  const stale = current !== nextBuild || manifestText !== nextManifest || mcpbText !== nextMcpb;
  console.log(stale ? 'o plugin está defasado: rode "pnpm build:plugin"' : 'o plugin corresponde ao dist atual');
  process.exit(stale ? 1 : 0);
}

mkdirSync(server, { recursive: true });
for (const name of readdirSync(server)) {
  if (name.endsWith('.mjs') || name === 'build.json') rmSync(join(server, name));
}
for (const name of files) copyFileSync(join(dist, name), join(server, name));
// as skills do plugin passam a ser exatamente as da fonte (a skill antiga "memory" sai)
rmSync(skillsTarget, { recursive: true, force: true });
for (const [rel, path] of Object.entries(skills)) {
  mkdirSync(dirname(join(skillsTarget, ...rel.split('/'))), { recursive: true });
  copyFileSync(path, join(skillsTarget, ...rel.split('/')));
}
writeFileSync(join(server, 'build.json'), nextBuild);
writeFileSync(manifestPath, nextManifest);
writeFileSync(mcpbManifestPath, nextMcpb);
console.log(
  `plugin do Claude Code: ${files.length} arquivos do bundle ${version} em ${server} e ${Object.keys(skills).length} arquivos de skills em ${skillsTarget}`,
);
