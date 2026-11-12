// Confere o bundle já construído, como o usuário vai rodar: `node packages/cli/dist/cabecao.mjs`.
// Com SMOKE_EXPECT=unsupported, espera que o Node atual seja recusado com a mensagem clara.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../packages/cli/dist/', import.meta.url));
const bin = join(dist, 'cabecao.mjs');
const pkg = JSON.parse(readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
const expectUnsupported = process.env.SMOKE_EXPECT === 'unsupported';

function cabecao(args, env = process.env) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });
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

/** Arquivos que `file` importa estaticamente (`import ... from "./x.mjs"`), em profundidade. */
function staticClosure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const code = readFileSync(join(dist, file), 'utf8');
  // `from"./x.mjs"` e `import"./x.mjs"`; o `import(...)` dinâmico fica de fora de propósito.
  for (const match of code.matchAll(/\b(?:from|import)\s*["'`](\.\/[^"'`]+)["'`]/g)) {
    staticClosure(match[1].slice(2), seen);
  }
  return seen;
}

/** Ambiente com a pasta do usuário trocada por uma temporária: nada da configuração real é lido ou escrito. */
function isolatedEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  env.APPDATA = join(home, 'AppData', 'Roaming');
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.CABECAO_CONFIG_DIR = join(home, 'cabecao-config');
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'CABECAO_BRAIN']) delete env[name];
  return env;
}

console.log(`node ${process.version} em ${process.platform}/${process.arch}`);

if (expectUnsupported) {
  const version = cabecao(['--version']);
  check('Node não aceito sai com código 1', version.code === 1, version);
  check('nada em stdout', version.stdout === '', version);
  check(
    'stderr é só a mensagem clara',
    version.stderr ===
      `cabecao precisa de Node.js 22.16+ ou 24+. Versão atual: ${process.version}. Atualize em https://nodejs.org\n`,
    version,
  );
} else {
  const version = cabecao(['--version']);
  check(
    '--version imprime a versão do package.json',
    version.code === 0 && version.stdout === `${pkg.version}\n`,
    version,
  );
  check('--version não escreve em stderr', version.stderr === '', version);
  const versionJson = cabecao(['--version', '--json']);
  check(
    '--version --json devolve um objeto',
    versionJson.code === 0 && JSON.parse(versionJson.stdout || 'null')?.data?.version === pkg.version,
    versionJson,
  );

  const help = cabecao(['--help']);
  check(
    '--help sai com código 0 e lista os comandos',
    help.code === 0 && help.stdout.includes('--version') && help.stdout.includes('install-client'),
    help,
  );
  const commandHelp = cabecao(['install-client', '--help']);
  check(
    'install-client --help mostra o uso',
    commandHelp.code === 0 && commandHelp.stdout.includes('--print') && commandHelp.stdout.includes('gemini'),
    commandHelp,
  );
  const unknown = cabecao(['comando-que-nao-existe']);
  check(
    'comando desconhecido sai com código 2',
    unknown.code === 2 && unknown.stderr.includes('desconhecido'),
    unknown,
  );
  const badOption = cabecao(['install-client', '--opcao-que-nao-existe']);
  check(
    'opção desconhecida sai com código 2, sem stack',
    badOption.code === 2 && badOption.stderr.includes('opção desconhecida') && !/\n\s+at /.test(badOption.stderr),
    badOption,
  );

  // Carga preguiçosa: o bin não importa nada estaticamente, e o caminho do `--version` (bin + main.mjs e o que ele
  // importa) não inclui o arquivo de nenhum comando.
  const files = readdirSync(dist).filter((name) => name.endsWith('.mjs'));
  check('o bin não tem import estático', staticClosure('cabecao.mjs').size === 1, [...staticClosure('cabecao.mjs')]);
  const eager = [...staticClosure('main.mjs')];
  const commandChunks = files.filter((name) => name.startsWith('install-client'));
  check(
    '--version e --help não avaliam o código dos comandos',
    commandChunks.length === 1 &&
      eager.length > 1 && // prova que a leitura dos imports funciona: main.mjs importa o pedaço compartilhado
      eager.every((name) => !commandChunks.includes(name)) &&
      staticClosure(commandChunks[0]).size > 1,
    { eager, files },
  );

  const home = mkdtempSync(join(tmpdir(), 'cabecao-smoke-'));
  try {
    const env = isolatedEnv(home);
    const brain = join(home, 'cérebro');
    const printed = cabecao(['install-client', 'codex', '--print', '--brain', brain], env);
    check(
      'install-client --print mostra a configuração com node e o arquivo do bin',
      printed.code === 0 &&
        printed.stdout.includes('[mcp_servers.cabecao]') &&
        printed.stdout.includes(JSON.stringify(bin).slice(1, -1)),
      printed,
    );
    check('install-client --print não grava nada', readdirSync(home).length === 0, readdirSync(home));

    const installed = cabecao(['install-client', 'cursor', '--brain', brain, '--json'], env);
    const cursorFile = join(home, '.cursor', 'mcp.json');
    const entry = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, 'utf8')).mcpServers?.cabecao : null;
    check(
      'install-client cursor grava o registro numa pasta de usuário temporária',
      installed.code === 0 && entry?.command === process.execPath && entry?.args?.at(-1) === brain,
      { installed, entry },
    );
    const again = cabecao(['install-client', 'cursor', '--brain', brain, '--json'], env);
    check(
      'install-client é idempotente',
      again.code === 0 && JSON.parse(again.stdout || 'null')?.data?.clients?.[0]?.status === 'unchanged',
      again,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const times = [];
  for (let i = 0; i < 10; i++) {
    const start = process.hrtime.bigint();
    cabecao(['--version']);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  const sizes = files.map((name) => `${name} ${readFileSync(join(dist, name)).length} B`).join(', ');
  console.log(`info --version: mediana ${times[5].toFixed(0)} ms (mín ${times[0].toFixed(0)} ms) em 10 execuções`);
  console.log(`info bundle: ${sizes}`);
}

process.exit(failures === 0 ? 0 : 1);
