// Processo filho dos testes do índice. JavaScript puro que importa o TypeScript do núcleo.
//   <cérebro> append <prefixo> <quantos> [passo]   acrescenta registros; com passo, morre (SIGKILL) ao chegar nele
//   <cérebro> compact - - [passo]                   compacta (sem liveKeys)
//   <cérebro> merge - - [passo]                     integra com origin
//   <cérebro> loop <prefixo> <rodadas>              acrescenta em laço até ser morto de fora
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { compactIndex, mergeRemoteIndex, openIndexStore } from '../../src/indexstore/index.ts';

const [dir, op, prefix, amount, step] = process.argv.slice(2);
const DIMS = 16;

function records(label, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const hash = createHash('sha256').update(`${label}:${i}`).digest();
    const vector = new Int8Array(DIMS);
    for (let d = 0; d < DIMS; d++) vector[d] = (hash[d % 32] ?? 0) - 128;
    out.push({ key: hash.toString('hex', 0, 16), scale: 0.5, vector });
  }
  return out;
}

const faultAt = (current) => {
  if (current !== step) return;
  // escrita síncrona: num cano, a escrita assíncrona pode se perder com o SIGKILL
  writeSync(1, `morrendo em ${current}\n`);
  process.kill(process.pid, 'SIGKILL');
};
const options = { faultAt, staleGitLockMs: 2_000 };

if (op === 'append') {
  const store = await openIndexStore(dir, 'teste-q8-r1', { ...options, dims: DIMS });
  const result = await store.appendRecords(records(prefix, Number(amount)));
  writeSync(1, `RESULTADO ${JSON.stringify(result)}\n`);
} else if (op === 'compact') {
  const result = await compactIndex(dir, options);
  writeSync(1, `RESULTADO ${JSON.stringify(result?.generation ?? null)}\n`);
} else if (op === 'merge') {
  const result = await mergeRemoteIndex(dir, 'origin', options);
  writeSync(1, `RESULTADO ${JSON.stringify(result.outcome)}\n`);
} else if (op === 'loop') {
  const store = await openIndexStore(dir, 'teste-q8-r1', { dims: DIMS, staleGitLockMs: 2_000 });
  for (let round = 0; round < Number(amount); round++) {
    await store.appendRecords(records(`${prefix}-${round}`, 20));
    writeSync(1, `rodada ${round}\n`);
  }
}
