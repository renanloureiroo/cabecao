// Confere o bundle já construído, como o usuário vai rodar: `node packages/cli/dist/cabecao.mjs`.
// Com SMOKE_EXPECT=unsupported, espera que o Node atual seja recusado com a mensagem clara.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../packages/cli/dist/cabecao.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
const expectUnsupported = process.env.SMOKE_EXPECT === 'unsupported';

function cabecao(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failures += 1;
    console.log(JSON.stringify(detail, null, 2));
  }
}

console.log(`node ${process.version} em ${process.platform}/${process.arch}`);

if (expectUnsupported) {
  const version = cabecao('--version');
  check('Node não aceito sai com código 1', version.code === 1, version);
  check('nada em stdout', version.stdout === '', version);
  check(
    'stderr é só a mensagem clara',
    version.stderr ===
      `cabecao precisa de Node.js 22.16+ ou 24+. Versão atual: ${process.version}. Atualize em https://nodejs.org\n`,
    version,
  );
} else {
  const version = cabecao('--version');
  check(
    '--version imprime a versão do package.json',
    version.code === 0 && version.stdout === `${pkg.version}\n`,
    version,
  );
  check('--version não escreve em stderr', version.stderr === '', version);
  const help = cabecao('--help');
  check('--help sai com código 0 e mostra o uso', help.code === 0 && help.stdout.includes('--version'), help);
  const unknown = cabecao('comando-que-nao-existe');
  check(
    'comando desconhecido sai com código 2',
    unknown.code === 2 && unknown.stderr.includes('desconhecido'),
    unknown,
  );
}

process.exit(failures === 0 ? 0 : 1);
