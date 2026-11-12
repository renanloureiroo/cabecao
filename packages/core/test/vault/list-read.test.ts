import { mkdir, rename, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATOMIC_TMP_PREFIX, ATOMIC_TMP_SUFFIX } from '../../src/util/index.ts';
import { hashContent, listNoteFiles, readBrainConfig, readNote, VaultError } from '../../src/vault/index.ts';
import type { TempVault } from './helpers.ts';
import { copyFixture, fixtureNotePaths, makeTempDir, toCrlf, trySymlink, writeText } from './helpers.ts';

let temp: TempVault | undefined;
let outside: TempVault | undefined;
afterEach(async () => {
  await temp?.cleanup();
  await outside?.cleanup();
  temp = undefined;
  outside = undefined;
});

const config = { noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' } as const;

describe('listNoteFiles', () => {
  it('lista as notas do cérebro de exemplo com caminho POSIX em NFC, carimbo e arquivamento', async () => {
    temp = await copyFixture('list');
    const files = await listNoteFiles(temp.root, await readBrainConfig(temp.root));
    expect(files.map((file) => file.path)).toEqual(await fixtureNotePaths());
    const paths = files.map((file) => file.path);
    // ordem de código, a mesma em qualquer máquina
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const file of files) {
      expect(file.path).not.toContain('\\');
      expect(file.path).toBe(file.path.normalize('NFC'));
      expect(file.size).toBeGreaterThan(0);
      expect(file.mtimeMs).toBeGreaterThan(0);
      expect(file.archived).toBe(file.path.startsWith('memory/_archive/'));
    }
    expect(files.filter((file) => file.archived).map((file) => file.path)).toEqual([
      'memory/_archive/preferencia-usar-tabs.md',
    ]);
    expect(paths).toContain('wiki/concepts/Idempotência.md');
    // index.md, log.md, AGENTS.md e CLAUDE.md ficam na raiz, fora das pastas de notas
    expect(paths.some((path) => !path.includes('/'))).toBe(false);
  });

  it('ignora pastas ocultas, temporários da escrita atômica e o que não é .md', async () => {
    temp = await makeTempDir('list');
    const root = temp.root;
    await writeText(root, 'wiki/a.md', 'a');
    await writeText(root, 'wiki/B.MD', 'b');
    await writeText(root, 'wiki/.obsidian/workspace.md', 'x');
    await writeText(root, 'wiki/.git/HEAD.md', 'x');
    await writeText(root, 'wiki/.cabecao/x.md', 'x');
    await writeText(root, 'wiki/.oculta.md', 'x');
    await writeText(root, `wiki/${ATOMIC_TMP_PREFIX}123-abc${ATOMIC_TMP_SUFFIX}`, 'x');
    await writeText(root, `wiki/${ATOMIC_TMP_PREFIX}123-abc.md${ATOMIC_TMP_SUFFIX}`, 'x');
    await writeText(root, 'wiki/imagem.png', 'x');
    await writeText(root, 'wiki/canvas.canvas', 'x');
    await writeText(root, 'wiki/sem-extensao', 'x');
    await mkdir(join(root, 'wiki', 'pasta.md'));
    await writeText(root, 'fora/nota.md', 'x');
    const files = await listNoteFiles(root, { noteDirs: ['wiki', 'nao-existe'], indexMd: 'index.md' });
    expect(files.map((file) => file.path)).toEqual(['wiki/B.MD', 'wiki/a.md']);
  });

  it('com noteDirs na raiz (vault adotado), não lista o catálogo, o diário nem as pastas ocultas', async () => {
    temp = await copyFixture('list');
    await writeText(temp.root, '.obsidian/x.md', 'x');
    await writeText(temp.root, '.cabecao/x.md', 'x');
    const files = await listNoteFiles(temp.root, { noteDirs: ['.', 'wiki'], indexMd: 'index.md' });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('AGENTS.md');
    expect(paths).not.toContain('index.md');
    expect(paths).not.toContain('log.md');
    expect(paths.some((path) => path.startsWith('.'))).toBe(false);
    // `wiki` dentro de `.` não aparece duas vezes
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('devolve NFC mesmo quando o nome está gravado em NFD, e guarda o nome do disco', async () => {
    temp = await makeTempDir('list');
    const nfd = 'Reunião'.normalize('NFD');
    await writeText(temp.root, `wiki/${nfd}.md`, 'x');
    const [file] = await listNoteFiles(temp.root, { noteDirs: ['wiki'], indexMd: 'index.md' });
    expect(file?.path).toBe('wiki/Reunião.md'.normalize('NFC'));
    // no macOS o readdir pode devolver qualquer uma das formas; o caminho do disco tem de abrir o arquivo
    const read = await readNote(temp.root, file?.diskPath ?? '');
    expect(read.text).toBe('x');
  });

  it('segue link simbólico que fica dentro do cérebro e ignora o que sai dele', async () => {
    temp = await makeTempDir('list');
    outside = await makeTempDir('fora');
    await writeText(outside.root, 'segredo.md', 'segredo');
    await writeText(outside.root, 'pasta/outro.md', 'segredo');
    await writeText(temp.root, 'wiki/real/nota.md', 'x');
    await writeText(temp.root, 'memory/m.md', 'x');
    const made = [
      await trySymlink(join(outside.root, 'pasta'), join(temp.root, 'wiki', 'fora'), 'dir'),
      await trySymlink(join(temp.root, 'memory'), join(temp.root, 'wiki', 'dentro'), 'dir'),
      await trySymlink(join(temp.root, 'wiki'), join(temp.root, 'wiki', 'real', 'laco'), 'dir'),
    ];
    const fileLinks = [
      await trySymlink(join(outside.root, 'segredo.md'), join(temp.root, 'wiki', 'segredo.md'), 'file'),
      await trySymlink(join(temp.root, 'memory', 'm.md'), join(temp.root, 'wiki', 'atalho.md'), 'file'),
    ];
    // uma pasta de notas que é ela mesma um link para fora
    const rootLink = await trySymlink(outside.root, join(temp.root, 'raw'), 'dir');
    expect(made.every(Boolean)).toBe(true);

    const files = await listNoteFiles(temp.root, { noteDirs: ['wiki', 'raw'], indexMd: 'index.md' });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('wiki/real/nota.md');
    expect(paths).toContain('wiki/dentro/m.md');
    expect(paths.some((path) => path.includes('outro') || path.includes('segredo'))).toBe(false);
    expect(paths.some((path) => path.startsWith('raw/'))).toBe(false);
    if (fileLinks[1]) expect(paths).toContain('wiki/atalho.md');
    expect(rootLink).toBe(true);
    // o laço `wiki/real/laco -> wiki` não trava a varredura nem repete notas sem fim
    expect(paths.length).toBeLessThan(10);
  });

  it('é rápida: não lê conteúdo (3 mil notas bem abaixo de 1 s)', async () => {
    temp = await makeTempDir('list');
    for (let d = 0; d < 30; d++) {
      const dir = join(temp.root, 'wiki', `d${d}`);
      await mkdir(dir, { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, `nota ${i}.md`), 'x')));
    }
    const started = performance.now();
    const files = await listNoteFiles(temp.root, { noteDirs: ['wiki'], indexMd: 'index.md' });
    const elapsed = performance.now() - started;
    expect(files).toHaveLength(3000);
    // folga larga para os runners do CI; medido localmente: ~15 ms para 3 mil, ~150 ms para 30 mil
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('readNote', () => {
  it('devolve a nota parseada, o carimbo e o hash do conteúdo', async () => {
    temp = await copyFixture('read');
    const read = await readNote(temp.root, 'wiki/decisions/usar-sqs-para-filas.md');
    expect(read.path).toBe('wiki/decisions/usar-sqs-para-filas.md');
    expect(read.note.frontmatter.id).toBe('01KNWQPCCGW9YN4PHGN519T4H6');
    expect(read.note.title).toBe('Usar SQS para filas');
    expect(read.contentHash).toBe(hashContent(read.text));
    expect(read.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(read.stamp.size).toBe(Buffer.byteLength(read.text));
    const [listed] = (await listNoteFiles(temp.root, config)).filter((file) => file.path === read.path);
    expect(read.stamp).toEqual({ mtimeMs: listed?.mtimeMs, size: listed?.size });
  });

  it('aceita \\ como separador e nome em NFD/NFC', async () => {
    temp = await copyFixture('read');
    const viaBackslash = await readNote(temp.root, 'wiki\\concepts\\Idempotência.md');
    expect(viaBackslash.path).toBe('wiki/concepts/Idempotência.md');
    const viaNfd = await readNote(temp.root, 'wiki/concepts/Idempotência.md'.normalize('NFD'));
    expect(viaNfd.path).toBe('wiki/concepts/Idempotência.md'.normalize('NFC'));
    expect(viaNfd.text).toBe(viaBackslash.text);
  });

  it('o hash muda com o conteúdo, e frontmatter inválido não é erro de leitura', async () => {
    temp = await makeTempDir('read');
    await writeText(temp.root, 'wiki/a.md', '---\ntitle: [aberto\n---\ncorpo\n');
    const first = await readNote(temp.root, 'wiki/a.md');
    expect(first.note.frontmatterError?.code).toBe('invalid_yaml');
    await writeText(temp.root, 'wiki/a.md', toCrlf('---\ntitle: ok\n---\ncorpo\n'));
    const second = await readNote(temp.root, 'wiki/a.md');
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.note.frontmatter.title).toBe('ok');
    expect(second.text).toContain('\r\n');
  });

  it('recusa caminho fora do cérebro e avisa nota que não existe', async () => {
    temp = await copyFixture('read');
    for (const bad of ['../fora.md', '/etc/passwd', 'C:\\Windows\\x.md', '.git/config', 'wiki/../../x.md']) {
      await expect(readNote(temp.root, bad), bad).rejects.toMatchObject({ code: 'unsafe_path' });
    }
    await expect(readNote(temp.root, 'wiki/nao-existe.md')).rejects.toBeInstanceOf(VaultError);
    await expect(readNote(temp.root, 'wiki/nao-existe.md')).rejects.toMatchObject({ code: 'note_not_found' });
    await expect(readNote(temp.root, 'wiki')).rejects.toMatchObject({ code: 'note_not_found' });
  });

  it('recusa ler por um link simbólico que sai do cérebro', async () => {
    temp = await makeTempDir('read');
    outside = await makeTempDir('fora');
    await writeText(outside.root, 'segredo.md', 'segredo');
    await mkdir(join(temp.root, 'wiki'));
    if (!(await trySymlink(outside.root, join(temp.root, 'wiki', 'fora'), 'dir'))) return;
    await expect(readNote(temp.root, 'wiki/fora/segredo.md')).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('o carimbo muda quando o arquivo é trocado', async () => {
    temp = await makeTempDir('read');
    await writeText(temp.root, 'wiki/a.md', 'um');
    const first = await readNote(temp.root, 'wiki/a.md');
    await writeText(temp.root, 'wiki/b.md', 'dois');
    await utimes(join(temp.root, 'wiki', 'b.md'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    await rename(join(temp.root, 'wiki', 'b.md'), join(temp.root, 'wiki', 'a.md'));
    const second = await readNote(temp.root, 'wiki/a.md');
    expect(second.stamp).not.toEqual(first.stamp);
  });
});
