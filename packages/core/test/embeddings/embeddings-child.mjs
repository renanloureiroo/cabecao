// Processo filho dos testes de morte súbita do índice. JavaScript puro que importa o TypeScript do núcleo.
//   embeddings-child.mjs <cérebro> <compute|sync> <passo|nenhum> <trechos por rodada>
// Abre o cérebro com o embedder falso, roda o cálculo ou o sync e se mata com SIGKILL ao chegar no passo
// (`round-appended` do cálculo, ou um passo do sync, como `pushed`).
import { writeSync } from 'node:fs';
import { createFakeEmbedder } from '../../../embeddings/src/fake.ts';
import { openBrain } from '../../src/brain/index.ts';
import { resolveFromConfig } from '../../src/embeddings/index.ts';

const [dir, action, step, round] = process.argv.slice(2);
let passages = 0;
const provider = {
  resolve: (config) => resolveFromConfig(config),
  available: async () => ({ ok: true, backend: 'fake', modelCached: true }),
  load: async (config) => {
    const inner = createFakeEmbedder(config.dims, { model: config.model });
    return {
      dims: inner.dims,
      backend: 'fake',
      embed: async (texts, kind) => {
        if (kind === 'passage') passages += texts.length;
        return inner.embed(texts, kind);
      },
      dispose: () => inner.dispose(),
    };
  },
};
const die = (current) => {
  if (current !== step) return;
  // escrita síncrona: no Windows e no macOS a escrita num cano pode ficar pendente e se perder com o SIGKILL
  writeSync(1, `morrendo em ${current} depois de ${passages} trechos\n`);
  process.kill(process.pid, 'SIGKILL');
};
const brain = await openBrain(dir, {
  client: 'cli',
  actor: 'human',
  machine: 'filho',
  embeddings: provider,
  embedRoundSize: Number(round),
  embeddingsFaultAt: die,
  syncFaultAt: die,
});
try {
  const result = action === 'sync' ? await brain.sync() : await brain.computeEmbeddings();
  writeSync(1, `RESULTADO ${JSON.stringify({ passages, result })}\n`);
} finally {
  await brain.close();
}
