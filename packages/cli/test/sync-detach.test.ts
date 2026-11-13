// `cabecao sync --detach`, `--hook` e `--log`: o sync em segundo plano do fim de sessão do Claude Code. O filho é
// destacado de verdade (sobrevive a quem o iniciou e termina sozinho); os testes usam um "cabecao" falso que só espera
// e grava no log, e conferem com prazo que nenhum processo fica para trás.
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detachedSyncCommand, startDetachedSync, syncLogPath } from '../src/background.ts';
import { brainRepo, disposeSandbox, freshDir, machine, parseJson, TEST_TIMEOUT_MS } from './helpers.ts';

let brain: string;
let m: ReturnType<typeof machine>;
const started: number[] = [];

/** "cabecao" falso: espera, grava uma linha no log do cérebro (o argumento depois de --brain) e sai. */
function fakeBin(delayMs: number): string {
  const path = join(freshDir('bin falso'), 'cabecao-falso.mjs');
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const root = process.argv[process.argv.indexOf('--brain') + 1];",
      `setTimeout(() => {`,
      "  appendFileSync(join(root, '.cabecao', 'logs', 'sync.log'), `sync falso terminou pid=${process.pid} args=${process.argv.slice(2).join(' ')}\\n`);",
      `}, ${delayMs});`,
      '',
    ].join('\n'),
  );
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

async function readLog(root: string): Promise<string> {
  try {
    return await readFile(syncLogPath(root), 'utf8');
  } catch {
    return '';
  }
}

beforeEach(async () => {
  brain = await brainRepo();
  m = machine();
});

afterEach(async () => {
  // nada fica rodando depois do teste: espera o filho terminar e, no último caso, encerra
  for (const pid of started.splice(0)) {
    if (!(await waitFor(() => !alive(pid), 10_000))) process.kill(pid);
  }
});

afterAll(() => {
  disposeSandbox();
});

describe('sync em segundo plano', { timeout: TEST_TIMEOUT_MS }, () => {
  it('o filho é destacado, sem shell, sem stdin e stdout ligados ao pai, sem janela no Windows', () => {
    const command = detachedSyncCommand(
      { execPath: '/usr/bin/node', binPath: '/opt/cabecao/dist/cabecao.mjs', env: { PATH: '/bin' } },
      '/cérebro com espaço',
      7,
    );
    expect(command.file).toBe('/usr/bin/node');
    expect(command.args).toEqual(['/opt/cabecao/dist/cabecao.mjs', 'sync', '--log', '--brain', '/cérebro com espaço']);
    expect(command.options).toMatchObject({
      detached: true,
      stdio: ['ignore', 'ignore', 7],
      windowsHide: true,
      cwd: '/cérebro com espaço',
      env: { PATH: '/bin' },
    });
    expect(command.options.shell).toBeUndefined();
    expect(() => detachedSyncCommand({ execPath: 'node', binPath: undefined, env: {} }, '/c', 1)).toThrow(
      /não sei onde está o programa cabecao/,
    );
  });

  it('volta em muito menos de 1,5 s, e o filho continua vivo, termina sozinho e grava no log', async () => {
    const bin = fakeBin(1_500);
    const before = Date.now();
    const result = await startDetachedSync(
      { execPath: process.execPath, binPath: bin, env: { ...process.env } },
      brain,
      'teste',
    );
    const elapsed = Date.now() - before;
    started.push(result.pid);
    expect(elapsed).toBeLessThan(1_500);
    expect(result.log).toBe(syncLogPath(brain));
    // o pai já voltou; o filho ainda está esperando
    expect(alive(result.pid)).toBe(true);
    expect(await readLog(brain)).toMatch(/=== .* · sync em segundo plano \(teste\) ===/);
    expect(await waitFor(async () => (await readLog(brain)).includes('sync falso terminou'), 20_000)).toBe(true);
    expect(await readLog(brain)).toContain(`pid=${result.pid} args=sync --log --brain ${brain}`);
    expect(await waitFor(() => !alive(result.pid), 10_000)).toBe(true);
  });

  it('cabecao sync --detach: código 0, o PID e o log; --json traz os mesmos campos', async () => {
    const bin = fakeBin(100);
    const result = await m.cabecao(['sync', '--detach', '--brain', brain, '--json'], { binPath: bin });
    expect(result.code).toBe(0);
    const json = parseJson(result);
    expect(json.data).toMatchObject({ status: 'started', log: syncLogPath(brain) });
    started.push(json.data.pid);
    expect(await waitFor(async () => (await readLog(brain)).includes('sync falso terminou'), 20_000)).toBe(true);
    const text = await m.cabecao(['sync', '--detach', '--brain', brain], { binPath: bin });
    expect(text.stdout).toMatch(/Sync disparado em segundo plano \(processo (\d+)\)/);
    started.push(Number(/processo (\d+)/.exec(text.stdout)?.[1]));
  });

  it('--hook nunca falha: sem cérebro ou com uma pasta que não é cérebro, sai com 0 e não cria nada', async () => {
    const none = await m.cabecao(['sync', '--hook'], { binPath: fakeBin(0), readStdin: async () => '{"reason":"other"}' });
    expect(none).toMatchObject({ code: 0, stdout: '' });
    expect(none.stderr).toContain('cabecao sync --hook: nenhum cérebro configurado');

    const plain = freshDir('pasta comum');
    const notBrain = await m.cabecao(['sync', '--hook', '--brain', plain], { binPath: fakeBin(0) });
    expect(notBrain.code).toBe(0);
    expect(notBrain.stderr).toContain('não é um cérebro');
    await expect(stat(join(plain, '.cabecao'))).rejects.toThrow();

    // sem --hook, o mesmo problema é erro
    expect((await m.cabecao(['sync', '--detach', '--brain', plain], { binPath: fakeBin(0) })).code).toBe(1);
  });

  it('--hook grava de onde veio o disparo e volta sem escrever nada em stdout', async () => {
    const result = await m.cabecao(['sync', '--hook', '--brain', brain], {
      binPath: fakeBin(50),
      readStdin: async () => JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
    });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await readLog(brain)).toContain('hook SessionEnd do Claude Code, motivo prompt_input_exit');
    expect(await waitFor(async () => (await readLog(brain)).includes('sync falso terminou'), 20_000)).toBe(true);
    const pid = Number(/pid=(\d+)/.exec(await readLog(brain))?.[1]);
    started.push(pid);
  });

  it('--log acrescenta o resultado ao log; outro sync em andamento sai como "busy", com código 0', async () => {
    const ok = await m.cabecao(['sync', '--log', '--brain', brain]);
    expect(ok.code).toBe(0);
    const log = await readLog(brain);
    expect(log).toMatch(/--- \S+ → \S+ · sync · código 0 ---\nSync: ok\./);

    await mkdir(join(brain, '.cabecao', 'locks'), { recursive: true });
    writeFileSync(
      join(brain, '.cabecao', 'locks', 'sync.lock'),
      JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token: 'outro' }),
    );
    const busy = await m.cabecao(['sync', '--log', '--brain', brain]);
    expect(busy.code).toBe(0);
    expect(busy.stdout).toContain('Sync: outro sync em andamento.');
    expect(await readLog(brain)).toContain('Sync: outro sync em andamento.');
  });

  it('opções que não combinam com --detach são erro de uso', async () => {
    expect((await m.cabecao(['sync', '--detach', '--log', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['sync', '--detach', '--session', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--brain', brain])).code).toBe(
      2,
    );
  });
});
