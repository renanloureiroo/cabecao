// Embute as skills do Cabeção (fonte única: `integrations/skills/<nome>/SKILL.md`, mais o bloco de instruções
// `integrations/skills/instrucoes.md`) no código da CLI, em `packages/cli/src/skills/content.ts`. O pacote publicado é
// um bundle sem arquivos soltos: o conteúdo vai no código, como o modelo do cérebro (`core/src/init/template.ts`).
//
// Roda antes de todo `pnpm build` da CLI (o script "build" de packages/cli), e à mão com `pnpm build:skills`. O teste
// `packages/cli/test/skills.test.ts` falha se o arquivo gerado não bater com a fonte. A cópia para o plugin do Claude
// Code é feita por `scripts/build-plugin.mjs`, só no passo de versão (o plugin corresponde à versão publicada).
//
// Uso: node scripts/build-skills.mjs [--check]
//   --check  não grava nada; sai com 1 se o arquivo gerado está defasado.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const source = join(repo, 'integrations', 'skills');
const target = join(repo, 'packages', 'cli', 'src', 'skills', 'content.ts');
const check = process.argv.includes('--check');

/** Arquivos de uma pasta de skill, com caminho relativo em `/`, em ordem. */
function filesOf(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(path).isDirectory()) out.push(...filesOf(path, rel));
    else out.push({ path: rel, content: readFileSync(path, 'utf8').replaceAll('\r\n', '\n') });
  }
  return out;
}

function frontmatter(text, name) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) throw new Error(`${name}/SKILL.md sem frontmatter`);
  const field = (key) => new RegExp(`^${key}: (.+)$`, 'm').exec(match[1])?.[1]?.trim();
  return { name: field('name'), description: field('description') };
}

const skills = [];
for (const name of readdirSync(source).sort()) {
  const dir = join(source, name);
  if (!statSync(dir).isDirectory()) continue;
  if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`${dir} não tem SKILL.md`);
  const files = filesOf(dir);
  const meta = frontmatter(files.find((file) => file.path === 'SKILL.md').content, name);
  if (meta.name !== name) throw new Error(`${name}/SKILL.md: o name (${meta.name}) tem de ser igual ao nome da pasta`);
  skills.push({ name, description: meta.description, files });
}
const instructions = readFileSync(join(source, 'instrucoes.md'), 'utf8').replaceAll('\r\n', '\n');

const text = [
  '// Gerado por scripts/build-skills.mjs a partir de integrations/skills/. NÃO EDITE: mude a fonte e rode',
  '// "pnpm build:skills". O teste packages/cli/test/skills.test.ts confere que este arquivo bate com a fonte.',
  "import type { SkillSource } from './types.ts';",
  '',
  `export const SKILLS: readonly SkillSource[] = ${JSON.stringify(skills, null, 2)};`,
  '',
  `export const INSTRUCTIONS_BLOCK: string = ${JSON.stringify(instructions)};`,
  '',
].join('\n');

if (check) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const stale = current !== text;
  console.log(stale ? 'as skills embutidas estão defasadas: rode "pnpm build:skills"' : 'skills embutidas em dia');
  process.exit(stale ? 1 : 0);
}
const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
if (current !== text) writeFileSync(target, text);
console.log(`skills do Cabeção: ${skills.length} embutidas em ${target}`);
