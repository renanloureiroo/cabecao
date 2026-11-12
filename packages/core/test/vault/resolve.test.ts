import { describe, expect, it } from 'vitest';
import { buildLinkIndex, findAmbiguousNames, listNoteFiles, readNote, resolveWikiLink } from '../../src/vault/index.ts';
import { FIXTURE_VAULT } from './helpers.ts';

const config = { noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' } as const;

describe('resolveWikiLink no cérebro de exemplo', () => {
  it('resolve todos os links do corpo e do frontmatter; só [[Kafka]] fica sem destino', async () => {
    const files = await listNoteFiles(FIXTURE_VAULT, config);
    const index = buildLinkIndex(files);
    expect(index.size).toBe(files.length);
    const unresolved: string[] = [];
    for (const file of files) {
      const { note } = await readNote(FIXTURE_VAULT, file.diskPath);
      for (const link of [...note.links, ...note.frontmatterLinks]) {
        const resolution = resolveWikiLink(index, link.target, file.path);
        expect(resolution.ambiguous, `${file.path} → ${link.target}`).toBe(false);
        if (resolution.path === null) unresolved.push(link.target);
      }
    }
    expect(unresolved).toEqual(['Kafka']);
    expect(findAmbiguousNames(index)).toEqual([]);
  });

  it('por nome, sem diferenciar maiúsculas, com .md e em NFC', async () => {
    const index = buildLinkIndex(await listNoteFiles(FIXTURE_VAULT, config));
    expect(resolveWikiLink(index, 'projeto atlas').path).toBe('wiki/entities/Projeto Atlas.md');
    expect(resolveWikiLink(index, 'PROJETO ATLAS.md').path).toBe('wiki/entities/Projeto Atlas.md');
    expect(resolveWikiLink(index, 'Idempotência'.normalize('NFD')).path).toBe('wiki/concepts/Idempotência.md');
    expect(resolveWikiLink(index, '  SQS  ').path).toBe('wiki/entities/SQS.md');
  });

  it('por caminho completo ou pelo fim do caminho, com / ou \\', async () => {
    const index = buildLinkIndex(await listNoteFiles(FIXTURE_VAULT, config));
    expect(resolveWikiLink(index, 'raw/meetings/2026-05-03-arquitetura').path).toBe(
      'raw/meetings/2026-05-03-arquitetura.md',
    );
    expect(resolveWikiLink(index, 'entities/Ana Prado').path).toBe('wiki/entities/Ana Prado.md');
    expect(resolveWikiLink(index, 'wiki\\entities\\ana prado').path).toBe('wiki/entities/Ana Prado.md');
    expect(resolveWikiLink(index, '/wiki/entities/SQS').path).toBe('wiki/entities/SQS.md');
    // o fim do caminho tem de casar com pastas inteiras
    expect(resolveWikiLink(index, 'ities/Ana Prado').path).toBeNull();
    expect(resolveWikiLink(index, 'concepts/Ana Prado').path).toBeNull();
  });

  it('alvo vazio ([[#Seção]]) é a própria nota', () => {
    const index = buildLinkIndex(['wiki/a.md']);
    expect(resolveWikiLink(index, '', 'wiki/a.md')).toEqual({
      path: 'wiki/a.md',
      ambiguous: false,
      candidates: ['wiki/a.md'],
    });
    expect(resolveWikiLink(index, '').path).toBeNull();
  });
});

describe('ambiguidade', () => {
  const paths = [
    'wiki/concepts/Nota.md',
    'wiki/entities/Nota.md',
    'memory/_archive/nota.md',
    'wiki/Nota.md',
    'wiki/deep/a/b/Nota.md',
  ];

  it('é resolvida de forma determinística e reportada, qualquer que seja a ordem da listagem', () => {
    const forward = buildLinkIndex(paths);
    const backward = buildLinkIndex([...paths].reverse());
    const a = resolveWikiLink(forward, 'Nota');
    const b = resolveWikiLink(backward, 'Nota');
    expect(a).toEqual(b);
    expect(a.ambiguous).toBe(true);
    // menos pastas primeiro; arquivada por último
    expect(a.path).toBe('wiki/Nota.md');
    expect(a.candidates).toEqual([
      'wiki/Nota.md',
      'wiki/concepts/Nota.md',
      'wiki/entities/Nota.md',
      'wiki/deep/a/b/Nota.md',
      'memory/_archive/nota.md',
    ]);
    expect(findAmbiguousNames(forward)).toEqual([{ name: 'nota', paths: [...paths].sort() }]);
  });

  it('prefere a nota na mesma pasta de quem tem o link', () => {
    const index = buildLinkIndex(paths);
    expect(resolveWikiLink(index, 'Nota', 'wiki/entities/Outra.md').path).toBe('wiki/entities/Nota.md');
    expect(resolveWikiLink(index, 'nota', 'memory/_archive/x.md').path).toBe('memory/_archive/nota.md');
  });

  it('o caminho desfaz a ambiguidade', () => {
    const index = buildLinkIndex(paths);
    expect(resolveWikiLink(index, 'concepts/Nota')).toEqual({
      path: 'wiki/concepts/Nota.md',
      ambiguous: false,
      candidates: ['wiki/concepts/Nota.md'],
    });
  });

  it('onde Nota.md e nota.md convivem (Linux), prefere a caixa escrita no link', () => {
    const index = buildLinkIndex(['wiki/nota.md', 'wiki/Nota.md']);
    expect(resolveWikiLink(index, 'Nota').path).toBe('wiki/Nota.md');
    expect(resolveWikiLink(index, 'nota').path).toBe('wiki/nota.md');
    expect(resolveWikiLink(index, 'NOTA').path).toBe('wiki/Nota.md');
    expect(resolveWikiLink(index, 'wiki/nota').ambiguous).toBe(true);
  });
});
