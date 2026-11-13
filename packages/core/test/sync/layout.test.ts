import { describe, expect, it } from 'vitest';
import { conflictCopyPath, isSyncablePath, parseConflictCopyPath } from '../../src/sync/index.ts';
import { unionLines } from '../../src/sync/integrate.ts';

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

describe('isSyncablePath (tudo sincroniza, menos .git/, .cabecao/ e temporários)', () => {
  it('aceita qualquer arquivo do cérebro: notas, configuração, pastas novas, pastas ocultas', () => {
    for (const path of [
      'wiki/a.md',
      'memory/sub/b.md',
      'raw/fonte.pdf',
      'log.md',
      'index.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.cabecao.json',
      '.gitattributes',
      '.gitignore',
      'dashboards/Painel.canvas',
      'Projetos/Plano 2027.md',
      'README.md',
      '.obsidian/app.json',
      'wiki/.trash/x.md',
      'AGENTS.conflict-pc-20261112-143210.md',
    ]) {
      expect(isSyncablePath(path), path).toBe(true);
    }
  });

  it('recusa .git/, .cabecao/ (em qualquer nível), temporários da escrita atômica e pastas', () => {
    for (const path of [
      '.cabecao/sync/state.json',
      'sub/.cabecao/cabecao.db',
      '.git/config',
      'embutido/.git',
      'wiki/.cabecao-123-abcdef.tmp',
      'embutido/',
      '',
    ]) {
      expect(isSyncablePath(path), path).toBe(false);
    }
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
