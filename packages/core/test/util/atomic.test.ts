import { chmod, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameWithRetry } from '../../src/util/atomic.ts';
import { FileChangedError, fileStamp, writeFileAtomic } from '../../src/util/index.ts';
import { makeTempDir, runChild } from './helpers.ts';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await makeTempDir('atomic'));
});
afterEach(async () => {
  await cleanup();
});

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('writeFileAtomic', () => {
  it('grava texto e bytes, e sobrescreve', async () => {
    const file = join(dir, 'nota.md');
    await writeFileAtomic(file, 'primeira versão\n');
    expect(await readFile(file, 'utf8')).toBe('primeira versão\n');
    await writeFileAtomic(file, new Uint8Array([0xc3, 0xa7]));
    expect(await readFile(file, 'utf8')).toBe('ç');
    expect(await readdir(dir)).toEqual(['nota.md']);
  });

  it('cria as pastas que faltam', async () => {
    const file = join(dir, 'wiki', 'projetos', 'cabeção.md');
    await writeFileAtomic(file, 'x');
    expect(await readFile(file, 'utf8')).toBe('x');
  });

  it('devolve a impressão do arquivo gravado', async () => {
    const file = join(dir, 'nota.md');
    const stamp = await writeFileAtomic(file, 'abc');
    expect(stamp.size).toBe(3);
    expect(await fileStamp(file)).toEqual(stamp);
    expect(await fileStamp(join(dir, 'nao-existe.md'))).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('preserva o modo do arquivo existente', async () => {
    const file = join(dir, 'script.sh');
    await writeFile(file, 'antigo');
    await chmod(file, 0o750);
    await writeFileAtomic(file, 'novo');
    expect((await stat(file)).mode & 0o777).toBe(0o750);
    expect(await readFile(file, 'utf8')).toBe('novo');
  });

  it.skipIf(process.platform === 'win32')('grava no alvo de um link simbólico sem desfazer o link', async () => {
    const real = join(dir, 'real.md');
    const link = join(dir, 'link.md');
    await writeFile(real, 'antigo');
    await symlink(real, link);
    await writeFileAtomic(link, 'novo');
    expect(await readFile(real, 'utf8')).toBe('novo');
    expect((await readdir(dir)).sort()).toEqual(['link.md', 'real.md']);
  });

  it('não deixa temporário quando a escrita falha', async () => {
    const target = join(dir, 'pasta');
    await mkdir(target);
    await expect(writeFileAtomic(target, 'x')).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await readdir(dir)).toEqual(['pasta']);

    // Falha DEPOIS de o temporário ter sido criado e escrito.
    const file = join(dir, 'nota.md');
    await writeFile(file, 'original');
    await expect(writeFileAtomic(file, 'novo', { ifUnchangedSince: { mtimeMs: 1, size: 1 } })).rejects.toThrow(
      FileChangedError,
    );
    expect((await readdir(dir)).sort()).toEqual(['nota.md', 'pasta']);
  });

  describe('ifUnchangedSince', () => {
    it('grava quando o arquivo não mudou desde a leitura', async () => {
      const file = join(dir, 'nota.md');
      const first = await writeFileAtomic(file, 'v1');
      const second = await writeFileAtomic(file, 'v2 maior', { ifUnchangedSince: first });
      await writeFileAtomic(file, 'v3', { ifUnchangedSince: second });
      expect(await readFile(file, 'utf8')).toBe('v3');
    });

    it('recusa quando o tamanho mudou', async () => {
      const file = join(dir, 'nota.md');
      const stamp = await writeFileAtomic(file, 'v1');
      await writeFile(file, 'editado no Obsidian');
      const error = await writeFileAtomic(file, 'v2', { ifUnchangedSince: stamp }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FileChangedError);
      expect(error).toMatchObject({ code: 'ECHANGED', path: file, expected: stamp });
      expect(await readFile(file, 'utf8')).toBe('editado no Obsidian');
    });

    it('recusa quando só a data mudou (mesmo tamanho)', async () => {
      const file = join(dir, 'nota.md');
      const stamp = await writeFileAtomic(file, 'aaaa');
      await writeFile(file, 'bbbb');
      const later = new Date(stamp.mtimeMs + 5_000);
      await utimes(file, later, later);
      await expect(writeFileAtomic(file, 'cccc', { ifUnchangedSince: stamp })).rejects.toThrow(FileChangedError);
      expect(await readFile(file, 'utf8')).toBe('bbbb');
    });

    it('recusa quando o arquivo sumiu', async () => {
      const file = join(dir, 'nota.md');
      await expect(writeFileAtomic(file, 'x', { ifUnchangedSince: { mtimeMs: 1, size: 1 } })).rejects.toMatchObject({
        code: 'ECHANGED',
        actual: null,
      });
      expect(await readdir(dir)).toEqual([]);
    });

    it('null exige que o arquivo ainda não exista', async () => {
      const file = join(dir, 'nota.md');
      await writeFileAtomic(file, 'criado', { ifUnchangedSince: null });
      await expect(writeFileAtomic(file, 'de novo', { ifUnchangedSince: null })).rejects.toThrow(FileChangedError);
      expect(await readFile(file, 'utf8')).toBe('criado');
    });
  });

  it('escritores concorrentes: o conteúdo é sempre o de UM deles, inteiro', async () => {
    const file = join(dir, 'disputado.md');
    const size = 256 * 1024;
    const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
    await writeFileAtomic(file, 'a'.repeat(size));

    const isWhole = (text: string) => text.length === size && letters.some((l) => text === l.repeat(size));

    let running = true;
    let reads = 0;
    const torn: number[] = [];
    const reader = (async () => {
      while (running) {
        try {
          const text = await readFile(file, 'utf8');
          reads++;
          if (!isWhole(text)) torn.push(text.length);
        } catch (error) {
          // No Windows a leitura pode esbarrar no instante exato da troca; nos outros sistemas, nunca.
          if (process.platform !== 'win32') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();

    let results: Awaited<ReturnType<typeof runChild>>[];
    try {
      results = await Promise.all(
        letters.map((letter) => runChild('atomic-child.mjs', [file, letter, String(size), '25'])),
      );
    } finally {
      running = false;
      await reader;
    }

    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(torn).toEqual([]);
    expect(reads).toBeGreaterThan(0);
    expect(isWhole(await readFile(file, 'utf8'))).toBe(true);
    expect(await readdir(dir)).toEqual(['disputado.md']);
  }, 120_000);
});

describe('renameWithRetry', () => {
  it('no Windows tenta de novo em EPERM, EBUSY e EACCES', async () => {
    const failures = ['EPERM', 'EBUSY', 'EACCES'];
    let calls = 0;
    await renameWithRetry('a', 'b', {
      platform: 'win32',
      delaysMs: [1, 1, 1],
      rename: async () => {
        const code = failures[calls++];
        if (code) throw errno(code);
      },
    });
    expect(calls).toBe(4);
  });

  it('no Windows desiste depois das tentativas e devolve o erro original', async () => {
    let calls = 0;
    const attempt = renameWithRetry('a', 'b', {
      platform: 'win32',
      delaysMs: [1, 1],
      rename: async () => {
        calls++;
        throw errno('EBUSY');
      },
    });
    await expect(attempt).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(3);
  });

  it('não insiste em erro definitivo nem fora do Windows', async () => {
    for (const [platform, code] of [
      ['win32', 'ENOENT'],
      ['linux', 'EPERM'],
      ['darwin', 'EACCES'],
    ] as const) {
      let calls = 0;
      const attempt = renameWithRetry('a', 'b', {
        platform,
        delaysMs: [1, 1],
        rename: async () => {
          calls++;
          throw errno(code);
        },
      });
      await expect(attempt).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    }
  });
});
