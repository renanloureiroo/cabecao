// Teste de ponta a ponta com o bundle já construído (`pnpm build`), como o usuário roda: `node packages/cli/dist/cabecao.mjs`.
//
// Duas "máquinas" (A e B) com pasta do usuário, configuração do Cabeção e configuração do git próprias e temporárias,
// e um remoto bare local vazio. Nada é lido nem escrito em `~/cabecao`, `~/.config/cabecao`, no `~/.gitconfig` ou nos
// arquivos dos clientes de IA desta máquina; nenhum cliente é registrado (`--no-clients`) e nada vai para a rede.
//
// A última parte liga a busca por significado com o embedder FALSO de teste (`CABECAO_TEST_FAKE_EMBEDDER=1`: sem rede,
// sem runtime, sem download; os vetores vão para uma pasta própria da branch de índice) e confere o caminho inteiro:
// escolha do modelo, vetores enviados junto com o conteúdo, a segunda máquina sem calcular nada, a busca híbrida igual
// nas duas, o servidor MCP carregando o modelo só na primeira busca, a compactação e o grafo exportado.
//
// Uso: node scripts/e2e.mjs
//   E2E_SKIP_MCP=1   pula a parte do servidor MCP (o undo passa a conferir só o "nada para desfazer")
//   E2E_KEEP=1       não apaga a pasta temporária no fim (para investigar)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../packages/cli/dist/cabecao.mjs', import.meta.url));
/** Abre um pseudo-terminal de verdade (biblioteca padrão do Python) para os comandos só do usuário no terminal. */
const PTY_DRIVER = fileURLToPath(new URL('../packages/cli/test/pty-driver.py', import.meta.url));
/** Variáveis que fazem a CLI rodar como agente (`packages/cli/src/actor.ts`), mais o `CI`. */
const AGENT_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'AI_AGENT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'GEMINI_CLI',
  'CURSOR_AGENT',
  'OPENCODE',
  'CI',
];
const skipMcp = process.env.E2E_SKIP_MCP === '1';
const STEP_TIMEOUT_MS = 180_000;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failures += 1;
    console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  }
  return ok;
}

if (!existsSync(bin)) {
  console.log(`FAIL o bundle não existe em ${bin}: rode "pnpm build" antes.`);
  process.exit(1);
}

console.log(`node ${process.version} em ${process.platform}/${process.arch}`);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cabeção e2e ')));
const gitconfig = join(root, 'gitconfig');
writeFileSync(
  gitconfig,
  [
    '[user]',
    '\tname = Teste E2E',
    '\temail = e2e@cabecao.invalid',
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
    '[core]',
    '\tautocrlf = false',
    '[init]',
    '\tdefaultBranch = main',
    '[credential]',
    '\thelper = ',
    '',
  ].join('\n'),
);

/** Ambiente de uma máquina: tudo que aponta para a configuração do usuário vai para pastas temporárias. */
function machineEnv(name) {
  const home = join(root, `casa ${name}`);
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CABECAO_CONFIG_DIR: join(root, `config cabecao ${name}`),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const key of [
    'CABECAO_BRAIN',
    'CABECAO_CACHE_DIR',
    'CABECAO_DEBUG',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'COPILOT_HOME',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
  ]) {
    delete env[key];
  }
  return { name, home, env };
}

function git(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: machineEnv('git').env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${result.stderr}`);
  return result.stdout.trim();
}

/** Roda o bundle numa máquina. `input` vai para o stdin (o JSON que o Claude Code manda a um hook). */
function cabecao(machine, args, cwd = machine.home, input = undefined) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: machine.env,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    timeout: STEP_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function json(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    // no pseudo-terminal, stdout e stderr chegam juntos: vale a última linha que é JSON
    for (const line of result.stdout.split('\n').reverse()) {
      try {
        if (line.trim().startsWith('{')) return JSON.parse(line);
      } catch {
        // a linha seguinte
      }
    }
    return null;
  }
}

/**
 * Roda o bundle como o USUÁRIO no terminal: sem as variáveis de agente nem o CI e, no macOS e no Linux, dentro de um
 * pseudo-terminal de verdade (é o terminal controlador que faz a CLI rodar como humano). É assim que `embeddings on` e
 * `compact`, que só o usuário roda, são exercitados. No Windows o processo roda direto: conta como humano se o console
 * do processo puder ser aberto (CONIN$).
 */
function cabecaoHuman(machine, args) {
  const env = { ...machine.env };
  for (const key of AGENT_VARS) delete env[key];
  if (process.platform === 'win32') return cabecao({ ...machine, env }, args);
  const result = spawnSync('python3', [PTY_DRIVER, '<<nenhuma pergunta>>', '', process.execPath, bin, ...args], {
    cwd: machine.home,
    env,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // sem a saída do driver: fica o erro abaixo
  }
  return {
    code: parsed?.code ?? null,
    stdout: (parsed?.output ?? '').replace(/\r\n/g, '\n'),
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function write(dir, rel, content) {
  const path = join(dir, ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(dir, rel) {
  const path = join(dir, ...rel.split('/'));
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Conversa com `cabecao mcp` pela entrada e saída padrão (geração 2025-11-25 do protocolo: `initialize`,
 * `notifications/initialized` e `tools/call`, uma mensagem JSON por linha).
 */
async function mcpSession(machine, calls) {
  const child = spawn(process.execPath, [bin, 'mcp'], {
    cwd: machine.home,
    env: machine.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = [];
  let stderr = '';
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      lines.push(line);
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && message.method === undefined) {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      } catch {
        // conferido abaixo: o stdout tem de ser só JSON-RPC
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  let nextId = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`sem resposta para ${method} em ${STEP_TIMEOUT_MS} ms`)),
        STEP_TIMEOUT_MS,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ id, method, params });
    });

  const results = [];
  const tools = [];
  try {
    const opened = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.0' },
    });
    if (opened.result === undefined) throw new Error(`initialize falhou: ${JSON.stringify(opened.error)}`);
    send({ method: 'notifications/initialized' });
    const listed = await request('tools/list', {});
    tools.push(...(listed.result?.tools ?? []).map((tool) => tool.name));
    for (const [name, args] of calls) {
      const response = await request('tools/call', { name, arguments: args });
      results.push(response.result ?? { isError: true, error: response.error });
    }
  } finally {
    child.stdin.end();
  }
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000))]);
  if (code === 'timeout') child.kill();
  const notJson = lines.filter((line) => {
    try {
      JSON.parse(line);
      return false;
    } catch {
      return true;
    }
  });
  return { results, code, stderr, notJson, tools };
}

/** O executável do git no PATH deste processo (para montar um PATH só com node, git e os falsos do teste). */
function gitDir() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const ext of exts) if (dir !== '' && existsSync(join(dir, `git${ext}`))) return dir;
  }
  throw new Error('git não está no PATH');
}

/**
 * Uma máquina com o PATH restrito a node, git e, se pedido, um "claude" FALSO que só anota os argumentos (nunca o
 * Claude Code de verdade). É a que roda o init sem --no-clients: ele detecta e registra o que achar na pasta temporária.
 */
function restrictedMachine(name, { fakeClaude = false } = {}) {
  const machine = machineEnv(name);
  const fakeBin = join(root, `bin falso ${name}`);
  mkdirSync(fakeBin, { recursive: true });
  const log = join(fakeBin, 'claude.log');
  if (fakeClaude) {
    if (process.platform === 'win32') {
      writeFileSync(join(fakeBin, 'claude.cmd'), `@echo %* >> "${log}"\r\n@exit /b 0\r\n`);
    } else {
      writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`, { mode: 0o755 });
    }
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  const path = [fakeBin, dirname(process.execPath), gitDir()].join(sep);
  return { ...machine, env: { ...machine.env, PATH: path, Path: path }, log };
}

/** O fim do init leva ao primeiro sucesso: "Pronto", o que ficou em cada agente, o teste e os opcionais detectados. */
function initEndPart(remote) {
  const none = restrictedMachine('sem agente');
  const plain = cabecao(none, ['init', remote, '--dir', join(root, 'sem agente', 'cérebro')]);
  check(
    'init sem agente: "Pronto", nenhum agente, o teste e os opcionais (sync automático, busca por significado)',
    plain.code === 0 &&
      plain.stdout.startsWith('Pronto. Seu cérebro está em ') &&
      plain.stdout.includes('Agentes: nenhum encontrado nesta máquina.') &&
      plain.stdout.includes('Teste agora:\n  1. Depois de conectar um agente, peça a ele:') &&
      plain.stdout.includes('cabecao search "respostas curtas"') &&
      /Opcional \(rode quando quiser\):\n {2}cabecao schedule on/.test(plain.stdout) &&
      plain.stdout.includes('cabecao embeddings on'),
    plain,
  );
  const withClaude = restrictedMachine('com claude', { fakeClaude: true });
  mkdirSync(join(withClaude.home, '.claude'), { recursive: true });
  const claude = cabecao(withClaude, ['init', remote, '--dir', join(root, 'com claude', 'cérebro')]);
  const logged = existsSync(withClaude.log) ? readFileSync(withClaude.log, 'utf8') : '';
  check(
    'init com o Claude Code: registra (pelo "claude" falso), manda testar no Claude Code e sugere as skills',
    claude.code === 0 &&
      /Claude Code +servidor MCP registrado/.test(claude.stdout) &&
      claude.stdout.includes('1. No Claude Code, peça: "guarde que eu prefiro respostas curtas, em tópicos"') &&
      /cabecao install-skills +ensina Claude Code a usar o cérebro/.test(claude.stdout) &&
      (process.platform === 'win32' || logged.includes('mcp add-json cabecao')),
    { claude, logged },
  );
  return { none, withClaude };
}

async function main() {
  const remote = join(root, 'remoto.git');
  git(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  const A = machineEnv('A');
  const B = machineEnv('B');
  const dirA = join(root, 'máquina A', 'cérebro');
  const dirB = join(root, 'máquina B', 'cérebro');
  const note = 'wiki/concepts/zebra-lunar.md';

  // 1. Máquina A: init com o remoto vazio.
  const initA = cabecao(A, ['init', remote, '--dir', dirA, '--machine', 'maquina-a', '--no-clients', '--json']);
  const initAJson = json(initA);
  if (
    !check(
      'A: init no remoto vazio cria o cérebro (case created)',
      initA.code === 0 && initAJson?.data?.init?.case === 'created',
      initA,
    )
  ) {
    return;
  }
  check(
    'A: o init montou o índice e rodou o doctor sem falhas',
    typeof initAJson.data.index?.notes === 'number' && initAJson.data.doctor?.summary?.fail === 0,
    initAJson.data,
  );

  // 2. Uma nota escrita como o Obsidian escreveria (arquivo direto na pasta, sem passar pelo Cabeção).
  write(
    dirA,
    note,
    '---\ntype: concept\ntitle: Zebra lunar\ntags: [teste]\n---\nA zebralunar é a palavra de teste do e2e.\n\nLinha de teste: original.\n',
  );
  const syncA1 = cabecao(A, ['sync', '--json']);
  check(
    'A: sync envia a nota (pelo cérebro padrão da máquina)',
    syncA1.code === 0 && json(syncA1)?.data?.status === 'ok' && json(syncA1)?.data?.pushed >= 1,
    syncA1,
  );

  // 3. Máquina B: init com a mesma URL baixa o cérebro.
  const initB = cabecao(B, ['init', remote, '--dir', dirB, '--machine', 'maquina-b', '--no-clients', '--json']);
  if (
    !check(
      'B: init com a mesma URL só baixa (case joined)',
      initB.code === 0 && json(initB)?.data?.init?.case === 'joined',
      initB,
    )
  ) {
    return;
  }
  initEndPart(remote);

  const searchB = cabecao(B, ['search', 'zebralunar', '--json']);
  check(
    'B: search acha a nota escrita em A',
    searchB.code === 0 && json(searchB)?.data?.hits?.[0]?.path === note,
    searchB,
  );
  const searchText = cabecao(B, ['search', 'zebralunar']);
  check(
    'B: search no terminal mostra título, caminho e validade',
    searchText.code === 0 &&
      searchText.stdout.includes('Zebra lunar') &&
      searchText.stdout.includes(note) &&
      searchText.stdout.includes('vigente'),
    searchText,
  );

  // 4. Edição em B chega a A.
  write(dirB, note, `${read(dirB, note)}\nEditado na máquina B.\n`);
  const syncB1 = cabecao(B, ['sync', '--json']);
  check('B: sync envia a edição', syncB1.code === 0 && json(syncB1)?.data?.pushed >= 1, syncB1);
  const syncA2 = cabecao(A, ['sync', '--json']);
  check(
    'A: sync recebe a edição de B',
    syncA2.code === 0 && json(syncA2)?.data?.pulled >= 1 && (read(dirA, note) ?? '').includes('Editado na máquina B.'),
    { syncA2, content: read(dirA, note) },
  );

  // 5. Conflito: a mesma linha editada nas duas máquinas.
  write(dirA, note, (read(dirA, note) ?? '').replace('Linha de teste: original.', 'Linha de teste: versão de A.'));
  write(dirB, note, (read(dirB, note) ?? '').replace('Linha de teste: original.', 'Linha de teste: versão de B.'));
  const syncA3 = cabecao(A, ['sync', '--json']);
  check('A: sync envia a versão de A', syncA3.code === 0 && json(syncA3)?.data?.pushed >= 1, syncA3);
  const syncB2 = cabecao(B, ['sync', '--json']);
  const conflict = json(syncB2)?.data?.conflicts?.[0];
  check(
    'B: sync guarda as duas versões (nota com a do remoto, cópia .conflict- com a de B)',
    syncB2.code === 0 &&
      json(syncB2)?.data?.conflicts?.length === 1 &&
      /\.conflict-maquina-b-\d{8}-\d{6}/.test(conflict?.copy ?? '') &&
      (read(dirB, note) ?? '').includes('versão de A') &&
      (read(dirB, conflict?.copy ?? 'x') ?? '').includes('versão de B'),
    { syncB2, conflict },
  );
  const syncText = cabecao(B, ['sync']);
  check('B: um segundo sync termina com 0', syncText.code === 0 && syncText.stdout.startsWith('Sync: ok.'), syncText);

  // 6. Uma operação do Cabeção, feita por um agente pelo servidor MCP, e o undo dela.
  const created = 'wiki/concepts/via-mcp.md';
  if (skipMcp) {
    console.log('info E2E_SKIP_MCP=1: a parte do servidor MCP foi pulada');
    const nothing = cabecao(B, ['undo', '--json']);
    check(
      'B: undo sem operação do Cabeção sai com 1 e explica',
      nothing.code === 1 && json(nothing)?.error?.code === 'nothing_to_undo',
      nothing,
    );
  } else {
    const session = await mcpSession(B, [
      [
        'write_page',
        {
          path: created,
          mode: 'create',
          frontmatter: { type: 'concept', title: 'Via MCP' },
          content: 'Nota escrita por um agente pelo servidor MCP.',
        },
      ],
      ['sync', {}],
    ]);
    const [written, synced] = session.results;
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../integrations/mcpb/manifest.json', import.meta.url)), 'utf8'),
    );
    check(
      'o servidor do bundle recém-construído lista exatamente as tools do manifesto do .mcpb',
      JSON.stringify([...session.tools].sort()) === JSON.stringify(manifest.tools.map((tool) => tool.name).sort()),
      { tools: session.tools, manifest: manifest.tools.map((tool) => tool.name) },
    );
    check(
      'B: cabecao mcp responde, e write_page grava a nota',
      written?.isError !== true && typeof written?.structuredContent?.op === 'string' && read(dirB, created) !== null,
      session,
    );
    check(
      'B: a tool sync roda "cabecao sync --json" em outro processo e envia',
      synced?.isError !== true && synced?.structuredContent?.status === 'ok' && synced?.structuredContent?.pushed >= 1,
      synced,
    );
    check('B: o stdout do mcp é só JSON-RPC', session.notJson.length === 0, session.notJson);
    check('B: o mcp encerra com 0 quando o cliente fecha a entrada', session.code === 0, session);
    const op = written?.structuredContent?.op;

    const syncA4 = cabecao(A, ['sync', '--json']);
    check('A: recebe a nota escrita pelo agente', syncA4.code === 0 && read(dirA, created) !== null, syncA4);

    const list = cabecao(B, ['undo', '--list']);
    check('B: undo --list mostra a operação do agente', list.code === 0 && list.stdout.includes(String(op)), list);
    const undo = cabecao(B, ['undo', '--json']);
    check(
      'B: undo desfaz a última operação',
      undo.code === 0 && json(undo)?.data?.undone?.[0]?.op === op && read(dirB, created) === null,
      undo,
    );
    const syncB3 = cabecao(B, ['sync', '--json']);
    const syncA5 = cabecao(A, ['sync', '--json']);
    check('A: o undo feito em B chega em A', syncB3.code === 0 && syncA5.code === 0 && read(dirA, created) === null, {
      syncB3,
      syncA5,
    });
  }

  // 7. status e doctor (antes, A recebe tudo o que B enviou, inclusive a cópia de conflito).
  const syncLast = cabecao(A, ['sync', '--json']);
  check('A: sync final termina com 0', syncLast.code === 0 && json(syncLast)?.data?.status === 'ok', syncLast);
  const statusB = cabecao(B, ['status', '--json']);
  const statusBJson = json(statusB);
  check(
    'B: status --json mostra o conflito pendente e o sync em dia',
    statusB.code === 0 &&
      statusBJson?.ok === true &&
      statusBJson.data.conflicts.length === 1 &&
      statusBJson.data.sync.unpushed === 0 &&
      statusBJson.data.notes.total > 0,
    statusB,
  );
  const statusA = cabecao(A, ['status']);
  check(
    'A: status no terminal lista a mesma cópia de conflito (ela viaja pelo sync, como qualquer nota)',
    statusA.code === 0 &&
      statusA.stdout.includes('Conflitos pendentes: 1') &&
      statusA.stdout.includes(`${conflict?.copy} → ${note}`),
    statusA,
  );
  for (const [machine, label] of [
    [A, 'A'],
    [B, 'B'],
  ]) {
    const doctor = cabecao(machine, ['doctor', '--offline']);
    check(
      `${label}: doctor --offline sem falhas (código 0)`,
      doctor.code === 0 && /\d+ ok, \d+ avisos?, 0 falhas\./.test(doctor.stdout),
      doctor,
    );
  }
  const doctorB = cabecao(B, ['doctor', '--offline', '--json']);
  check(
    'B: doctor aponta o conflito como aviso',
    json(doctorB)?.data?.checks?.find((item) => item.id === 'conflicts')?.status === 'warn',
    doctorB,
  );

  await hooksPart(A, B, dirA, dirB);
  await obsidianPart(A, B, dirA, dirB);
  await embeddingsPart(A, B, dirA, dirB, remote);
}

// Marco 5: configuração do Obsidian, painéis e mapa viajam pelo sync; a segunda máquina não tem nada a mudar.
async function obsidianPart(A, B, dirA, dirB) {
  const setupA = cabecao(A, ['obsidian', 'setup', '--json']);
  check(
    'A: obsidian setup cria .obsidian/ e os painéis',
    setupA.code === 0 &&
      existsSync(join(dirA, '.obsidian', 'graph.json')) &&
      existsSync(join(dirA, 'dashboards', 'memorias.base')),
    setupA,
  );
  const canvas = cabecao(A, ['export', 'canvas', '--json']);
  check(
    'A: export canvas grava o mapa em dashboards/',
    canvas.code === 0 && existsSync(join(dirA, 'dashboards', 'mapa.canvas')),
    canvas,
  );
  const syncA = cabecao(A, ['sync', '--json']);
  const syncB = cabecao(B, ['sync', '--json']);
  check(
    'B: recebe a configuração do Obsidian, os painéis e o mapa pelo sync',
    syncA.code === 0 && syncB.code === 0 && existsSync(join(dirB, 'dashboards', 'mapa.canvas')),
    { syncA, syncB },
  );
  const setupB = cabecao(B, ['obsidian', 'setup', '--json']);
  check(
    'B: obsidian setup depois do sync não muda nada',
    setupB.code === 0 && json(setupB)?.data?.files?.every((file) => file.status === 'unchanged') === true,
    setupB,
  );
  // upgrade é só do usuário no terminal: roda como ele, num pseudo-terminal
  const upgrade = cabecaoHuman(B, ['upgrade', '--json']);
  check(
    'B: upgrade sem migração pendente',
    upgrade.code === 0 && json(upgrade)?.data?.status === 'up_to_date',
    upgrade,
  );
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

/** 8. Os hooks do plugin do Claude Code com o bundle de verdade: briefing de início e sync destacado de fim. */
async function hooksPart(A, B, dirA, dirB) {
  const project = join(root, 'projetos', 'atlas');
  mkdirSync(project, { recursive: true });
  const before = performance.now();
  const recall = cabecao(
    A,
    ['recall', '--hook'],
    A.home,
    JSON.stringify({ cwd: project, hook_event_name: 'SessionStart' }),
  );
  const recallMs = Math.round(performance.now() - before);
  const context = json(recall)?.hookSpecificOutput?.additionalContext ?? '';
  check(
    `A: recall --hook devolve o JSON do SessionStart com o briefing (${recallMs} ms)`,
    recall.code === 0 &&
      json(recall)?.hookSpecificOutput?.hookEventName === 'SessionStart' &&
      // o cérebro do e2e não tem notas do projeto "atlas": o escopo cai para todos, e isso também é dito
      /Escopo: .*project:atlas/.test(context) &&
      context.includes('session_handle desta sessão:') &&
      context.length < 10_000,
    recall,
  );
  const noBrain = cabecao(A, ['recall', '--hook', '--brain', join(root, 'não existe')], A.home, '{}');
  check('recall --hook sem cérebro: {} e código 0', noBrain.code === 0 && noBrain.stdout === '{}\n', noBrain);

  write(
    dirA,
    'wiki/concepts/Hook de fim.md',
    '---\ntype: concept\ntitle: Hook de fim\n---\nEditada fora do Cabeção.\n',
  );
  const start = performance.now();
  const detached = cabecao(A, ['sync', '--detach', '--json']);
  const detachMs = Math.round(performance.now() - start);
  const pid = json(detached)?.data?.pid;
  const log = json(detached)?.data?.log;
  check(
    `A: sync --detach volta em menos de 1,5 s (${detachMs} ms) com o PID e o log`,
    detached.code === 0 && typeof pid === 'number' && typeof log === 'string' && detachMs < 1_500,
    detached,
  );
  const finished = await waitFor(
    () => /· sync · código 0 ---\nSync: ok\./.test(read(dirA, '.cabecao/logs/sync.log') ?? ''),
    90_000,
  );
  check(
    'A: o sync destacado termina sozinho e grava o resultado no log',
    finished,
    read(dirA, '.cabecao/logs/sync.log'),
  );
  check(
    'A: o processo do sync destacado não fica rodando',
    typeof pid === 'number' && (await waitFor(() => !alive(pid), 30_000)),
    { pid },
  );
  const syncB = cabecao(B, ['sync', '--json']);
  check(
    'B: recebe a nota que o sync destacado de A enviou',
    syncB.code === 0 && read(dirB, 'wiki/concepts/Hook de fim.md') !== null,
    syncB,
  );
  const hook = cabecao(
    A,
    ['sync', '--hook'],
    A.home,
    JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
  );
  check('A: sync --hook sai com 0 sem escrever em stdout', hook.code === 0 && hook.stdout === '', hook);
  await waitFor(() => (read(dirA, '.cabecao/logs/sync.log') ?? '').split('· sync · código').length >= 3, 90_000);
}

/** A mesma máquina com o embedder falso de teste ligado. */
function withFakeEmbedder(machine) {
  return { ...machine, env: { ...machine.env, CABECAO_TEST_FAKE_EMBEDDER: '1' } };
}

/** 8. Busca por significado, com o embedder falso de teste. */
async function embeddingsPart(plainA, plainB, dirA, dirB, remote) {
  const A = withFakeEmbedder(plainA);
  const B = withFakeEmbedder(plainB);
  write(
    dirA,
    'wiki/decisions/trocar-broker.md',
    '---\ntype: decision\ntitle: Trocar o broker de mensagens\n---\nO time trocou o broker de mensagens para reduzir o custo de operação.\n',
  );
  // sem terminal, como agente, é recusado (só o usuário no terminal); como o usuário, roda
  const refused = cabecao(A, ['embeddings', 'on', 'multilingual-e5-small', '--json']);
  check('A: embeddings on sem terminal (agente) é recusado com código 4', refused.code === 4, refused);
  const on = cabecaoHuman(A, ['embeddings', 'on', 'multilingual-e5-small', '--json']);
  check(
    'A: embeddings on (embedder falso) grava o modelo e calcula os vetores',
    on.code === 0 &&
      json(on)?.data?.chosen_now === true &&
      json(on)?.data?.computed > 0 &&
      json(on)?.data?.pending === 0,
    on,
  );
  const syncA = cabecao(A, ['sync', '--json']);
  check(
    'A: sync envia o conteúdo e os vetores no mesmo envio',
    syncA.code === 0 && json(syncA)?.data?.index?.pushed > 0 && json(syncA)?.data?.pushed >= 1,
    syncA,
  );
  check(
    'o remoto tem a branch de índice',
    git(['for-each-ref', '--format=%(refname)', 'refs/heads/cabecao/'], remote) === 'refs/heads/cabecao/index',
    git(['for-each-ref'], remote),
  );
  // uma máquina nova, sem o runtime de embeddings: o fim do init diz que o cérebro usa busca por significado
  const third = restrictedMachine('terceira');
  const initThird = cabecao(third, ['init', remote, '--dir', join(root, 'terceira', 'cérebro')]);
  check(
    'segunda máquina num cérebro com busca por significado: o opcional diz o modelo e o comando',
    initThird.code === 0 &&
      /cabecao embeddings on +este cérebro usa busca por significado\s+\(multilingual-e5-small\)/.test(
        initThird.stdout,
      ),
    initThird,
  );

  const syncB = cabecao(B, ['sync', '--json']);
  const indexB = json(syncB)?.data?.index;
  check(
    'B: sync recebe os vetores e não calcula nenhum',
    syncB.code === 0 && indexB?.received > 0 && indexB?.computed === 0 && indexB?.pending === 0,
    syncB,
  );
  const question = 'por que trocamos o broker de mensagens?';
  const searchA = json(cabecao(A, ['search', question, '--json']));
  const searchB = json(cabecao(B, ['search', question, '--json']));
  const paths = (out) => (out?.data?.hits ?? []).map((hit) => hit.path).join(',');
  check(
    'A e B: busca híbrida com o mesmo resultado',
    searchA?.data?.mode_used === 'hybrid' &&
      searchB?.data?.mode_used === 'hybrid' &&
      paths(searchA) === paths(searchB) &&
      paths(searchA) !== '',
    { searchA: searchA?.data, searchB: searchB?.data },
  );
  const keywordB = json(cabecao(B, ['search', question, '--mode', 'keyword', '--json']));
  check('B: --mode keyword usa só a palavra-chave', keywordB?.data?.mode_used === 'keyword', keywordB);
  const offB = json(cabecao(plainB, ['search', question, '--json']));
  check(
    'B sem o embedder de teste: a busca cai para palavra-chave e diz por quê (o runtime não está instalado)',
    offB?.data?.mode_used === 'keyword' && /runtime/.test(offB?.data?.mode_reason ?? ''),
    offB,
  );

  if (!skipMcp) {
    const session = await mcpSession(B, [
      ['status', {}],
      ['search', { query: question }],
      ['status', {}],
    ]);
    const [before, searched, after] = session.results;
    check(
      'B: o servidor MCP sobe sem carregar o modelo e carrega na primeira busca',
      before?.structuredContent?.embeddings?.loaded === false &&
        searched?.structuredContent?.mode_used === 'hybrid' &&
        after?.structuredContent?.embeddings?.loaded === true,
      session,
    );
    check('B: o stdout do mcp continua só JSON-RPC', session.notJson.length === 0, session.notJson);
  }

  const doctorA = cabecao(A, ['doctor', '--offline', '--json']);
  check(
    'A: doctor mostra os embeddings (aviso do embedder falso) e nenhum trecho sem vetor',
    doctorA.code === 0 &&
      json(doctorA)?.data?.checks?.find((item) => item.id === 'embeddings')?.status === 'warn' &&
      json(doctorA)?.data?.checks?.find((item) => item.id === 'embeddings-pending')?.status === 'ok',
    doctorA,
  );
  const compact = cabecaoHuman(A, ['compact', '--json']);
  check(
    'A: compact abre a geração 1 e a envia',
    compact.code === 0 &&
      json(compact)?.data?.compact?.generation?.to === 1 &&
      json(compact)?.data?.after_sync === 'ok',
    compact,
  );
  const syncB2 = cabecao(B, ['sync', '--json']);
  check(
    'B: sync migra para a geração 1 sem calcular nada',
    syncB2.code === 0 && json(syncB2)?.data?.index?.generation === 1 && json(syncB2)?.data?.index?.computed === 0,
    syncB2,
  );
  const graphOf = (dir) =>
    git(['show', 'refs/heads/cabecao/index-1:graph/nodes.jsonl'], dir) +
    git(['show', 'refs/heads/cabecao/index-1:graph/edges.jsonl'], dir);
  check(
    'A e B: o grafo exportado é idêntico byte a byte',
    graphOf(dirA) === graphOf(dirB) && graphOf(dirA).length > 0,
    {},
  );
}

try {
  await main();
} catch (error) {
  check('o e2e rodou até o fim', false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  if (process.env.E2E_KEEP === '1') console.log(`info pasta mantida: ${root}`);
  else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures === 0 ? 'e2e: tudo certo' : `e2e: ${failures} conferência(s) falharam`);
process.exit(failures === 0 ? 0 : 1);
