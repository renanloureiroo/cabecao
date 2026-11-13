// Processo filho do teste de escritas simultâneas entre processos. JavaScript puro que importa o TypeScript do núcleo.
//   brain-child.mjs <cérebro> <rótulo> <quantas>   grava <quantas> memórias ao mesmo tempo e imprime as operações
import { writeSync } from 'node:fs';
import { openBrain } from '../../src/brain/index.ts';

const [dir, label, count] = process.argv.slice(2);
const brain = await openBrain(dir, { client: 'teste', machine: label });
try {
  const results = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      brain.remember({ type: 'gotcha', title: `Armadilha ${label} ${i}`, content: `Conteúdo ${label} ${i}.\n` }),
    ),
  );
  writeSync(
    1,
    `RESULTADO ${JSON.stringify(results.map((result) => ({ op: result.op, path: result.path, commit: result.commit })))}\n`,
  );
} finally {
  await brain.close();
}
