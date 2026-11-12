// Regressão da revisão adversária do marco 1, na camada do vault (a biblioteca que a CLI humana também usa): nomes
// de pasta que quebram o Windows, links simbólicos na escrita e para `.git/`, arquivos de controle, caixa do disco.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrainConfig } from '../../src/vault/index.ts';
import {
  createNote,
  dirNameProblem,
  diskCasePath,
  isBrainControlFile,
  listNoteFiles,
  patchNote,
  readBrainConfig,
  readNote,
  resolveVaultPath,
  updateNote,
  VaultError,
} from '../../src/vault/index.ts';
import type { TempVault } from './helpers.ts';
import { copyFixture, exists, makeTempDir, readText, trySymlink } from './helpers.ts';

let temp: TempVault | undefined;
afterEach(async () => {
  await temp?.cleanup();
  temp = undefined;
});

async function setup(label: string): Promise<{ root: string; config: BrainConfig }> {
  temp = await copyFixture(label);
  return { root: temp.root, config: await readBrainConfig(temp.root) };
}

async function vaultError(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultError) return error;
    throw error;
  }
  throw new Error('deveria ter lançado VaultError');
}

describe('M6: cada pasta do caminho tem de valer no Windows', () => {
  it('recusa pasta nova com nome reservado, caractere proibido ou ponto/espaço no fim', async () => {
    const { root, config } = await setup('pastas');
    for (const path of [
      'wiki/aux/nota.md',
      'wiki/AUX.txt/nota.md',
      'wiki/a:b/nota.md',
      'wiki/pasta. /nota.md',
      'wiki/pasta./nota.md',
      'wiki/x|y?/nota.md',
      'wiki/com1/nota.md',
      'wiki/a#b/nota.md',
    ]) {
      const error = await vaultError(createNote(root, config, { type: 'concept', origin: 'human', title: 'x', path }));
      expect(error.code, path).toBe('invalid_file_name');
      expect(await exists(root, path.slice(0, path.lastIndexOf('/'))), path).toBe(false);
    }
  });

  it('pasta que já existe: só as regras do Windows (C# continua aceita; aux já criada no Linux, não)', async () => {
    const { root, config } = await setup('pastas existentes');
    await mkdir(join(root, 'wiki', 'C#'));
    const ok = await createNote(root, config, {
      type: 'concept',
      origin: 'human',
      title: 'x',
      path: 'wiki/C#/nota.md',
    });
    expect(ok.path).toBe('wiki/C#/nota.md');
    expect(dirNameProblem('C#', { existing: true })).toBeNull();
    expect(dirNameProblem('aux', { existing: true })).toMatch(/reservado/);
    expect(dirNameProblem('a:b', { existing: true })).toMatch(/Windows/);
  });
});

describe('A5: links simbólicos', () => {
  it('nada alcança .git/ nem .cabecao/ por link, nem para ler; a listagem também não os vê', async () => {
    const { root, config } = await setup('link git');
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), '[core]\n');
    await mkdir(join(root, '.cabecao'));
    if (!(await trySymlink(join(root, '.git', 'config'), join(root, 'wiki', 'config.md'), 'file'))) return;
    if (!(await trySymlink(join(root, '.cabecao'), join(root, 'wiki', 'banco'), 'dir'))) return;
    expect((await vaultError(resolveVaultPath(root, 'wiki/config.md'))).code).toBe('unsafe_path');
    expect((await vaultError(resolveVaultPath(root, 'wiki/banco/x.md', { write: true }))).code).toBe('unsafe_path');
    expect((await vaultError(readNote(root, 'wiki/config.md'))).code).toBe('unsafe_path');
    const error = await vaultError(
      updateNote(root, 'wiki/config.md', { body: '[core]\n\tfsmonitor = x\n' }, { config }),
    );
    expect(error.code).toBe('unsafe_path');
    expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
    const listed = (await listNoteFiles(root, config)).map((file) => file.path);
    expect(listed).not.toContain('wiki/config.md');
  });

  it('a escrita recusa link no arquivo ou numa pasta do caminho, mesmo apontando para dentro do cérebro', async () => {
    const { root, config } = await setup('link escrita');
    const target = 'wiki/concepts/Fila de mensagens.md';
    if (!(await trySymlink(join(root, 'memory', 'gotchas'), join(root, 'wiki', 'atalho'), 'dir'))) return;
    const linkedFile = await trySymlink(
      join(root, ...target.split('/')),
      join(root, 'wiki', 'concepts', 'Fila.md'),
      'file',
    );
    const viaDir = await vaultError(
      createNote(root, config, { type: 'concept', origin: 'human', title: 'x', path: 'wiki/atalho/x.md' }),
    );
    expect(viaDir.code).toBe('unsafe_path');
    expect(viaDir.message).toMatch(/link simbólico/);
    expect(await exists(root, 'memory/gotchas/x.md')).toBe(false);
    // a leitura por link que fica dentro das pastas de notas continua
    expect((await readNote(root, 'wiki/atalho/testes-de-integracao-sem-limpar-o-banco.md')).note.body).not.toBe('');
    if (linkedFile) {
      const before = await readText(root, target);
      const body = (await readNote(root, 'wiki/concepts/Fila.md')).note.body;
      const once = body.slice(0, 20);
      expect((await vaultError(patchNote(root, 'wiki/concepts/Fila.md', once, 'TROCADO', { config }))).code).toBe(
        'unsafe_path',
      );
      expect((await vaultError(updateNote(root, 'wiki/concepts/Fila.md', { body: 'x\n' }, { config }))).code).toBe(
        'unsafe_path',
      );
      expect(await readText(root, target)).toBe(before);
    }
  });
});

describe('A3: arquivos de controle não são gravados como nota', () => {
  it('isBrainControlFile e a recusa em createNote e updateNote, com noteDirs ["."]', async () => {
    const { root, config } = await setup('controle');
    const adopted: BrainConfig = { ...config, noteDirs: ['.'] };
    for (const path of ['CLAUDE.md', 'agents.md', 'log.md', 'index.md', 'README.md', 'LICENSE.md']) {
      expect(isBrainControlFile(path, adopted), path).toBe(true);
    }
    expect(isBrainControlFile('wiki/CLAUDE.md', adopted)).toBe(false);
    expect(isBrainControlFile('catalogo/indice.md', { indexMd: 'catalogo/indice.md' })).toBe(true);
    const before = await readText(root, 'AGENTS.md');
    expect((await vaultError(updateNote(root, 'AGENTS.md', { body: 'x' }, { config: adopted }))).code).toBe(
      'invalid_note_path',
    );
    expect(
      (await vaultError(createNote(root, adopted, { type: 'concept', origin: 'human', title: 'x', path: 'README.md' })))
        .code,
    ).toBe('invalid_note_path');
    expect(await readText(root, 'AGENTS.md')).toBe(before);
  });
});

describe('caixa do disco', () => {
  it('diskCasePath devolve a grafia que está no disco, segmento a segmento', async () => {
    const { root } = await setup('caixa');
    expect(await diskCasePath(root, 'WIKI/Entities/sqs.md')).toEqual({ path: 'wiki/entities/SQS.md', existing: 3 });
    expect(await diskCasePath(root, 'Wiki/novas/x.md')).toEqual({ path: 'wiki/novas/x.md', existing: 1 });
    const empty = await makeTempDir('vazia');
    try {
      expect(await diskCasePath(join(empty.root, 'nao-existe'), 'a/b.md')).toEqual({ path: 'a/b.md', existing: 0 });
    } finally {
      await empty.cleanup();
    }
  });

  it('updateNote por outra caixa grava no arquivo do disco e devolve o caminho dele', async () => {
    const { root, config } = await setup('caixa update');
    const result = await updateNote(root, 'wiki/entities/sqs.md', { body: 'novo corpo\n' }, { config });
    expect(result.path).toBe('wiki/entities/SQS.md');
    expect(await readText(root, 'wiki/entities/SQS.md')).toContain('novo corpo');
  });
});
