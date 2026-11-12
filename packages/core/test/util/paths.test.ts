import { describe, expect, it } from 'vitest';
import {
  checkFileNameLength,
  isSafeRelativePath,
  MAX_FILE_NAME_BYTES,
  normalizeNfc,
  toPosixPath,
} from '../../src/util/index.ts';

describe('toPosixPath', () => {
  it('troca barras invertidas por barras', () => {
    expect(toPosixPath('wiki\\projetos\\nota.md')).toBe('wiki/projetos/nota.md');
    expect(toPosixPath('wiki/projetos\\nota.md')).toBe('wiki/projetos/nota.md');
    expect(toPosixPath('nota.md')).toBe('nota.md');
    expect(toPosixPath('')).toBe('');
  });
});

describe('normalizeNfc', () => {
  it('compõe o que veio decomposto (NFD)', () => {
    const nfd = 'cabec\u0327a\u0303o.md';
    const nfc = 'cabe\u00e7\u00e3o.md';
    expect(nfd).not.toBe(nfc);
    expect(normalizeNfc(nfd)).toBe(nfc);
    expect(normalizeNfc(nfc)).toBe(nfc);
  });
});

describe('isSafeRelativePath', () => {
  it('aceita caminhos dentro do cérebro', () => {
    for (const ok of [
      'nota.md',
      'wiki/projetos/cabeção.md',
      'wiki\\projetos\\nota.md',
      './wiki/nota.md',
      'wiki//nota.md',
      'wiki/pasta/',
      'memory/2026-11-12 reunião.md',
      '.cabecao.json',
      '.obsidian/app.json',
      'notas/..md',
      'notas/a..b.md',
      'notas/...reticências.md',
      'wiki/Pergunta: por quê.md',
      '.gitignore',
      '.github/x.md',
      'git/nota.md',
      'wiki/minha.git.md',
      '~/nota.md',
    ]) {
      expect(isSafeRelativePath(ok), ok).toBe(true);
    }
  });

  it('recusa caminhos absolutos em qualquer sistema', () => {
    for (const bad of [
      '/etc/passwd',
      '/',
      '\\Windows\\System32',
      'C:\\Users\\ana\\nota.md',
      'C:/Users/ana/nota.md',
      'c:nota.md',
      '\\\\servidor\\pasta\\nota.md',
      '//servidor/pasta/nota.md',
      '\\\\?\\C:\\nota.md',
    ]) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
  });

  it('recusa `..` e o que escapa da raiz', () => {
    for (const bad of [
      '..',
      '../nota.md',
      'wiki/../../nota.md',
      'wiki/../nota.md',
      'wiki\\..\\..\\nota.md',
      'wiki/..',
      './../nota.md',
      'wiki/.. /nota.md',
      'wiki/.../nota.md',
      'wiki/. ./nota.md',
      'wiki/..:fluxo/nota.md',
    ]) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
  });

  it('recusa vazio, a própria raiz, byte nulo e o que não é texto', () => {
    for (const bad of ['', '.', './', '/', 'nota\0.md', undefined, null, 42, ['nota.md']]) {
      expect(isSafeRelativePath(bad), String(bad)).toBe(false);
    }
  });

  it('recusa a pasta .git em qualquer nível e grafia', () => {
    for (const bad of [
      '.git',
      '.git/config',
      '.git/hooks/pre-commit',
      '.GIT/hooks/pre-commit',
      '.git\\hooks\\pre-commit',
      'wiki/.git/config',
      '.git./config',
      '.git /config',
      '.git::$INDEX_ALLOCATION/config',
      'GIT~1/config',
    ]) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
  });
});

describe('checkFileNameLength', () => {
  it('conta bytes de UTF-8, não caracteres', () => {
    expect(checkFileNameLength('nota.md')).toEqual({ ok: true, bytes: 7, limit: 255 });
    expect(checkFileNameLength('ção.md')).toEqual({ ok: true, bytes: 8, limit: 255 });
    expect(MAX_FILE_NAME_BYTES).toBe(255);
  });

  it('o limite é exatamente 255 bytes', () => {
    expect(checkFileNameLength(`${'a'.repeat(252)}.md`)).toMatchObject({ ok: true, bytes: 255 });
    expect(checkFileNameLength(`${'a'.repeat(253)}.md`)).toMatchObject({ ok: false, bytes: 256 });
  });

  it('caso medido no spike: 200 cedilhas + .md cabe em caracteres e não cabe em bytes', () => {
    const name = `${'ç'.repeat(200)}.md`;
    expect(name.length).toBe(203);
    expect(checkFileNameLength(name)).toEqual({ ok: false, bytes: 403, limit: 255 });
  });

  it('mede o nome já em NFC, que é como ele será gravado', () => {
    const nfd = `${'c\u0327'.repeat(100)}.md`;
    expect(Buffer.byteLength(nfd, 'utf8')).toBe(303);
    expect(checkFileNameLength(nfd)).toMatchObject({ ok: true, bytes: 203 });
  });
});
