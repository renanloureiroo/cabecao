import { afterEach, describe, expect, it } from 'vitest';
import type { IndexEntry } from '../../src/vault/index.ts';
import {
  appendLogLine,
  collectIndexEntries,
  formatLogLine,
  LOG_MD,
  readBrainConfig,
  readNote,
  renderIndexMd,
  writeIndexMd,
} from '../../src/vault/index.ts';
import type { TempVault } from './helpers.ts';
import { copyFixture, makeTempDir, readText, toCrlf, writeText } from './helpers.ts';

let temp: TempVault | undefined;
afterEach(async () => {
  await temp?.cleanup();
  temp = undefined;
});

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line.startsWith('- '));

describe('renderIndexMd', () => {
  it('gera, a partir do cérebro de exemplo, as mesmas linhas do index.md dele', async () => {
    temp = await copyFixture('catalog');
    const config = await readBrainConfig(temp.root);
    const generated = renderIndexMd(await collectIndexEntries(temp.root, config), { groupOrder: config.noteDirs });
    const fixture = (await readNote(temp.root, 'index.md')).text;
    // o do exemplo foi escrito à mão, em outra ordem; o conteúdo (links, tipos, vencidos) é o mesmo
    expect(lines(generated).sort()).toEqual(lines(fixture).sort());
    expect(generated.startsWith('# Índice\n\nCatálogo gerado. Não edite à mão.\n\n## wiki\n')).toBe(true);
    expect(generated.indexOf('## wiki')).toBeLessThan(generated.indexOf('## memory'));
    expect(generated).not.toContain('preferencia-usar-tabs');
    expect(generated).not.toContain('raw/');
    expect(generated).not.toContain('\r');
    expect(generated.endsWith('\n')).toBe(true);
  });

  it('mesma entrada, mesmos bytes, em qualquer ordem e sem depender de locale', () => {
    const entries: IndexEntry[] = [
      { path: 'wiki/entities/Zebra.md', type: 'entity' },
      { path: 'wiki/entities/Ábaco.md', type: 'entity' },
      { path: 'wiki/entities/abacate.md', type: 'entity' },
      { path: 'wiki/entities/Banana.md', type: 'entity' },
      { path: 'wiki/concepts/Ética.md', type: 'concept' },
      { path: 'wiki/decisions/velha.md', type: 'decision', validUntil: '2026-01-01' },
      { path: 'memory/facts/fato.md', type: 'fact', validUntil: '2030-01-01' },
      { path: 'outra/x.md', type: 'concept' },
      { path: 'solta.md', type: 'concept' },
      { path: 'wiki/sem-tipo.md', type: null },
      { path: 'wiki/tipo-estranho.md', type: 'ideia' },
      { path: 'memory/_archive/velho.md', type: 'gotcha' },
    ];
    const options = { groupOrder: ['wiki', 'memory', 'raw'] };
    const out = renderIndexMd(entries, options);
    expect(renderIndexMd([...entries].reverse(), options)).toBe(out);
    expect(out).toBe(
      [
        '# Índice',
        '',
        'Catálogo gerado. Não edite à mão.',
        '',
        '## wiki',
        '- [[Ética]] · concept',
        // minúsculas e depois código de caractere: o acento vem depois do z, em qualquer máquina
        '- [[abacate]] · entity',
        '- [[Banana]] · entity',
        '- [[Zebra]] · entity',
        '- [[Ábaco]] · entity',
        '- [[velha]] · decision (vencida)',
        '',
        '## memory',
        '- [[fato]] · fact (vencido)',
        '',
        '## (raiz)',
        '- [[solta]] · concept',
        '',
        '## outra',
        '- [[x]] · concept',
        '',
      ].join('\n'),
    );
  });

  it('com asOf, só marca o que já venceu na data', () => {
    const entries: IndexEntry[] = [
      { path: 'memory/facts/a.md', type: 'fact', validUntil: '2026-01-01' },
      { path: 'memory/facts/b.md', type: 'fact', validUntil: '2030-01-01' },
    ];
    expect(lines(renderIndexMd(entries, { asOf: '2026-11-12' }))).toEqual([
      '- [[a]] · fact (vencido)',
      '- [[b]] · fact',
    ]);
  });

  it('nome repetido em pastas diferentes vira link por caminho, para não ser ambíguo', () => {
    const out = renderIndexMd([
      { path: 'wiki/concepts/Nota.md', type: 'concept' },
      { path: 'wiki/entities/nota.md', type: 'entity' },
      { path: 'wiki/entities/Única.md', type: 'entity' },
    ]);
    expect(lines(out)).toEqual([
      '- [[wiki/concepts/Nota]] · concept',
      '- [[wiki/entities/nota]] · entity',
      '- [[Única]] · entity',
    ]);
  });

  it('caminho em NFD e repetido conta uma vez só', () => {
    const out = renderIndexMd([
      { path: 'wiki/Reunião.md'.normalize('NFD'), type: 'source' },
      { path: 'wiki/Reunião.md', type: 'source' },
    ]);
    expect(lines(out)).toEqual(['- [[Reunião]] · source']);
  });
});

describe('writeIndexMd', () => {
  it('grava e não regrava o mesmo conteúdo', async () => {
    temp = await makeTempDir('catalog');
    const config = { indexMd: 'index.md' };
    const content = renderIndexMd([{ path: 'wiki/a.md', type: 'concept' }]);
    expect(await writeIndexMd(temp.root, config, content)).toBe(true);
    expect(await readText(temp.root, 'index.md')).toBe(content);
    expect(await writeIndexMd(temp.root, config, content)).toBe(false);
    await expect(writeIndexMd(temp.root, { indexMd: '../fora.md' }, content)).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });
});

describe('log.md', () => {
  it('formata a linha como no diário do exemplo', () => {
    expect(formatLogLine({ action: 'add', type: 'handoff', title: 'Atlas, consumidores', date: '2026-11-10' })).toBe(
      '- 2026-11-10 · add handoff: Atlas, consumidores',
    );
    expect(formatLogLine({ action: 'edit', title: 'várias\nlinhas', date: new Date(2026, 10, 12, 23, 59) })).toBe(
      '- 2026-11-12 · edit: várias linhas',
    );
  });

  it('acrescenta ao fim, sem mexer no que já está lá', async () => {
    temp = await copyFixture('catalog');
    const before = await readText(temp.root, LOG_MD);
    const line = await appendLogLine(temp.root, {
      action: 'add',
      type: 'gotcha',
      title: 'Fila trava com mensagens grandes',
      date: '2026-11-12',
    });
    expect(line).toBe('- 2026-11-12 · add gotcha: Fila trava com mensagens grandes');
    expect(await readText(temp.root, LOG_MD)).toBe(`${before}${line}\n`);
  });

  it('cria o arquivo com o título, completa a quebra final que falta e mantém CRLF', async () => {
    temp = await makeTempDir('catalog');
    await appendLogLine(temp.root, { action: 'add', type: 'concept', title: 'A', date: '2026-11-12' });
    expect(await readText(temp.root, LOG_MD)).toBe('# Diário\n\n- 2026-11-12 · add concept: A\n');

    await writeText(temp.root, LOG_MD, toCrlf('# Diário\n\n- 2026-11-11 · add concept: B'));
    await appendLogLine(temp.root, { action: 'update', type: 'concept', title: 'B', date: '2026-11-12' });
    expect(await readText(temp.root, LOG_MD)).toBe(
      toCrlf('# Diário\n\n- 2026-11-11 · add concept: B\n- 2026-11-12 · update concept: B\n'),
    );
  });

  it('acréscimos simultâneos no mesmo processo não perdem linha', async () => {
    temp = await copyFixture('catalog');
    const titles = Array.from({ length: 20 }, (_, i) => `nota ${i}`);
    await Promise.all(
      titles.map((title) =>
        appendLogLine(temp?.root ?? '', { action: 'add', type: 'fact', title, date: '2026-11-12' }),
      ),
    );
    const text = await readText(temp.root, LOG_MD);
    for (const title of titles) expect(text).toContain(`add fact: ${title}\n`);
  });
});
