import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, LockTimeoutError, withLock } from '../../src/util/index.ts';
import { deadPid, makeTempDir, runChild, spawnChild, waitChild, waitForOutput } from './helpers.ts';

let dir: string;
let lockPath: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir('lock'));
  lockPath = join(dir, 'locks', 'git.lock');
});
afterEach(async () => {
  await cleanup();
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function ageFile(path: string, ms: number): Promise<void> {
  const past = new Date(Date.now() - ms);
  await utimes(path, past, past);
}

describe('acquireLock', () => {
  it('cria a pasta e o arquivo com PID, máquina e instante, e apaga ao soltar', async () => {
    const before = Date.now();
    const lock = await acquireLock(lockPath);
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
    expect(owner.at).toBeGreaterThanOrEqual(before);
    expect(owner.at).toBeLessThanOrEqual(Date.now());
    await lock.release();
    expect(await exists(lockPath)).toBe(false);
    await lock.release(); // soltar de novo não faz nada
  });

  it('quem chega depois espera e desiste no prazo', async () => {
    const lock = await acquireLock(lockPath);
    const started = Date.now();
    const error = await acquireLock(lockPath, { timeoutMs: 150 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LockTimeoutError);
    expect(error).toMatchObject({ code: 'ELOCKTIMEOUT', path: lockPath, owner: { pid: process.pid } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    await expect(acquireLock(lockPath, { timeoutMs: 0 })).rejects.toThrow(LockTimeoutError);
    await lock.release();
  });

  it('quem espera entra assim que a trava é solta', async () => {
    const first = await acquireLock(lockPath);
    const order: string[] = [];
    const second = acquireLock(lockPath, { timeoutMs: 10_000 }).then((lock) => {
      order.push('segundo entrou');
      return lock;
    });
    await sleep(100);
    order.push('primeiro soltou');
    await first.release();
    await (await second).release();
    expect(order).toEqual(['primeiro soltou', 'segundo entrou']);
  });

  it('soltar não apaga a trava de outro dono', async () => {
    const lock = await acquireLock(lockPath);
    const other = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token: 'de-outro' });
    await writeFile(lockPath, other);
    await lock.release();
    expect(await readFile(lockPath, 'utf8')).toBe(other);
  });

  it('toma a trava de um processo que não existe mais nesta máquina', async () => {
    const child = spawnChild('lock-child.mjs', ['hold', lockPath]);
    const done = waitChild(child);
    await waitForOutput(child, 'locked');
    const deadPid = child.pid as number;
    child.kill('SIGKILL');
    await done;

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: deadPid });
    // Trava nova (longe de staleMs): só é tomada porque o dono morreu.
    const lock = await acquireLock(lockPath, { timeoutMs: 5_000, staleMs: 3_600_000 });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
    expect(await readdir(join(dir, 'locks'))).toEqual([]);
  }, 30_000);

  it('prazo vencido durante o roubo: ainda toma, na mesma chamada, a trava de um morto', async () => {
    // `timeoutMs: 0` é o caso extremo de "o prazo acabou enquanto a trava morta era removida" (sob carga, os 250 ms
    // do sync acabavam já na primeira tentativa). Antes, a chamada desistia com o caminho livre: "ocupado" falso.
    await acquireLock(lockPath).then((lock) => lock.release()); // só para criar a pasta
    const pid = await deadPid();
    await writeFile(lockPath, JSON.stringify({ pid, host: hostname(), at: Date.now(), token: 'morto' }));
    const lock = await acquireLock(lockPath, { timeoutMs: 0, staleMs: 3_600_000 });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
    expect(await readdir(join(dir, 'locks'))).toEqual([]);

    // a tolerância depois do prazo vale só para trava livre: dono vivo continua sendo esperado só até o prazo
    const held = await acquireLock(lockPath);
    const error = await acquireLock(lockPath, { timeoutMs: 0, staleMs: 3_600_000 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ELOCKTIMEOUT', owner: { pid: process.pid } });
    await held.release();
  });

  it('não toma a trava nova de outra máquina, mas toma a que passou de staleMs', async () => {
    const foreign = JSON.stringify({ pid: 1, host: 'outra-maquina.exemplo', at: Date.now(), token: 'x' });
    await acquireLock(lockPath).then((lock) => lock.release()); // só para criar a pasta
    await writeFile(lockPath, foreign);
    await expect(acquireLock(lockPath, { timeoutMs: 100, staleMs: 60_000 })).rejects.toThrow(LockTimeoutError);
    expect(await readFile(lockPath, 'utf8')).toBe(foreign);

    await ageFile(lockPath, 120_000);
    const lock = await acquireLock(lockPath, { timeoutMs: 5_000, staleMs: 60_000 });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it('trava ilegível só é tomada depois de envelhecer', async () => {
    await acquireLock(lockPath).then((lock) => lock.release());
    await writeFile(lockPath, '');
    await expect(acquireLock(lockPath, { timeoutMs: 100 })).rejects.toThrow(LockTimeoutError);
    await ageFile(lockPath, 10_000);
    const lock = await acquireLock(lockPath, { timeoutMs: 5_000 });
    await lock.release();
    expect(await exists(lockPath)).toBe(false);
  });

  it('um mutex de roubo abandonado não impede tomar a trava morta', async () => {
    await acquireLock(lockPath).then((lock) => lock.release());
    await writeFile(lockPath, JSON.stringify({ pid: 1, host: 'outra-maquina', at: 0, token: 'x' }));
    await ageFile(lockPath, 120_000);
    await writeFile(`${lockPath}.steal`, '');
    await ageFile(`${lockPath}.steal`, 60_000);
    const lock = await acquireLock(lockPath, { timeoutMs: 5_000, staleMs: 60_000 });
    await lock.release();
    expect(await readdir(join(dir, 'locks'))).toEqual([]);
  });

  it('quem segura a trava a renova: operação mais longa que staleMs não é roubada', async () => {
    const staleMs = 2_000;
    const lock = await acquireLock(lockPath, { staleMs });
    await ageFile(lockPath, 1_000);
    const aged = (await stat(lockPath)).mtimeMs;
    // Espera mais que staleMs disputando a trava: só não a toma porque o dono a renovou no caminho.
    await expect(acquireLock(lockPath, { timeoutMs: 3_000, staleMs })).rejects.toThrow(LockTimeoutError);
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(aged);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
  }, 20_000);
});

describe('withLock', () => {
  it('devolve o resultado e solta a trava', async () => {
    const result = await withLock(lockPath, async () => {
      expect(await exists(lockPath)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(await exists(lockPath)).toBe(false);
  });

  it('solta a trava mesmo quando a função lança', async () => {
    await expect(
      withLock(lockPath, () => {
        throw new Error('falhou');
      }),
    ).rejects.toThrow('falhou');
    expect(await exists(lockPath)).toBe(false);
  });

  it('serializa chamadas no mesmo processo', async () => {
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLock(lockPath, async () => {
          maxInside = Math.max(maxInside, ++inside);
          await sleep(5);
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });

  it('processos disputando a trava: nenhum incremento do contador se perde', async () => {
    const counter = join(dir, 'contador.txt');
    await writeFile(counter, '0');
    const processes = 6;
    const times = 25;
    const results = await Promise.all(
      Array.from({ length: processes }, () =>
        runChild('lock-child.mjs', ['counter', lockPath, counter, String(times)]),
      ),
    );
    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(Number(await readFile(counter, 'utf8'))).toBe(processes * times);
    expect((await readdir(dir)).sort()).toEqual(['contador.txt', 'locks']);
    expect(await readdir(join(dir, 'locks'))).toEqual([]);
  }, 120_000);
});
