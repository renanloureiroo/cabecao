import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncStatus } from '../../src/sync/index.ts';
import { fake } from '../security/corpus.ts';
import { deadPid } from '../util/helpers.ts';
import {
  contentKept,
  createWorld,
  exists,
  git,
  head,
  leftovers,
  note,
  read,
  TEST_TIMEOUT_MS,
  type World,
  write,
} from './helpers.ts';

let world: World | undefined;
const servers: Server[] = [];
afterEach(async () => {
  world?.cleanup();
  world = undefined;
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Token falso montado em tempo de execução (nunca aparece inteiro no código). */
const FAKE_TOKEN = `ghp_${fake(BASE62, 36, 4242)}`;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

describe('syncBrain: remoto, travas e segredos', { timeout: TEST_TIMEOUT_MS }, () => {
  it('envio recusado por corrida: volta ao fetch, integra e envia na segunda tentativa', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');
    write(a.dir, 'wiki/de-a.md', note('De A'));
    write(b.dir, 'wiki/de-b.md', note('De B'));
    let raced = false;
    const rb = await b.sync({
      faultAt: async (step) => {
        // A envia entre o fetch e o envio de B
        if (step === 'integrated' && !raced) {
          raced = true;
          expect((await a.sync()).status).toBe('ok');
        }
      },
    });
    expect(raced).toBe(true);
    expect(rb).toMatchObject({ status: 'ok', attempts: 2, pushed: 1 });
    await a.sync();
    for (const m of [a, b]) {
      expect(exists(m.dir, 'wiki/de-a.md') && exists(m.dir, 'wiki/de-b.md')).toBe(true);
      expect(await leftovers(m.dir)).toEqual([]);
    }
    expect(await head(a.dir)).toBe(await head(b.dir));
  });

  it('remoto que muda a cada tentativa: desiste no limite, com erro claro e nada perdido', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const b = await world.clone('b');
    write(b.dir, 'wiki/de-b.md', note('De B'));
    let round = 0;
    const rb = await b.sync({
      maxAttempts: 3,
      faultAt: async (step) => {
        if (step !== 'integrated') return;
        round++;
        write(a.dir, `wiki/a${round}.md`, note(`A ${round}`));
        await a.sync();
      },
    });
    expect(rb).toMatchObject({ status: 'error', attempts: 3 });
    expect(rb.message).toMatch(/Desisti depois de 3 tentativas: outra máquina enviou antes/);
    expect(read(b.dir, 'wiki/de-b.md')).toBe(note('De B'));
    const next = await b.sync();
    expect(next.status).toBe('ok');
    await a.sync();
    expect(exists(a.dir, 'wiki/de-b.md')).toBe(true);
  });

  it('sem remoto configurado: sync só local, com os commits pendentes, sem erro', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    await git(a.dir, ['remote', 'remove', 'origin']);
    write(a.dir, 'wiki/local.md', note('Local'));
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'ok', remote: null, committed: 1, pushed: 0 });
    expect(ra.message).toMatch(/Sem remoto configurado/);
    expect(await git(a.dir, ['status', '--porcelain'])).toBe('');
  });

  it('remoto vazio (sem a branch ainda): o primeiro envio cria a branch com todo o histórico', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const empty = join(world.root, 'vazio.git');
    await git(world.root, ['init', '--bare', '--quiet', '--initial-branch=main', empty]);
    await git(a.dir, ['remote', 'set-url', 'origin', empty]);
    const total = Number(await git(a.dir, ['rev-list', '--count', 'HEAD']));
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'ok', pushed: total, pulled: 0 });
    expect(await git(empty, ['rev-parse', 'main'])).toBe(await head(a.dir));
  });

  it('remoto inexistente: offline com categoria not-found, rápido, e as edições ficam num commit local', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    await git(a.dir, ['remote', 'set-url', 'origin', join(world.root, 'nao-existe.git')]);
    write(a.dir, 'wiki/local.md', note('Local'));
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'offline', committed: 1, pushed: 0 });
    expect(ra.remoteError?.category).toBe('not-found');
    expect(ra.message).toMatch(/não foi encontrado/);
    expect(ra.ms).toBeLessThan(10_000);
    // o remoto volta: tudo vai de uma vez
    await git(a.dir, ['remote', 'set-url', 'origin', world.remote]);
    expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });
  });

  it('remoto http que pede senha: auth em tempo curto, sem ficar esperando, sem credencial no resultado', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const port = await listen((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cabecao"' });
      res.end('auth');
    });
    await git(a.dir, ['remote', 'set-url', 'origin', `http://usuario:senha123@127.0.0.1:${port}/cerebro.git`]);
    const ra = await a.sync({ networkTimeoutMs: 15_000 });
    expect(ra.status).toBe('offline');
    expect(ra.remoteError?.category).toBe('auth');
    expect(ra.ms).toBeLessThan(10_000);
    expect(JSON.stringify(ra)).not.toContain('senha123');
    expect((await syncStatus(a.dir)).remote?.url).not.toContain('senha123');
  });

  it('remoto em porta fechada: network', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const port = await listen(() => {});
    await new Promise((done) => servers.pop()?.close(done));
    await git(a.dir, ['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/cerebro.git`]);
    const ra = await a.sync();
    expect(ra.status).toBe('offline');
    expect(ra.remoteError?.category).toBe('network');
  });

  it('servidor sem suporte a envio atômico: o caminho alternativo envia', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    await git(world.remote, ['config', 'receive.advertiseAtomic', 'false']);
    write(a.dir, 'wiki/sem-atomic.md', note('Sem atomic'));
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'ok', pushed: 1 });
    expect(await git(world.remote, ['rev-parse', 'main'])).toBe(await head(a.dir));
  });

  it('trava ocupada: responde busy na hora, sem erro e sem mexer em nada', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    write(a.dir, 'wiki/pendente.md', note('Pendente'));
    const lock = join(a.dir, '.cabecao', 'locks', 'sync.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token: 'outro' }));
    const ra = await a.sync();
    expect(ra.status).toBe('busy');
    expect(ra.message).toMatch(/Outro sync já está em andamento \(processo \d+\)/);
    expect(await git(a.dir, ['status', '--porcelain', '--', 'wiki'])).toBe('?? wiki/pendente.md');
    expect((await syncStatus(a.dir)).running).toBe(true);
  });

  it('trava órfã (processo que não existe mais): é tomada e o sync segue', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    write(a.dir, 'wiki/pendente.md', note('Pendente'));
    const lock = join(a.dir, '.cabecao', 'locks', 'sync.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999_999, host: hostname(), at: Date.now() - 1000, token: 'morto' }));
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'ok', committed: 1, pushed: 1 });
    expect(exists(a.dir, '.cabecao/locks/sync.lock')).toBe(false);
  });

  it('trava órfã com o prazo já esgotado (lockTimeoutMs: 0): é tomada na mesma chamada, sem "busy" falso', async () => {
    // Sob carga, os 250 ms padrão acabavam durante a remoção da trava morta e o sync respondia `busy` depois de uma
    // queda. Prazo zero reproduz isso sem depender de carga.
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    write(a.dir, 'wiki/pendente.md', note('Pendente'));
    const lock = join(a.dir, '.cabecao', 'locks', 'sync.lock');
    const pid = await deadPid();
    writeFileSync(lock, JSON.stringify({ pid, host: hostname(), at: Date.now(), token: 'morto' }));
    const ra = await a.sync({ lockTimeoutMs: 0 });
    expect(ra, ra.message).toMatchObject({ status: 'ok', committed: 1, pushed: 1 });
    expect(exists(a.dir, '.cabecao/locks/sync.lock')).toBe(false);
  });

  it('segredo numa edição pendente: bloqueia, nada é commitado nem enviado, sem mostrar o segredo', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const remoteBefore = await git(world.remote, ['rev-parse', 'main']);
    write(a.dir, 'wiki/vazou.md', `${note('Vazou')}\ntoken do CI: ${FAKE_TOKEN}\n`);
    write(a.dir, 'wiki/inocente.md', note('Inocente'));
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'blocked', reason: 'secrets', committed: 0, pushed: 0 });
    expect(ra.secrets).toEqual([
      expect.objectContaining({ path: 'wiki/vazou.md', line: 14, column: 14, rule: 'github-token', where: 'pending' }),
    ]);
    expect(JSON.stringify(ra)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(ra)).not.toContain(FAKE_TOKEN.slice(4, 20));
    expect(await git(a.dir, ['status', '--porcelain', '--', 'wiki'])).toContain('?? wiki/vazou.md');
    expect(await git(world.remote, ['rev-parse', 'main'])).toBe(remoteBefore);
    // marcar a linha como não-segredo libera o sync
    write(a.dir, 'wiki/vazou.md', `${note('Vazou')}\ntoken do CI: ${FAKE_TOKEN} <!-- cabecao:allow-secret -->\n`);
    expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });
  });

  it('segredo num commit feito por fora (ainda não enviado): bloqueia o envio', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const remoteBefore = await git(world.remote, ['rev-parse', 'main']);
    write(a.dir, 'wiki/vazou.md', `${note('Vazou')}\nchave: ${FAKE_TOKEN}\n`);
    await git(a.dir, ['add', '-A']);
    await git(a.dir, ['commit', '--quiet', '-m', 'commit por fora']);
    // mesmo apagado num commit seguinte, o segredo iria no histórico
    write(a.dir, 'wiki/vazou.md', note('Vazou'));
    await git(a.dir, ['commit', '--quiet', '-am', 'apaga a chave']);
    const ra = await a.sync();
    expect(ra).toMatchObject({ status: 'blocked', reason: 'secrets', pushed: 0 });
    expect(ra.secrets).toEqual([
      expect.objectContaining({ path: 'wiki/vazou.md', rule: 'github-token', where: 'outgoing' }),
    ]);
    expect(ra.message).not.toContain(FAKE_TOKEN);
    expect(await git(world.remote, ['rev-parse', 'main'])).toBe(remoteBefore);
  });

  it('syncStatus: remoto, commits não enviados, pendências, conflitos e último sync, sem ir ao remoto', async () => {
    const created = await createWorld();
    world = created.world;
    const { a } = created;
    const clean = await syncStatus(a.dir);
    expect(clean).toMatchObject({
      branch: 'main',
      remote: { name: 'origin', branch: 'main' },
      unpushed: 0,
      unpulled: 0,
      pendingChanges: 0,
      conflicts: 0,
      running: false,
      lastSync: { status: 'ok' },
    });
    write(a.dir, 'wiki/x.md', `${read(a.dir, 'wiki/x.md')}\nmais\n`);
    write(a.dir, 'wiki/nova.md', note('Nova'));
    write(a.dir, 'fora/ignorado.md', 'fora\n');
    await git(a.dir, ['remote', 'set-url', 'origin', join(world.root, 'nao-existe.git')]);
    await a.sync();
    write(a.dir, 'wiki/y.md', `${read(a.dir, 'wiki/y.md')}\npendente\n`);
    const status = await syncStatus(a.dir);
    expect(status).toMatchObject({ unpushed: 1, pendingChanges: 1, lastSync: { status: 'offline' } });
    expect(contentKept(a.dir, note('Nova'))).toBe(true);
  });
});
