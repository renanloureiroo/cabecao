import { readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNC_STEPS } from '../../src/sync/index.ts';
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
  spawnSyncChild,
  TEST_TIMEOUT_MS,
  type World,
  waitChild,
  write,
} from './helpers.ts';

/** O que uma rodada criou e que tem de sobreviver a qualquer interrupção. */
interface Round {
  readonly va: string;
  readonly vb: string;
  readonly soA: string;
  readonly soB: string;
  readonly logLine: string;
}

async function pair(): Promise<{ world: World; a: Machine; b: Machine }> {
  const { world, a } = await createWorld();
  const b = await world.clone('b');
  return { world, a, b };
}

/**
 * Uma rodada de divergência com tudo que um sync faz: A envia uma edição em x.md e uma nota nova; B fica, sem
 * commit, com uma edição conflitante em x.md, outra nota nova e uma linha no diário. O sync seguinte de B passa
 * por todos os passos: commit, fetch, merge com cópia de conflito, diário, aplicação e envio.
 */
async function diverge(a: Machine, b: Machine, id: string): Promise<Round> {
  const base = read(a.dir, 'wiki/x.md');
  const round: Round = {
    va: base.replace(/Segundo parágrafo.*\n/, `Segundo parágrafo de A na rodada ${id}.\n`),
    vb: base.replace(/Segundo parágrafo.*\n/, `Segundo parágrafo de B na rodada ${id}.\n`),
    soA: note(`Só A ${id}`),
    soB: note(`Só B ${id}`),
    logLine: `- 2026-11-12 · add fact: linha de B na rodada ${id}`,
  };
  write(a.dir, 'wiki/x.md', round.va);
  write(a.dir, `wiki/so-a-${id}.md`, round.soA);
  expect((await a.sync()).status).toBe('ok');
  write(b.dir, 'wiki/x.md', round.vb);
  write(b.dir, `wiki/so-b-${id}.md`, round.soB);
  write(b.dir, 'log.md', `${read(b.dir, 'log.md')}${round.logLine}\n`);
  return round;
}

/** Depois de uma interrupção: o próximo sync conclui, nada se perde e as duas máquinas convergem. */
async function expectRecovered(a: Machine, b: Machine, id: string, round: Round): Promise<void> {
  const rb = await b.sync();
  expect(rb.status, `${id}: ${rb.message}`).toBe('ok');
  expect(await leftovers(b.dir), id).toEqual([]);
  expect((await a.sync()).status, id).toBe('ok');
  for (const m of [b, a]) {
    expect(read(m.dir, 'wiki/x.md'), id).toBe(round.va);
    expect(contentKept(m.dir, round.vb), `${id}: versão de B`).toBe(true);
    expect(read(m.dir, `wiki/so-a-${id}.md`), id).toBe(round.soA);
    expect(read(m.dir, `wiki/so-b-${id}.md`), id).toBe(round.soB);
    expect(read(m.dir, 'log.md'), id).toContain(round.logLine);
    expect(read(m.dir, 'index.md'), id).toContain(`[[so-b-${id}]]`);
  }
  expect(await head(a.dir), id).toBe(await head(b.dir));
}

function readJournal(dir: string): { from: string; to: string } {
  return JSON.parse(readFileSync(join(dir, '.cabecao', 'sync', 'journal.json'), 'utf8')) as {
    from: string;
    to: string;
  };
}

describe.concurrent('syncBrain: morte súbita e recuperação', { timeout: TEST_TIMEOUT_MS * 2 }, () => {
  it('processo morto (SIGKILL) em cada passo: o sync seguinte se recupera sozinho, sem perder nota', async ({
    onTestFinished,
  }) => {
    const { world, a, b } = await pair();
    onTestFinished(() => world.cleanup());
    for (const step of SYNC_STEPS) {
      const round = await diverge(a, b, `k-${step}`);
      const child = await waitChild(spawnSyncChild([b.dir, 'b', step]));
      expect(child.stdout, `${step}: ${child.stderr}`).toContain(`morrendo em ${step}`);
      expect(child.stdout, step).not.toContain('RESULTADO');
      await expectRecovered(a, b, `k-${step}`, round);
    }
    expect(await git(b.dir, ['fsck', '--no-progress', '--no-dangling'])).toBe('');
    expect(await git(world.remote, ['fsck', '--no-progress', '--no-dangling'])).toBe('');
  });

  it('sync abortado (exceção) em cada passo: a trava é solta e o sync seguinte conclui', async ({ onTestFinished }) => {
    const { world, a, b } = await pair();
    onTestFinished(() => world.cleanup());
    for (const step of SYNC_STEPS) {
      const round = await diverge(a, b, `t-${step}`);
      const aborted = await b.sync({
        faultAt: (current) => {
          if (current === step) throw new Error(`falha simulada em ${current}`);
        },
      });
      expect(aborted.status, step).toBe('error');
      expect(aborted.message, step).toContain(`falha simulada em ${step}`);
      expect(exists(b.dir, '.cabecao/locks/sync.lock'), step).toBe(false);
      await expectRecovered(a, b, `t-${step}`, round);
    }
  });

  it('git morto no meio do reset: arquivos já trocados voltam à origem e nada vira "edição" falsa', async ({
    onTestFinished,
  }) => {
    const { world, a, b } = await pair();
    onTestFinished(() => world.cleanup());
    const round = await diverge(a, b, 'parcial');
    const aborted = await b.sync({
      faultAt: (step) => {
        if (step === 'journaled') throw new Error('morte simulada antes do reset');
      },
    });
    expect(aborted.status).toBe('error');
    const journal = readJournal(b.dir);
    // o reset começou a escrever: x.md já tem a versão remota, mas a cópia de conflito ainda não foi criada. Sem a
    // recuperação, a versão de B sumiria da pasta de trabalho (ficaria só no histórico).
    write(b.dir, 'wiki/x.md', `${await git(b.dir, ['cat-file', 'blob', `${journal.to}:wiki/x.md`])}\n`);
    expect(read(b.dir, 'wiki/x.md')).toBe(round.va);
    const rb = await b.sync();
    expect(rb.status).toBe('ok');
    expect(rb.recovered?.join(' ')).toMatch(/voltaram à versão anterior/);
    // nenhum commit "edit" de B com a versão remota disfarçada de edição local
    const messages = await git(b.dir, ['log', '--format=%B%x00', `${journal.from}..HEAD`]);
    expect(messages.split('\0').filter((m) => /^edit:/m.test(m) && /Cabecao-Machine: b/.test(m))).toEqual([]);
    await expectRecovered(a, b, 'parcial', round);
  });

  it('índice já gravado e HEAD para trás: a recuperação só avança a branch', async ({ onTestFinished }) => {
    const { world, a, b } = await pair();
    onTestFinished(() => world.cleanup());
    const round = await diverge(a, b, 'indice');
    await b.sync({
      faultAt: (step) => {
        if (step === 'journaled') throw new Error('morte simulada');
      },
    });
    // o git atualizou índice e arquivos, e morreu antes de mover a branch
    await git(b.dir, ['read-tree', '-m', '-u', 'HEAD', readJournal(b.dir).to]);
    const rb = await b.sync();
    expect(rb.status).toBe('ok');
    expect(rb.recovered?.join(' ')).toMatch(/a branch avançou/);
    await expectRecovered(a, b, 'indice', round);
  });

  it('index.lock órfão do git: removido depois do limite de idade, e o sync conclui', async ({ onTestFinished }) => {
    const { world, a, b } = await pair();
    onTestFinished(() => world.cleanup());
    const round = await diverge(a, b, 'lock');
    write(b.dir, '.git/index.lock', '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(b.dir, '.git', 'index.lock'), old, old);
    await expectRecovered(a, b, 'lock', round);
  });
});
