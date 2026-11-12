import { afterEach, describe, expect, it } from 'vitest';
import { listConflicts, parseConflictCopyPath } from '../../src/sync/index.ts';
import {
  contentKept,
  createWorld,
  exists,
  git,
  head,
  leftovers,
  type Machine,
  note,
  read,
  remove,
  TEST_TIMEOUT_MS,
  type World,
  write,
} from './helpers.ts';

let world: World | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

async function pair(): Promise<{ a: Machine; b: Machine }> {
  const created = await createWorld();
  world = created.world;
  const b = await world.clone('b');
  return { a: created.a, b };
}

const BASE = note('Nota X');
const edit = (text: string, from: string, to: string): string => {
  if (!text.includes(from)) throw new Error(`trecho ausente: ${from}`);
  return text.replace(from, to);
};

describe('syncBrain: conflitos', { timeout: TEST_TIMEOUT_MS }, () => {
  it('mesma nota, regiões diferentes (frontmatter × corpo): mescla sozinha, sem cópia', async () => {
    const { a, b } = await pair();
    write(a.dir, 'wiki/x.md', edit(BASE, 'tags: [a]', 'tags: [a, novo]'));
    await a.sync();
    write(b.dir, 'wiki/x.md', edit(BASE, 'Terceiro parágrafo original.', 'Terceiro parágrafo editado por B.'));
    const rb = await b.sync();
    expect(rb).toMatchObject({ status: 'ok', conflicts: [], integration: 'replay' });
    const merged = read(b.dir, 'wiki/x.md');
    expect(merged).toContain('tags: [a, novo]');
    expect(merged).toContain('Terceiro parágrafo editado por B.');
    await a.sync();
    expect(read(a.dir, 'wiki/x.md')).toBe(merged);
    expect(await listConflicts(b.dir)).toEqual([]);
  });

  it('mesma nota, mesma região: nota.md fica com a versão remota e a local vira cópia, byte a byte', async () => {
    const { a, b } = await pair();
    const va = edit(BASE, 'Segundo parágrafo original.', 'Segundo parágrafo editado por A.');
    const vb = edit(
      BASE,
      'Segundo parágrafo original.',
      'Segundo parágrafo editado por B.\r\ncom CRLF e acentuação: ção',
    );
    write(a.dir, 'wiki/x.md', va);
    await a.sync();
    write(b.dir, 'wiki/x.md', vb);
    write(b.dir, 'wiki/so-b.md', note('Só B'));
    const now = new Date(2026, 10, 12, 14, 32, 10);
    const rb = await b.sync({ now: () => now });
    expect(rb.status).toBe('ok');
    expect(rb.integration).toBe('merge');
    expect(rb.conflicts).toEqual([
      { path: 'wiki/x.md', kind: 'content', copy: 'wiki/x.conflict-b-20261112-143210.md' },
    ]);
    expect(read(b.dir, 'wiki/x.md')).toBe(va);
    expect(read(b.dir, 'wiki/x.conflict-b-20261112-143210.md')).toBe(vb);
    expect(read(b.dir, 'wiki/x.md')).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(exists(b.dir, 'wiki/so-b.md')).toBe(true);
    expect(rb.message).toMatch(/1 conflito preservado/);
    // merge com dois pais: o commit local continua no histórico
    expect((await git(b.dir, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ')).toHaveLength(3);
    const message = await git(b.dir, ['log', '-1', '--format=%B']);
    expect(message).toContain('conflict: 1 nota com conflito preservado');
    expect(message).toContain(
      '- wiki/x.md: editada nas duas máquinas; a versão daqui está em wiki/x.conflict-b-20261112-143210.md',
    );
    expect(await leftovers(b.dir)).toEqual([]);

    const ra = await a.sync();
    expect(ra.integration).toBe('fast-forward');
    expect(read(a.dir, 'wiki/x.conflict-b-20261112-143210.md')).toBe(vb);
    expect(await head(a.dir)).toBe(await head(b.dir));
    expect(await listConflicts(a.dir)).toEqual([
      {
        copy: 'wiki/x.conflict-b-20261112-143210.md',
        original: 'wiki/x.md',
        originalExists: true,
        machine: 'b',
        date: '2026-11-12T14:32:10',
      },
    ]);
  });

  it('linhas vizinhas do frontmatter editadas em máquinas diferentes contam como conflito', async () => {
    const { a, b } = await pair();
    const va = edit(BASE, 'tags: [a]', 'tags: [a, a2]');
    const vb = edit(BASE, 'status: rascunho', 'status: final');
    write(a.dir, 'wiki/x.md', va);
    await a.sync();
    write(b.dir, 'wiki/x.md', vb);
    const rb = await b.sync();
    expect(rb.conflicts).toHaveLength(1);
    expect(rb.conflicts[0]?.kind).toBe('content');
    expect(read(b.dir, 'wiki/x.md')).toBe(va);
    expect(read(b.dir, rb.conflicts[0]?.copy ?? '')).toBe(vb);
  });

  it('a mesma edição nas duas máquinas não é conflito', async () => {
    const { a, b } = await pair();
    const same = edit(BASE, 'Primeiro parágrafo original.', 'Mesma edição.');
    write(a.dir, 'wiki/x.md', same);
    write(b.dir, 'wiki/x.md', same);
    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toEqual([]);
    expect(read(b.dir, 'wiki/x.md')).toBe(same);
  });

  it('editada de um lado e apagada do outro: a edição vence, nos dois sentidos', async () => {
    const { a, b } = await pair();
    const edited = edit(BASE, 'Primeiro parágrafo original.', 'A editou x.');
    write(a.dir, 'wiki/x.md', edited);
    await a.sync();
    remove(b.dir, 'wiki/x.md');
    const rb = await b.sync();
    expect(rb.status).toBe('ok');
    expect(rb.conflicts).toEqual([{ path: 'wiki/x.md', kind: 'delete', kept: 'remote' }]);
    expect(read(b.dir, 'wiki/x.md')).toBe(edited);

    await a.sync();
    remove(a.dir, 'wiki/y.md');
    await a.sync();
    const yb = `${read(b.dir, 'wiki/y.md')}\nB editou y.\n`;
    write(b.dir, 'wiki/y.md', yb);
    const rb2 = await b.sync();
    expect(rb2.conflicts).toEqual([{ path: 'wiki/y.md', kind: 'delete', kept: 'local' }]);
    expect(read(b.dir, 'wiki/y.md')).toBe(yb);
    await a.sync();
    expect(read(a.dir, 'wiki/y.md')).toBe(yb);
    expect(await head(a.dir)).toBe(await head(b.dir));
  });

  it('três commits locais na mesma nota contra uma edição remota: uma cópia só, com a última versão local', async () => {
    const { a, b } = await pair();
    const va = edit(BASE, 'Segundo', 'SEGUNDO (A)');
    write(a.dir, 'wiki/x.md', va);
    await a.sync();
    for (let i = 1; i <= 3; i++) {
      write(b.dir, 'wiki/x.md', edit(BASE, 'Segundo', `Segundo (B v${i})`));
      await git(b.dir, ['commit', '--quiet', '-am', `B v${i}`]);
    }
    const rb = await b.sync();
    expect(rb.conflicts).toHaveLength(1);
    const copies = [...(await listConflicts(b.dir))];
    expect(copies).toHaveLength(1);
    expect(read(b.dir, copies[0]?.copy ?? '')).toBe(edit(BASE, 'Segundo', 'Segundo (B v3)'));
    expect(read(b.dir, 'wiki/x.md')).toBe(va);
  });

  it('conflito de novo na mesma nota no mesmo segundo: a segunda cópia ganha outro nome', async () => {
    const { a, b } = await pair();
    const now = new Date(2026, 10, 12, 9, 0, 0);
    for (const round of [1, 2]) {
      write(a.dir, 'wiki/x.md', edit(read(a.dir, 'wiki/x.md'), 'Segundo parágrafo', `Segundo parágrafo A${round}`));
      await a.sync();
      write(b.dir, 'wiki/x.md', edit(read(b.dir, 'wiki/x.md'), 'Segundo parágrafo', `Segundo parágrafo B${round}`));
      const rb = await b.sync({ now: () => now });
      expect(rb.conflicts).toHaveLength(1);
      await a.sync();
    }
    const copies = (await listConflicts(a.dir)).map((c) => c.copy);
    expect(copies).toEqual(['wiki/x.conflict-b-20261112-090000-2.md', 'wiki/x.conflict-b-20261112-090000.md']);
    expect(parseConflictCopyPath('wiki/x.conflict-b-20261112-090000-2.md')?.original).toBe('wiki/x.md');
  });

  it('arquivo editado DURANTE o sync, na nota que a integração muda: não é sobrescrito; o sync commita e refaz', async () => {
    const { a, b } = await pair();
    write(a.dir, 'wiki/x.md', edit(BASE, 'Terceiro parágrafo original.', 'Terceiro parágrafo de A.'));
    await a.sync();
    write(b.dir, 'wiki/outra.md', note('Outra'));
    const live = `${BASE}\nusuário digitando no Obsidian durante o sync\n`;
    let fired = false;
    const rb = await b.sync({
      faultAt: (step) => {
        if (step === 'journaled' && !fired) {
          fired = true;
          write(b.dir, 'wiki/x.md', live);
        }
      },
    });
    expect(fired).toBe(true);
    expect(rb.status).toBe('ok');
    expect(rb.attempts).toBe(2);
    // a linha nova encosta na linha que A mudou: conflito; a versão digitada fica inteira na cópia
    expect(rb.conflicts).toHaveLength(1);
    expect(read(b.dir, 'wiki/x.md')).toContain('Terceiro parágrafo de A.');
    expect(read(b.dir, rb.conflicts[0]?.copy ?? '')).toBe(live);
    expect(exists(b.dir, 'wiki/outra.md')).toBe(true);
    expect(await leftovers(b.dir)).toEqual([]);
    await a.sync();
    expect(contentKept(a.dir, live)).toBe(true);
  });

  it('arquivo editado DURANTE o sync, numa nota que a integração não muda: fica como está para o próximo sync', async () => {
    const { a, b } = await pair();
    write(a.dir, 'wiki/x.md', edit(BASE, 'Terceiro parágrafo original.', 'Terceiro parágrafo de A.'));
    await a.sync();
    const live = `${read(b.dir, 'wiki/y.md')}\nsalvo no meio do sync\n`;
    const rb = await b.sync({
      faultAt: (step) => {
        if (step === 'journaled') write(b.dir, 'wiki/y.md', live);
      },
    });
    expect(rb).toMatchObject({ status: 'ok', attempts: 1 });
    expect(read(b.dir, 'wiki/y.md')).toBe(live);
    expect(read(b.dir, 'wiki/x.md')).toContain('Terceiro parágrafo de A.');
    const next = await b.sync();
    expect(next).toMatchObject({ status: 'ok', committed: 1, pushed: 1 });
    await a.sync();
    expect(read(a.dir, 'wiki/y.md')).toBe(live);
  });

  it('anexo binário editado nas duas máquinas: as duas versões ficam', async () => {
    const { a, b } = await pair();
    const pa = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xaa, 0xff, 0x01]);
    const pb = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xbb, 0xfe, 0x02]);
    write(a.dir, 'wiki/figura.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    await a.sync();
    await b.sync();
    write(a.dir, 'wiki/figura.png', pa);
    await a.sync();
    write(b.dir, 'wiki/figura.png', pb);
    const rb = await b.sync({ now: () => new Date(2026, 0, 2, 3, 4, 5) });
    expect(rb.conflicts).toEqual([
      { path: 'wiki/figura.png', kind: 'content', copy: 'wiki/figura.conflict-b-20260102-030405.png' },
    ]);
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readFileSync(join(b.dir, 'wiki', 'figura.png')).equals(pa)).toBe(true);
    expect(readFileSync(join(b.dir, 'wiki', 'figura.conflict-b-20260102-030405.png')).equals(pb)).toBe(true);
    expect(contentKept(b.dir, note('Nota Y'))).toBe(true);
  });
});
