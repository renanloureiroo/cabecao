// Escala moderada gerada na hora: 2 mil notas. Os limites de tempo são folgados (runners do Windows são ~3x mais
// lentos); os tempos medidos vão para o log do teste.
import { rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalIndex } from '../../src/db/index.ts';
import { indexStatus, openIndex, scan, searchKeyword } from '../../src/db/index.ts';
import type { BrainConfig } from '../../src/vault/index.ts';
import { readBrainConfig } from '../../src/vault/index.ts';
import type { TempVault } from '../vault/helpers.ts';
import { makeTempDir } from '../vault/helpers.ts';
import { generateVault } from './helpers.ts';

const NOTES = 2000;
let temp: TempVault;
let index: LocalIndex;
let config: BrainConfig;
let paths: string[];

beforeAll(async () => {
  temp = await makeTempDir('db-scale');
  paths = await generateVault(temp.root, NOTES);
  config = await readBrainConfig(temp.root);
  index = await openIndex(temp.root);
}, 120_000);
afterAll(async () => {
  index?.close();
  await temp?.cleanup();
});

const abs = (rel: string): string => join(temp.root, ...rel.split('/'));

describe(`scan com ${NOTES} notas`, () => {
  it('do zero, nada mudou, e mudanças pequenas', async () => {
    const first = await scan(index, temp.root, config);
    expect(first).toMatchObject({ added: NOTES, filesRead: NOTES, total: NOTES, errors: [] });

    const idle = await scan(index, temp.root, config);
    expect(idle).toMatchObject({ added: 0, updated: 0, removed: 0, renamed: 0, unchanged: NOTES, filesRead: 0 });

    // 10 editadas, 5 renomeadas, 5 apagadas, 5 com data nova e conteúdo igual
    for (const [i, path] of paths.slice(0, 10).entries()) {
      const id = `01KEDT${String(i).padStart(20, '0')}`;
      await writeFile(
        abs(path),
        `---\nid: ${id}\ntype: concept\ntitle: Editada\n---\n# Editada\n\nTexto com jabuticaba.\n`,
      );
    }
    for (const path of paths.slice(10, 15)) await rename(abs(path), abs(path.replace('.md', '-renomeada.md')));
    for (const path of paths.slice(15, 20)) await rm(abs(path));
    const later = new Date(Date.now() + 60_000);
    for (const path of paths.slice(20, 25)) await utimes(abs(path), later, later);
    const changed = await scan(index, temp.root, config);
    expect(changed).toMatchObject({ added: 0, updated: 10, renamed: 5, removed: 5, filesRead: 20, total: NOTES - 5 });

    const status = indexStatus(index);
    expect(status.notes).toBe(NOTES - 5);
    expect(searchKeyword(index, { query: 'jabuticaba', limit: 50 }).hits).toHaveLength(10);
    const t0 = performance.now();
    const common = searchKeyword(index, { query: 'arquitetura fila consumidor', limit: 10 });
    const searchMs = performance.now() - t0;
    expect(common.hits.length).toBe(10);

    console.log(
      `[escala ${NOTES} notas, Node ${process.version}, ${process.platform}] do zero: ${first.ms} ms; ` +
        `nada mudou: ${idle.ms} ms; 25 mudanças: ${changed.ms} ms; busca comum: ${searchMs.toFixed(1)} ms; ` +
        `${status.chunks} trechos, ${status.edges} arestas`,
    );
    expect(first.ms).toBeLessThan(60_000);
    expect(idle.ms).toBeLessThan(10_000);
    expect(changed.ms).toBeLessThan(10_000);
  }, 180_000);
});
