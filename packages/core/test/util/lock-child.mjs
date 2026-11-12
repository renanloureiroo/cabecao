// Processo filho dos testes de trava. JavaScript puro para rodar em qualquer Node aceito.
//   counter <trava> <contador> <vezes>   incrementa o contador em arquivo, uma vez por aquisição da trava
//   hold <trava>                          adquire a trava, avisa e fica parado até ser morto
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock, withLock } from '../../src/util/index.ts';

const [mode, lockPath, ...rest] = process.argv.slice(2);

if (mode === 'counter') {
  const [counterPath, times] = rest;
  const insidePath = `${counterPath}.inside`;
  for (let i = 0; i < Number(times); i++) {
    await withLock(
      lockPath,
      async () => {
        // Só um processo por vez pode estar aqui: a criação exclusiva falha se outro também entrou.
        await writeFile(insidePath, String(process.pid), { flag: 'wx' });
        const value = Number(await readFile(counterPath, 'utf8'));
        // Ler, esperar e gravar: sem exclusão mútua, incrementos se perderiam.
        await sleep(1);
        await writeFile(counterPath, String(value + 1));
        await unlink(insidePath);
      },
      { timeoutMs: 60_000 },
    );
  }
} else if (mode === 'hold') {
  await acquireLock(lockPath, { timeoutMs: 10_000 });
  process.stdout.write('locked\n');
  // Mantém o processo vivo até o teste matá-lo; o limite evita filho perdido se o teste falhar antes.
  await sleep(60_000);
  process.exit(3);
} else {
  process.stderr.write(`modo desconhecido: ${mode}\n`);
  process.exit(2);
}
