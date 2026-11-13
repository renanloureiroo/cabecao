// Processo filho dos testes de morte súbita. JavaScript puro que importa o TypeScript do núcleo.
//   <cérebro> <máquina> <passo>   roda o sync e se mata com SIGKILL ao chegar no passo
import { writeSync } from 'node:fs';
import { syncBrain } from '../../src/sync/index.ts';

const [dir, machine, step] = process.argv.slice(2);

const result = await syncBrain(dir, {
  machine,
  staleGitLockMs: 2_000,
  faultAt: (current) => {
    if (current !== step) return;
    // escrita síncrona: no Windows e no macOS a escrita num cano pode ficar pendente e se perder com o SIGKILL
    writeSync(1, `morrendo em ${current}\n`);
    process.kill(process.pid, 'SIGKILL');
  },
});
writeSync(1, `RESULTADO ${JSON.stringify(result)}\n`);
