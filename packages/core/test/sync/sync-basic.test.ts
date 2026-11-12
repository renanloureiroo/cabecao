import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommitTrailers } from '../../src/git/index.ts';
import type { SyncChange } from '../../src/sync/index.ts';
import {
  configureLocal,
  contentKept,
  createWorld,
  exists,
  git,
  head,
  leftovers,
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

describe('syncBrain: conteúdo entre duas máquinas', { timeout: TEST_TIMEOUT_MS }, () => {
  it('nada mudou: não cria commit, não envia, e é rápido', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');
    expect((await b.sync()).status).toBe('ok');
    const before = await head(a.dir);
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await a.sync());
    for (const result of runs) {
      expect(result).toMatchObject({
        status: 'ok',
        pulled: 0,
        pushed: 0,
        committed: 0,
        attempts: 1,
        integration: 'none',
      });
      expect(result.changedPaths).toEqual([]);
      expect(result.message).toMatch(/Nada a sincronizar/);
    }
    expect(await head(a.dir)).toBe(before);
    expect(await leftovers(a.dir)).toEqual([]);
    console.info(`[tempo] sync sem mudanças: ${runs.map((r) => r.ms).join(' ms, ')} ms`);
  });

  it('edições só de um lado: commit "edit" no padrão do doc 12, envio, e a outra máquina recebe por avanço simples', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');

    const edited = note('Nota X', '\nParágrafo novo de A.\n');
    write(a.dir, 'wiki/x.md', edited);
    write(a.dir, 'wiki/nova.md', note('Nota nova'));
    remove(a.dir, 'memory/z.md');
    const seen: SyncChange[] = [];
    const ra = await a.sync({ onApplied: (changes) => void seen.push(...changes) });
    expect(ra).toMatchObject({ status: 'ok', committed: 1, pushed: 1, pulled: 0, attempts: 1 });
    expect(ra.changedPaths).toEqual(['memory/z.md', 'wiki/nova.md', 'wiki/x.md']);
    expect(seen).toEqual(
      expect.arrayContaining([
        { path: 'wiki/x.md', change: 'modified', origin: 'local' },
        { path: 'wiki/nova.md', change: 'added', origin: 'local' },
        { path: 'memory/z.md', change: 'deleted', origin: 'local' },
      ]),
    );

    const message = await git(a.dir, ['log', '-1', '--format=%B']);
    expect(message).toMatch(
      /^vault backup: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\n\nedit: 3 notas alteradas fora do Cabeção\n- memory\/z\.md\n- wiki\/nova\.md\n- wiki\/x\.md\n\n/,
    );
    expect(parseCommitTrailers(message)).toMatchObject({ machine: 'a', client: 'manual' });
    expect(parseCommitTrailers(message).op).toMatch(/^[0-9A-Z]{26}$/);
    expect(parseCommitTrailers(message).session).toBeUndefined();
    // o catálogo entrou no mesmo commit, sem commit extra
    expect(await git(a.dir, ['show', '--name-only', '--format=', 'HEAD'])).toContain('index.md');
    expect(read(a.dir, 'index.md')).toContain('[[nova]]');
    expect(read(a.dir, 'index.md')).not.toContain('[[z]]');

    const rb = await b.sync();
    expect(rb).toMatchObject({ status: 'ok', pulled: 1, pushed: 0, committed: 0, integration: 'fast-forward' });
    expect(rb.changedPaths).toEqual(['index.md', 'memory/z.md', 'wiki/nova.md', 'wiki/x.md']);
    expect(read(b.dir, 'wiki/x.md')).toBe(edited);
    expect(exists(b.dir, 'memory/z.md')).toBe(false);
    expect(await head(b.dir)).toBe(await head(a.dir));
    expect(await leftovers(b.dir)).toEqual([]);
  });

  it('edições dos dois lados em notas diferentes: reaplicação linear, sem merge, nada perdido', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');

    const xa = note('Nota X', '\nde A\n');
    const yb = note('Nota Y', '\nde B\n');
    write(a.dir, 'wiki/x.md', xa);
    write(a.dir, 'wiki/so-a.md', note('Só A'));
    await a.sync();
    write(b.dir, 'wiki/y.md', yb);
    write(b.dir, 'memory/so-b.md', note('Só B'));
    const rb = await b.sync();
    expect(rb).toMatchObject({ status: 'ok', integration: 'replay', pulled: 1, pushed: 1, conflicts: [] });
    // histórico linear: nenhum commit com dois pais
    expect(await git(b.dir, ['rev-list', '--merges', 'HEAD'])).toBe('');
    // o commit reaplicado manteve os rodapés da máquina b
    expect(parseCommitTrailers(await git(b.dir, ['log', '-1', '--format=%B']))).toMatchObject({ machine: 'b' });
    await a.sync();
    for (const m of [a, b]) {
      expect(read(m.dir, 'wiki/x.md')).toBe(xa);
      expect(read(m.dir, 'wiki/y.md')).toBe(yb);
      expect(exists(m.dir, 'wiki/so-a.md') && exists(m.dir, 'memory/so-b.md')).toBe(true);
      expect(read(m.dir, 'index.md')).toMatch(/\[\[so-a\]\][\s\S]*\[\[so-b\]\]|\[\[so-b\]\][\s\S]*\[\[so-a\]\]/);
      expect(await leftovers(m.dir)).toEqual([]);
    }
    expect(await head(a.dir)).toBe(await head(b.dir));
  });

  it('renomear de um lado e editar a mesma nota do outro: a renomeação e a edição se juntam', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');

    const edited = read(a.dir, 'wiki/x.md').replace(
      'Terceiro parágrafo original.',
      'Terceiro parágrafo editado por A.',
    );
    write(a.dir, 'wiki/x.md', edited);
    await a.sync();
    write(b.dir, 'wiki/renomeada.md', read(b.dir, 'wiki/x.md'));
    remove(b.dir, 'wiki/x.md');
    const rb = await b.sync();
    expect(rb.status).toBe('ok');
    expect(rb.conflicts).toEqual([]);
    await a.sync();
    for (const m of [a, b]) {
      expect(exists(m.dir, 'wiki/x.md')).toBe(false);
      expect(read(m.dir, 'wiki/renomeada.md')).toBe(edited);
      expect(read(m.dir, 'index.md')).toContain('[[renomeada]]');
    }
    expect(await head(a.dir)).toBe(await head(b.dir));
  });

  it('log.md acrescentado nas duas máquinas: união de linhas, sem conflito, cada linha uma vez', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');
    const base = read(a.dir, 'log.md');
    for (let round = 1; round <= 3; round++) {
      write(a.dir, 'log.md', `${read(a.dir, 'log.md')}- 2026-11-1${round} · add fact: linha A${round}\n`);
      write(b.dir, 'log.md', `${read(b.dir, 'log.md')}- 2026-11-1${round} · add fact: linha B${round}\n`);
      expect((await a.sync()).status).toBe('ok');
      const rb = await b.sync();
      expect(rb.status).toBe('ok');
      expect(rb.conflicts).toEqual([]);
    }
    await a.sync();
    const final = read(a.dir, 'log.md');
    expect(final).toBe(read(b.dir, 'log.md'));
    expect(final.startsWith(base)).toBe(true);
    for (const id of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']) {
      expect(final.split('\n').filter((line) => line.endsWith(`linha ${id}`))).toHaveLength(1);
    }
    expect(final).not.toMatch(/<<<<<<<|>>>>>>>/);
  });

  it('log.md sem .gitattributes na pasta de trabalho: a união continua valendo', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');
    remove(b.dir, '.gitattributes');
    await git(b.dir, ['update-index', '--assume-unchanged', '.gitattributes']);
    write(a.dir, 'log.md', `${read(a.dir, 'log.md')}- linha A\n`);
    await a.sync();
    write(b.dir, 'log.md', `${read(b.dir, 'log.md')}- linha B\n`);
    const rb = await b.sync();
    expect(rb.status).toBe('ok');
    expect(rb.conflicts).toEqual([]);
    expect(read(b.dir, 'log.md')).toMatch(/- linha A\n- linha B\n$|- linha B\n- linha A\n$/);
  });

  it('commits do "Obsidian Git" (sem rodapés) convivem: integrados, catálogo regenerado, mensagens preservadas', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');

    // máquina b com o plugin: add -A, commit no estilo dele, pull --no-rebase, push; sem o Cabeção
    write(b.dir, 'wiki/do-plugin.md', note('Do plugin'));
    await git(b.dir, ['add', '-A']);
    await git(b.dir, ['commit', '--quiet', '-m', 'vault backup: 2026-11-12 10:00:00']);
    await git(b.dir, ['pull', '--quiet', '--no-rebase']);
    await git(b.dir, ['push', '--quiet']);

    // a máquina a recebe; o catálogo do commit do plugin estava velho e é regenerado num commit a mais
    write(a.dir, 'wiki/de-a.md', note('De A'));
    const ra = await a.sync();
    expect(ra.status).toBe('ok');
    expect(read(a.dir, 'index.md')).toContain('[[do-plugin]]');
    expect(read(a.dir, 'index.md')).toContain('[[de-a]]');
    expect(await git(a.dir, ['log', '--format=%s', '-n', '5'])).toContain('vault backup: 2026-11-12 10:00:00');

    // de novo no plugin, agora com um commit local não enviado; o sync do Cabeção na mesma máquina o reaplica
    write(b.dir, 'wiki/outra-do-plugin.md', note('Outra do plugin'));
    await git(b.dir, ['add', '-A']);
    await git(b.dir, ['commit', '--quiet', '-m', 'vault backup: 2026-11-12 11:00:00']);
    const rb = await b.sync();
    expect(rb.status).toBe('ok');
    expect(await git(b.dir, ['log', '--format=%s', '-n', '3'])).toContain('vault backup: 2026-11-12 11:00:00');
    await a.sync();
    for (const m of [a, b]) {
      for (const n of ['do-plugin', 'de-a', 'outra-do-plugin']) expect(read(m.dir, 'index.md')).toContain(`[[${n}]]`);
      expect(await leftovers(m.dir)).toEqual([]);
    }
    expect(await head(a.dir)).toBe(await head(b.dir));
  });

  it('o commit de edições respeita noteDirs e .gitignore e ignora temporários da escrita atômica', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    write(a.dir, 'wiki/ok.md', note('Ok'));
    write(a.dir, 'wiki/imagem.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    write(a.dir, 'fora/solto.md', 'fora das pastas de notas\n');
    write(a.dir, '.obsidian/workspace.json', '{}\n');
    write(a.dir, 'wiki/.cabecao-999999-abcdef.tmp', 'temporário de um processo morto');
    // PID deste processo de teste: vivo em qualquer sistema
    write(a.dir, `wiki/.cabecao-${process.pid}-abcdef.tmp`, 'temporário de um processo vivo');
    write(a.dir, '.gitignore', '.cabecao/\nwiki/ignorado.md\n');
    write(a.dir, 'wiki/ignorado.md', note('Ignorado'));
    const ra = await a.sync();
    expect(ra.status).toBe('ok');
    const committed = (await git(a.dir, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort();
    expect(committed).toEqual(['.gitignore', 'index.md', 'wiki/imagem.png', 'wiki/ok.md']);
    expect(await git(a.dir, ['log', '-1', '--format=%B'])).toContain('edit: 3 arquivos alterados fora do Cabeção');
    expect(exists(a.dir, 'fora/solto.md') && exists(a.dir, '.obsidian/workspace.json')).toBe(true);
    // o temporário de processo morto (PID inexistente) some; o de um processo vivo fica, e nenhum entra no commit
    expect(exists(a.dir, 'wiki/.cabecao-999999-abcdef.tmp')).toBe(false);
    expect(ra.recovered?.join(' ')).toContain('.cabecao-999999-abcdef.tmp');
    expect(exists(a.dir, `wiki/.cabecao-${process.pid}-abcdef.tmp`)).toBe(true);
    expect(await git(a.dir, ['status', '--porcelain', '--', 'wiki'])).toBe(
      `?? wiki/.cabecao-${process.pid}-abcdef.tmp`,
    );
  });

  it('cinco notas alteradas: tempo medido', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');
    for (let i = 1; i <= 5; i++) write(a.dir, `wiki/n${i}.md`, note(`Nota ${i}`, `\nconteúdo ${i}\n`));
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'ok', pushed: 1 });
    const rb = await b.sync();
    expect(rb).toMatchObject({ status: 'ok', pulled: 1 });
    for (let i = 1; i <= 5; i++) expect(contentKept(b.dir, note(`Nota ${i}`, `\nconteúdo ${i}\n`))).toBe(true);
    console.info(`[tempo] cinco notas: envio ${ra.ms} ms, recebimento ${rb.ms} ms`);
  });

  it('branch principal com outro nome (trunk): nada é assumido', async () => {
    const created = await createWorld({ branch: 'trunk' });
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');
    write(b.dir, 'wiki/em-trunk.md', note('Em trunk'));
    const rb = await b.sync();
    expect(rb).toMatchObject({ status: 'ok', branch: 'trunk', remote: 'origin', pushed: 1 });
    expect(await git(world.remote, ['branch', '--list'])).not.toContain('main');
    await a.sync();
    expect(exists(a.dir, 'wiki/em-trunk.md')).toBe(true);
  });
  it('HEAD solto ou operação do git pela metade (de outro cliente): bloqueia sem mexer no conteúdo', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    write(a.dir, 'wiki/pendente.md', note('Pendente'));
    write(a.dir, '.git/MERGE_HEAD', `${await head(a.dir)}\n`);
    const merging = await a.sync();
    expect(merging).toMatchObject({ status: 'blocked', reason: 'git-operation', committed: 0 });
    expect(merging.message).toContain('MERGE_HEAD');
    remove(a.dir, '.git/MERGE_HEAD');

    await git(a.dir, ['checkout', '--quiet', '--detach']);
    const detached = await a.sync();
    expect(detached).toMatchObject({ status: 'blocked', reason: 'detached-head', branch: null });
    await git(a.dir, ['checkout', '--quiet', 'main']);
    expect(await git(a.dir, ['status', '--porcelain', '--', 'wiki'])).toBe('?? wiki/pendente.md');
    expect(await a.sync()).toMatchObject({ status: 'ok', committed: 1, pushed: 1 });
  });

  it('branch local ainda sem commits e nada pendente: recebe o remoto inteiro', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const dir = join(world.root, 'c');
    mkdirSync(dir);
    await git(dir, ['-c', 'init.defaultBranch=main', 'init', '--quiet', '--initial-branch=main']);
    configureLocal(dir);
    await git(dir, ['remote', 'add', 'origin', world.remote]);
    // a configuração do cérebro existe mas fica fora do git só nesta máquina: não há o que commitar
    write(dir, '.cabecao.json', read(a.dir, '.cabecao.json'));
    write(dir, '.git/info/exclude', '.cabecao.json\n.cabecao/\n');
    const rc = await world.machine('c', dir).sync();
    expect(rc).toMatchObject({ status: 'ok', integration: 'fast-forward', committed: 0 });
    expect(read(dir, 'wiki/x.md')).toBe(read(a.dir, 'wiki/x.md'));
    expect(await head(dir)).toBe(await head(a.dir));
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
  });
});
