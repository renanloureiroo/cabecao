// Processo filho do teste de concorrência: abre o banco do cérebro, varre e escreve o resumo em JSON.
//   scan-child.mjs <raiz do cérebro>
import { openIndex, scan } from '../../src/db/index.ts';
import { readBrainConfig } from '../../src/vault/index.ts';

const root = process.argv[2];
const config = await readBrainConfig(root);
const index = await openIndex(root);
try {
  const summary = await scan(index, root, config);
  process.stdout.write(`${JSON.stringify({ ...summary, errors: summary.errors.length, rebuilt: index.rebuilt })}\n`);
} finally {
  index.close();
}
