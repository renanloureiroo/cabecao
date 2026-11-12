import { describe, expect, it } from 'vitest';
import { conflictCopyPath, isSyncablePath, parseConflictCopyPath } from '../../src/sync/index.ts';
import { unionLines } from '../../src/sync/integrate.ts';

const CONFIG = { noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' };

describe('nomes de cópia de conflito', () => {
  const date = new Date(2026, 10, 12, 14, 32, 10);

  it('fica ao lado da nota, com máquina e data local', () => {
    expect(conflictCopyPath('wiki/nota.md', 'macbook', date)).toBe('wiki/nota.conflict-macbook-20261112-143210.md');
    expect(conflictCopyPath('wiki/nota.md', 'macbook', date, 3)).toBe(
      'wiki/nota.conflict-macbook-20261112-143210-3.md',
    );
    expect(conflictCopyPath('raw/foto.jpeg', 'pc', date)).toBe('raw/foto.conflict-pc-20261112-143210.jpeg');
    expect(conflictCopyPath('wiki/.oculto', 'pc', date)).toBe('wiki/.oculto.conflict-pc-20261112-143210');
    expect(conflictCopyPath('wiki/v1.2/LEIAME', 'pc', date)).toBe('wiki/v1.2/LEIAME.conflict-pc-20261112-143210');
  });

  it('é lido de volta, inclusive com hífen no nome da máquina', () => {
    expect(parseConflictCopyPath('wiki/nota.conflict-mac-do-renan-20261112-143210.md')).toEqual({
      original: 'wiki/nota.md',
      machine: 'mac-do-renan',
      date: '2026-11-12T14:32:10',
    });
    expect(parseConflictCopyPath('wiki/nota.conflict-pc-20261112-143210-2.md')?.original).toBe('wiki/nota.md');
    expect(parseConflictCopyPath('wiki/nota.md')).toBeNull();
    expect(parseConflictCopyPath('wiki/nota.conflict-pc-2026.md')).toBeNull();
  });
});

describe('isSyncablePath', () => {
  it('aceita o que está nas pastas de notas e os arquivos do cérebro na raiz', () => {
    for (const path of [
      'wiki/a.md',
      'memory/sub/b.md',
      'raw/fonte.pdf',
      'log.md',
      'index.md',
      'AGENTS.md',
      '.cabecao.json',
      '.gitattributes',
      '.gitignore',
    ]) {
      expect(isSyncablePath(path, CONFIG), path).toBe(true);
    }
  });

  it('recusa pastas ocultas e o que está fora das pastas de notas', () => {
    for (const path of [
      '.obsidian/app.json',
      '.cabecao/sync/state.json',
      'wiki/.trash/x.md',
      'fora/x.md',
      'README.md',
      'wikinho/x.md',
    ]) {
      expect(isSyncablePath(path, CONFIG), path).toBe(false);
    }
  });

  it('vault adotado (noteDirs ["."]): tudo que não é oculto', () => {
    const adopted = { noteDirs: ['.'], indexMd: 'index.md' };
    expect(isSyncablePath('qualquer/x.md', adopted)).toBe(true);
    expect(isSyncablePath('README.md', adopted)).toBe(true);
    expect(isSyncablePath('.obsidian/app.json', adopted)).toBe(false);
  });
});

describe('unionLines (log.md sem o atributo de união)', () => {
  it('guarda as linhas novas dos dois lados, cada uma uma vez', () => {
    const base = '# Diário\n\n- a\n';
    expect(unionLines(`${base}- remoto\n`, `${base}- local\n`)).toBe(`${base}- remoto\n- local\n`);
  });

  it('linhas repetidas de propósito continuam repetidas', () => {
    expect(unionLines('- x\n- x\n', '- x\n- x\n- x\n')).toBe('- x\n- x\n- x\n');
  });

  it('nunca perde linha, mesmo sem base comum ou sem quebra final', () => {
    expect(unionLines('- r', '- l')).toBe('- r\n- l\n');
    expect(unionLines('', '- l\n')).toBe('- l\n');
    expect(unionLines('', '')).toBe('');
  });
});
