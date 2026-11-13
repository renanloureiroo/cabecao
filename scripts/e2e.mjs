// Teste de ponta a ponta com o bundle já construído (`pnpm build`), como o usuário roda: `node packages/cli/dist/cabecao.mjs`.
//
// Duas "máquinas" (A e B) com pasta do usuário, configuração do Cabeção e configuração do git próprias e temporárias,
// e um remoto bare local vazio. Nada é lido nem escrito em `~/cabecao`, `~/.config/cabecao`, no `~/.gitconfig` ou nos
// arquivos dos clientes de IA desta máquina; nenhum cliente é registrado (`--no-clients`) e nada vai para a rede.
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

/** Roda o bundle numa máquina. */
function cabecao(machine, args, cwd = machine.home) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: machine.env,
    encoding: 'utf8',
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
    return null;
  }
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
  try {
    const opened = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.0' },
    });
    if (opened.result === undefined) throw new Error(`initialize falhou: ${JSON.stringify(opened.error)}`);
    send({ method: 'notifications/initialized' });
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
  return { results, code, stderr, notJson };
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
