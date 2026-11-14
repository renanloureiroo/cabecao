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
/** Comandos registrados; cada um vira um arquivo próprio no bundle, carregado só quando roda. */
const COMMAND_NAMES = [
  'init',
  'status',
  'doctor',
  'sync',
  'search',
  'graph',
  'facts',
  'undo',
  'mcp',
  'install-client',
  'embeddings',
  'compact',
  'eval',
  'reindex',
  'recall',
  'schedule',
  'lint',
  'ingest',
  'forget',
  'consolidate',
  'read',
  'remember',
  'write',
  'patch',
  'relate',
  'handoff',
  'obsidian',
  'export',
  'upgrade',
  'ask',
  'llm',
  'install-skills',
  'uninstall',
];

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
      `cabecao precisa de Node.js 22.16 ou mais novo.${process.version.startsWith('v23.') ? ' A linha 23 não serve (falta a busca de texto do SQLite): use a 24.' : ''} Versão atual: ${process.version}. Atualize em https://nodejs.org\n`,
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
    help.code === 0 &&
      help.stdout.includes('--version') &&
      COMMAND_NAMES.every((name) => help.stdout.includes(`  ${name} `)),
    help,
  );
  for (const name of COMMAND_NAMES) {
    const own = cabecao([name, '--help']);
    check(`${name} --help mostra o uso`, own.code === 0 && own.stdout.includes(`cabecao ${name}`), own);
  }
  const clientHelp = cabecao(['install-client', '--help']);
  check(
    'install-client --help cita os clientes',
    clientHelp.stdout.includes('--print') && clientHelp.stdout.includes('gemini'),
    clientHelp,
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
  const commandChunks = files.filter((name) => COMMAND_NAMES.some((command) => name.startsWith(`${command}-`)));
  // O núcleo é o pedaço que carrega o `node:sqlite`; o servidor MCP, o que traz o SDK do MCP; o runtime de
  // embeddings, o que gera o `loader.mjs` do onnxruntime.
  const heavy = files.filter((name) => {
    const code = readFileSync(join(dist, name), 'utf8');
    return code.includes('node:sqlite') || code.includes('modelcontextprotocol') || code.includes('onnxruntime-node');
  });
  check(
    '--version e --help não avaliam o código dos comandos, do núcleo, do servidor MCP nem do runtime de embeddings',
    commandChunks.length === COMMAND_NAMES.length &&
      heavy.length > 0 &&
      eager.length > 1 && // prova que a leitura dos imports funciona: main.mjs importa o pedaço compartilhado
      eager.every((name) => !commandChunks.includes(name) && !heavy.includes(name)) &&
      commandChunks.every((name) => staticClosure(name).size > 1),
    { eager, heavy, commandChunks, files },
  );

  // O hook de início de sessão não pode carregar o servidor MCP (o pedaço com o SDK do MCP). O runtime de embeddings
  // nunca está no bundle: é instalado no cache do usuário e só a busca por significado o carrega, por import() de
  // arquivo; o `recall` do núcleo busca só por palavra-chave.
  const recallChunk = files.find((name) => name.startsWith('recall-'));
  const recallClosure = recallChunk === undefined ? [] : [...staticClosure(recallChunk)];
  const mcpChunks = files.filter((name) => readFileSync(join(dist, name), 'utf8').includes('modelcontextprotocol'));
  check(
    'recall (o hook de início) não importa o servidor MCP',
    recallChunk !== undefined && mcpChunks.length > 0 && recallClosure.every((name) => !mcpChunks.includes(name)),
    { recallClosure, mcpChunks },
  );

  const consolidateChunk = files.find((name) => name.startsWith('consolidate-'));
  const consolidateClosure = consolidateChunk === undefined ? [] : [...staticClosure(consolidateChunk)];
  check(
    'consolidate (e o --run) não importa o servidor MCP',
    consolidateChunk !== undefined && consolidateClosure.every((name) => !mcpChunks.includes(name)),
    { consolidateClosure, mcpChunks },
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

    const skillsPrint = cabecao(['install-skills', '--print', 'codex'], env);
    check(
      'install-skills --print mostra as skills e não grava nada',
      skillsPrint.code === 0 &&
        skillsPrint.stdout.includes('name: cabecao-consultar') &&
        !existsSync(join(home, '.agents')),
      skillsPrint,
    );
    const skillsInstall = cabecao(['install-skills', 'codex'], env);
    check(
      'install-skills codex grava as skills numa pasta de usuário temporária',
      skillsInstall.code === 0 && existsSync(join(home, '.agents', 'skills', 'cabecao-consultar', 'SKILL.md')),
      skillsInstall,
    );
    const dryUninstall = cabecao(['uninstall', '--dry-run'], env);
    check(
      'uninstall --dry-run lista o que sairia e não remove nada',
      dryUninstall.code === 0 &&
        dryUninstall.stdout.includes('nada foi feito') &&
        existsSync(join(home, '.agents', 'skills', 'cabecao-consultar', 'SKILL.md')),
      dryUninstall,
    );
    // com CI ligado é agente mesmo rodando de um terminal: nunca pergunta nada no terminal de quem roda o smoke
    const agentUninstall = cabecao(['uninstall'], { ...env, CI: 'true' });
    check('uninstall sem terminal é recusado com o código 4', agentUninstall.code === 4, agentUninstall);

    const noBrain = cabecao(['status'], { ...env, CABECAO_BRAIN: join(home, 'não existe') });
    check(
      'status sem cérebro sai com 1 e diz o que fazer, sem stack',
      noBrain.code === 1 && noBrain.stderr.includes('cabecao init') && !/\n\s+at /.test(noBrain.stderr),
      noBrain,
    );
    const doctor = cabecao(['doctor', '--offline', '--json'], env);
    const doctorJson = JSON.parse(doctor.stdout || 'null');
    check(
      'doctor sem cérebro: verifica Node e git e falha no cérebro (código 1)',
      doctor.code === 1 &&
        doctorJson?.data?.checks?.find((item) => item.id === 'node')?.status === 'ok' &&
        doctorJson?.data?.checks?.find((item) => item.id === 'brain')?.status === 'fail',
      doctor,
    );
    const hookStart = Date.now();
    const hook = spawnSync(process.execPath, [bin, 'recall', '--hook'], {
      encoding: 'utf8',
      env: { ...env, CABECAO_BRAIN: join(home, 'não existe') },
      input: '{"hook_event_name":"SessionStart"}',
    });
    check(
      `recall --hook sem cérebro: {} em stdout e código 0 (${Date.now() - hookStart} ms)`,
      hook.status === 0 && hook.stdout === '{}\n' && hook.stderr.includes('recall --hook'),
      hook,
    );
    const end = spawnSync(process.execPath, [bin, 'sync', '--hook'], { encoding: 'utf8', env, input: '{}' });
    check('sync --hook sem cérebro: código 0, nada em stdout', end.status === 0 && end.stdout === '', end);
    const llmStatus = cabecao(['llm', 'status', '--json'], env);
    check(
      'llm status sem nada configurado: código 0, desligado, nada sai da máquina',
      llmStatus.code === 0 && JSON.parse(llmStatus.stdout || 'null')?.data?.enabled === false,
      llmStatus,
    );
    const llmOn = cabecao(['llm', 'on', '--provider', 'openai'], env);
    check(
      'llm on sem terminal recusa (ativar é com você no terminal), sem stack',
      llmOn.code === 4 && llmOn.stderr.includes('terminal') && !/\n\s+at /.test(llmOn.stderr),
      llmOn,
    );
    const mcpJson = cabecao(['mcp', '--json'], { ...env, CABECAO_BRAIN: join(home, 'não existe') });
    check(
      'mcp com erro não escreve nada no stdout, nem com --json',
      mcpJson.code === 1 && mcpJson.stdout === '',
      mcpJson,
    );
    const dry = cabecao(['consolidate', '--run', '--agent', 'claude-code', '--dry-run', '--brain', brain], env);
    check(
      'consolidate --run --dry-run mostra o comando do agente sem executar nada',
      dry.code === 0 &&
        dry.stdout.includes('--strict-mcp-config') &&
        dry.stdout.includes('--consolidation') &&
        !existsSync(brain),
      dry,
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
