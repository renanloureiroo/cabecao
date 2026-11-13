// Regressão M1 da revisão do marco 1: cópias `.conflict-*` do sync não viram memória vigente nem roubam o `id`.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backlinks,
  brokenLinks,
  getNote,
  indexStatus,
  latestHandoff,
  listNotes,
  PATH_ID_PREFIX,
  scan,
  searchKeyword,
} from '../../src/db/index.ts';
import type { OpenVault } from './helpers.ts';
import { openFixture } from './helpers.ts';

let vault: OpenVault | undefined;
afterEach(async () => {
  await vault?.cleanup();
  vault = undefined;
});

const abs = (root: string, rel: string): string => join(root, ...rel.split('/'));
const STAMP = 'conflict-maq-b-20261112-143210';
const RULE = 'memory/rules/nunca-commitar-segredos.md';
const RULE_ID = '01KQB9YDZ08HD1F6B7GRHFG5N6';
const RULE_COPY = `memory/rules/nunca-commitar-segredos.${STAMP}.md`;
const HANDOFF = 'memory/handoffs/2026-11-10-atlas-consumidores.md';
const HANDOFF_COPY = `memory/handoffs/2026-11-10-atlas-consumidores.${STAMP}.md`;
const FACT = 'memory/facts/fato-atlas-usa-sqs.md';
const FACT_COPY = `memory/facts/fato-atlas-usa-sqs.${STAMP}.md`;

/** Cria a cópia de conflito como o sync cria: mesmo frontmatter (mesmo `id`), texto da outra máquina. */
async function makeCopy(root: string, original: string, copy: string, extra: string): Promise<void> {
  const text = await readFile(abs(root, original), 'utf8');
  await writeFile(abs(root, copy), `${text.trimEnd()}\n\nVersão da outra máquina: ${extra}.\n`);
}

describe('cópias de conflito no banco local', () => {
  it('varredura completa: a cópia (que vem antes na ordem) nunca fica com o id e sai das listagens e da busca', async () => {
    vault = await openFixture('conflict-full');
    const { root, index } = vault;
    await makeCopy(root, RULE, RULE_COPY, 'zumbilandia');
    await makeCopy(root, HANDOFF, HANDOFF_COPY, 'zumbilandia');
    await makeCopy(root, FACT, FACT_COPY, 'zumbilandia');
    const summary = await scan(index, root, vault.config);
    expect(summary.errors.filter((issue) => issue.code === 'duplicate_id')).toEqual([]);

    // `read({ id })` devolve a original; a cópia só pelo caminho, marcada
    expect(getNote(index, { id: RULE_ID })?.path).toBe(RULE);
    const copy = getNote(index, { path: RULE_COPY });
    expect(copy).toMatchObject({ conflictOf: RULE, path: RULE_COPY });
    expect(copy?.id.startsWith(PATH_ID_PREFIX)).toBe(true);
    expect(getNote(index, { path: RULE })?.conflictOf).toBeNull();

    // o que o `recall` usa
    expect(listNotes(index, { types: ['rule'], orderBy: 'path' }).map((n) => n.path)).toEqual([RULE]);
    expect(latestHandoff(index)?.path).toBe(HANDOFF);
    expect(searchKeyword(index, { query: 'zumbilandia' }).hits).toEqual([]);
    expect(searchKeyword(index, { query: 'commitar segredos' }).hits.map((h) => h.path)).not.toContain(RULE_COPY);
    // a pedido, aparecem
    expect(
      listNotes(index, { types: ['rule'], orderBy: 'path', includeConflictCopies: true }).map((n) => n.path),
    ).toEqual([RULE_COPY, RULE]);
    expect(latestHandoff(index, { includeConflictCopies: true })?.path).toBe(HANDOFF_COPY);
    expect(
      searchKeyword(index, { query: 'zumbilandia', includeConflictCopies: true })
        .hits.map((h) => h.path)
        .sort(),
    ).toEqual([FACT_COPY, HANDOFF_COPY, RULE_COPY]);

    // o fato da cópia não duplica o da original; links da cópia não viram backlinks
    const status = indexStatus(index);
    expect(status).toMatchObject({ facts: 4, conflictCopies: 3 });
    expect(status.byType.rule).toBe(1);
    const sqs = getNote(index, { path: 'wiki/entities/SQS.md' });
    expect(sqs).not.toBeNull();
    const incoming = backlinks(index, sqs?.id ?? '').map((b) => b.path);
    expect(incoming).toContain(FACT);
    expect(incoming).not.toContain(FACT_COPY);
    expect(backlinks(index, sqs?.id ?? '', { includeConflictCopies: true }).map((b) => b.path)).toContain(FACT_COPY);
    expect(brokenLinks(index).map((b) => b.path)).not.toContain(HANDOFF_COPY);
  });

  it('varredura incremental: cópia criada depois não pega o id; renomear a cópia sobre a original devolve o id', async () => {
    vault = await openFixture('conflict-incremental');
    const { root, index } = vault;
    await scan(index, root, vault.config);
    // o sync troca a original pela versão remota e põe a local ao lado
    await makeCopy(root, RULE, RULE_COPY, 'versao local');
    const text = await readFile(abs(root, RULE), 'utf8');
    await writeFile(abs(root, RULE), text.replace('pergunte antes', 'pergunte sempre antes'));
    await scan(index, root, vault.config);
    expect(getNote(index, { id: RULE_ID })?.path).toBe(RULE);
    expect(getNote(index, { path: RULE_COPY })?.conflictOf).toBe(RULE);

    // o usuário resolve ficando com a versão da cópia: apaga a original e renomeia a cópia
    await rm(abs(root, RULE));
    await rename(abs(root, RULE_COPY), abs(root, RULE));
    const summary = await scan(index, root, vault.config);
    expect(summary.errors.filter((issue) => issue.code === 'duplicate_id')).toEqual([]);
    const resolved = getNote(index, { id: RULE_ID });
    expect(resolved).toMatchObject({ path: RULE, conflictOf: null });
    expect(getNote(index, { path: RULE_COPY })).toBeNull();
    expect(indexStatus(index).conflictCopies).toBe(0);
    expect(searchKeyword(index, { query: 'versao local' }).hits.map((h) => h.path)).toEqual([RULE]);
  });
});
