import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DoctorFacts } from '../src/doctor/checks.ts';
import {
  CHECKS,
  checkBrain,
  checkClients,
  checkConflicts,
  checkGit,
  checkGitignore,
  checkGpgSign,
  checkIdentity,
  checkIndex,
  checkInterrupted,
  checkLocks,
  checkNode,
  checkRemote,
  checkVisibility,
  checkWindowsPath,
  evaluate,
  isSupportedNode,
  renderReport,
} from '../src/doctor/checks.ts';
import { gatherFacts } from '../src/doctor/facts.ts';
import { unsupportedNodeMessage } from '../src/node-version.ts';
import {
  brainRepo,
  disposeSandbox,
  freshDir,
  git,
  machine,
  parseJson,
  TEST_TIMEOUT_MS,
  twoClones,
  writeNote,
} from './helpers.ts';

afterAll(() => {
  disposeSandbox();
});

/** Fatos de um cérebro saudável; cada teste estraga um pedaço. */
function healthy(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    platform: 'linux',
    nodeVersion: '24.1.0',
    git: { kind: 'ok', version: '2.50.1', supported: true, minimum: '2.38' },
    brain: { kind: 'resolved', root: '/home/ana/cabecao' },
    config: { kind: 'ok', schemaVersion: 1, supported: 1 },
    machine: { kind: 'ok', name: 'mac-ana', configPath: '/home/ana/.config/cabecao/config.json' },
    repo: { kind: 'ok', branch: 'main', headTime: 1_700_000_000 },
    remote: { name: 'origin', url: 'git@github.com:ana/cerebro.git', branch: 'main' },
    probe: { kind: 'ok', branches: ['main'] },
    visibility: { kind: 'checked', visibility: 'unknown', provider: null, url: 'git@github.com:ana/cerebro.git' },
    gitignore: { exists: true, missing: [] },
    gitattributes: { exists: true, missing: [] },
    index: {
      kind: 'present',
      rebuilt: null,
      schemaVersion: 1,
      expectedSchemaVersion: 1,
      notes: 10,
      lastScanAt: new Date(1_700_000_100_000).toISOString(),
    },
    locks: [],
    gitIndexLock: null,
    gitOperation: null,
    syncJournal: false,
    syncRunning: false,
    lastSync: { at: '2026-11-12T10:00:00.000Z', status: 'ok', message: 'ok' },
    conflicts: [],
    gpgSign: false,
    identity: { kind: 'ok', ident: 'Ana <ana@exemplo.com>' },
    clients: { kind: 'read', detected: [], registrations: [] },
    ...overrides,
  };
}

describe('verificações puras', () => {
  it('um cérebro saudável só tem ok, fora o aviso de nenhum cliente', () => {
    const report = evaluate(healthy());
    expect(report.summary.fail).toBe(0);
    expect(report.checks.filter((check) => check.status === 'warn').map((check) => check.id)).toEqual(['clients']);
    expect(renderReport(report)).toContain('0 falhas');
  });

  it('a faixa de versões do Node é a mesma do bin', () => {
    for (const version of [
      '18.20.0',
      '20.19.1',
      '22.0.0',
      '22.15.9',
      '22.16.0',
      '22.22.1',
      '23.11.0',
      '24.0.0',
      '26.1.0',
    ]) {
      expect(isSupportedNode(version)).toBe(unsupportedNodeMessage(version) === undefined);
    }
  });

  it('Node e git antigos falham com a correção', () => {
    expect(checkNode(healthy({ nodeVersion: '20.10.0' }))).toMatchObject({ status: 'fail', fix: expect.any(String) });
    expect(checkNode(healthy({ nodeVersion: '22.16.0' }))?.message).toContain('recomendado');
    expect(
      checkGit(healthy({ git: { kind: 'ok', version: '2.30.0', supported: false, minimum: '2.38' } })),
    ).toMatchObject({ status: 'fail', message: expect.stringContaining('2.38') });
    expect(checkGit(healthy({ git: { kind: 'error', message: 'git não encontrado' } }))?.status).toBe('fail');
  });

  it('sem cérebro: falha com a dica, e as verificações que dependem dele somem', () => {
    const facts: DoctorFacts = {
      platform: 'linux',
      nodeVersion: '24.1.0',
      git: { kind: 'ok', version: '2.50.1', supported: true, minimum: '2.38' },
      brain: { kind: 'unresolved', message: 'nenhum cérebro configurado', hint: 'Rode "cabecao init".' },
    };
    const report = evaluate(facts);
    expect(report.checks.map((check) => check.id)).toEqual(['node', 'git', 'brain']);
    expect(checkBrain(facts)).toMatchObject({ status: 'fail', fix: 'Rode "cabecao init".' });
  });

  it('remoto: sem remoto avisa; credencial falha; rede só avisa; --offline não consulta', () => {
    expect(checkRemote(healthy({ remote: null }))?.status).toBe('warn');
    const auth = checkRemote(
      healthy({ probe: { kind: 'failed', category: 'auth', message: 'Sem permissão', detail: 'Permission denied' } }),
    );
    expect(auth).toMatchObject({ status: 'fail', fix: expect.stringContaining('sem terminal') });
    expect(
      checkRemote(healthy({ probe: { kind: 'failed', category: 'network', message: 'sem rede', detail: '' } }))?.status,
    ).toBe('warn');
    expect(checkRemote(healthy({ probe: { kind: 'skipped' } }))?.message).toContain('--offline');
    expect(checkRemote(healthy({ probe: { kind: 'ok', branches: ['outra'] } }))?.status).toBe('warn');
  });

  it('repositório público em HTTPS avisa', () => {
    const result = checkVisibility(
      healthy({
        visibility: {
          kind: 'checked',
          visibility: 'public',
          provider: 'GitHub',
          url: 'https://github.com/ana/cerebro.git',
        },
      }),
    );
    expect(result).toMatchObject({ status: 'warn', message: expect.stringContaining('PÚBLICO') });
    expect(checkVisibility(healthy({ visibility: { kind: 'skipped' } }))).toBeNull();
  });

  it('.gitignore sem as linhas obrigatórias avisa e lista o que falta', () => {
    const result = checkGitignore(healthy({ gitignore: { exists: true, missing: ['.cabecao/'] } }));
    expect(result).toMatchObject({ status: 'warn', items: ['.cabecao/'] });
  });

  it('banco: ausente, refeito, de outro esquema, atrasado em relação ao último commit', () => {
    expect(checkIndex(healthy({ index: { kind: 'missing' } }))?.status).toBe('warn');
    expect(checkIndex(healthy({ index: { kind: 'error', message: 'corrompido' } }))?.status).toBe('fail');
    const base = healthy().index as Extract<DoctorFacts['index'], { kind: 'present' }>;
    expect(checkIndex(healthy({ index: { ...base, rebuilt: 'corrupt' } }))?.status).toBe('warn');
    expect(checkIndex(healthy({ index: { ...base, schemaVersion: 0 } }))?.status).toBe('warn');
    const stale = { ...base, lastScanAt: new Date(1_600_000_000_000).toISOString() };
    expect(checkIndex(healthy({ index: stale }))?.status).toBe('warn');
    // varredura um instante antes do commit (a escrita indexa e depois commita): ainda está em dia
    const justBefore = { ...base, lastScanAt: new Date(1_700_000_000_000 - 900).toISOString() };
    expect(checkIndex(healthy({ index: justBefore }))?.status).toBe('ok');
  });

  it('travas: de processo morto ou abandonada avisa; viva não', () => {
    expect(
      checkLocks(healthy({ locks: [{ path: 'sync.lock', owner: { pid: 1, host: 'h' }, ageMs: 10, alive: true }] }))
        ?.status,
    ).toBe('ok');
    const dead = checkLocks(
      healthy({ locks: [{ path: 'sync.lock', owner: { pid: 99, host: 'h' }, ageMs: 10, alive: false }] }),
    );
    expect(dead).toMatchObject({ status: 'warn', items: [expect.stringContaining('sync.lock')] });
    expect(
      checkLocks(
        healthy({ locks: [{ path: 'x.lock', owner: { pid: 9, host: 'outra' }, ageMs: 11 * 60_000, alive: null }] }),
      )?.status,
    ).toBe('warn');
    expect(checkLocks(healthy({ gitIndexLock: { path: '.git/index.lock', ageMs: 60_000 } }))?.status).toBe('warn');
    expect(checkLocks(healthy({ gitIndexLock: { path: '.git/index.lock', ageMs: 1_000 } }))?.status).toBe('ok');
  });

  it('operações interrompidas: git pela metade e HEAD solto falham; diário do sync e último sync com erro avisam', () => {
    expect(checkInterrupted(healthy({ gitOperation: 'merge' }))).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('git merge --abort'),
    });
    expect(checkInterrupted(healthy({ repo: { kind: 'ok', branch: null, headTime: 1 } }))?.status).toBe('fail');
    expect(checkInterrupted(healthy({ syncJournal: true }))?.status).toBe('warn');
    expect(checkInterrupted(healthy({ syncJournal: true, syncRunning: true }))?.status).toBe('ok');
    expect(checkInterrupted(healthy({ lastSync: { at: 'x', status: 'blocked', message: 'segredo' } }))?.status).toBe(
      'warn',
    );
  });

  it('conflitos, gpgsign, identidade', () => {
    const conflict = checkConflicts(
      healthy({ conflicts: [{ copy: 'a.conflict-m-20260101-000000.md', original: 'a.md', originalExists: true }] }),
    );
    expect(conflict).toMatchObject({ status: 'warn', items: ['a.conflict-m-20260101-000000.md → a.md'] });
    expect(checkGpgSign(healthy({ gpgSign: true }))).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('SEM assinatura'),
    });
    expect(checkIdentity(healthy({ identity: { kind: 'error', message: 'x' } }))).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('user.email'),
    });
  });

  it('caminho do Windows: só no win32, avisa perto de 260 e falha passando dele', () => {
    expect(checkWindowsPath(healthy())).toBeNull();
    const short = healthy({ platform: 'win32', brain: { kind: 'resolved', root: 'C:\\cabecao' } });
    expect(checkWindowsPath(short)?.status).toBe('ok');
    const long = healthy({ platform: 'win32', brain: { kind: 'resolved', root: `C:\\${'x'.repeat(190)}` } });
    expect(checkWindowsPath(long)?.status).toBe('warn');
    const tooLong = healthy({ platform: 'win32', brain: { kind: 'resolved', root: `C:\\${'x'.repeat(300)}` } });
    expect(checkWindowsPath(tooLong)?.status).toBe('fail');
  });

  it('clientes: registrado para este cérebro, com outra configuração, faltando', () => {
    const registered = checkClients(
      healthy({
        clients: {
          kind: 'read',
          detected: ['cursor', 'codex'],
          registrations: [
            { client: 'cursor', label: 'Cursor', files: [{ path: '/c/mcp.json', state: 'current' }] },
            { client: 'codex', label: 'Codex', files: [{ path: '/x/config.toml', state: 'different' }] },
          ],
        },
      }),
    );
    expect(registered).toMatchObject({ status: 'warn', fix: expect.stringContaining('install-client codex') });
    expect(checkClients(healthy({ clients: { kind: 'skipped' } }))).toBeNull();
  });

  it('toda verificação tem id único', () => {
    const ids = evaluate(healthy({ platform: 'win32' }), CHECKS).checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('doctor num cérebro de verdade', { timeout: TEST_TIMEOUT_MS }, () => {
  it('remoto local alcançável, .gitignore incompleto do exemplo, código 0', async () => {
    const { a } = await twoClones();
    const m = machine();
    const result = await m.cabecao(['doctor', '--brain', a]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Diagnóstico do Cabeção: ${a}`);
    expect(result.stdout).toMatch(/ok\s+Remoto\s+origin .* responde sem pedir senha/);
    expect(result.stdout).toMatch(/aviso\s+\.gitignore/);
    expect(result.stdout).toContain('Correção:');
    const json = parseJson(await m.cabecao(['doctor', '--brain', a, '--json', '--offline']));
    expect(json.ok).toBe(true);
    const remote = json.data.checks.find((check: { id: string }) => check.id === 'remote');
    expect(remote.message).toContain('--offline');
    expect(json.data.checks.find((check: { id: string }) => check.id === 'visibility')).toBeUndefined();
  });

  it('remoto que não existe falha; merge pela metade falha; código 1', async () => {
    const { a } = await twoClones();
    await git(a, ['remote', 'set-url', 'origin', join(freshDir('x'), 'nao-existe.git')]);
    const gitDir = join(a, '.git');
    await writeFile(join(gitDir, 'MERGE_HEAD'), `${await git(a, ['rev-parse', 'HEAD'])}\n`);
    const result = await machine().cabecao(['doctor', '--brain', a, '--json']);
    expect(result.code).toBe(1);
    const checks = parseJson(result).data.checks as Array<{ id: string; status: string }>;
    expect(checks.find((check) => check.id === 'remote')?.status).toBe('fail');
    expect(checks.find((check) => check.id === 'interrupted')?.status).toBe('fail');
  });

  it('sem cérebro: falha com a dica do init, e ainda verifica Node e git', async () => {
    const result = await machine().cabecao(['doctor']);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/ok\s+Node\.js/);
    expect(result.stdout).toMatch(/ok\s+git/);
    expect(result.stdout).toMatch(/falha\s+Cérebro\s+nenhum cérebro configurado/);
    expect(result.stdout).toContain('cabecao init');
  });

  it('conflito pendente, trava órfã e banco ainda não montado aparecem como aviso', async () => {
    const brain = await brainRepo();
    await writeNote(brain, 'wiki/concepts/x.conflict-maquina-b-20261112-143210.md', '# x\n');
    const locks = join(brain, '.cabecao', 'locks');
    await mkdir(locks, { recursive: true });
    await writeFile(join(locks, 'sync.lock'), JSON.stringify({ pid: 4_000_000, host: 'esta', at: 0, token: 't' }));
    const facts = await gatherFacts(machine().io, {
      brain: { root: brain },
      offline: true,
      nodeVersion: '24.1.0',
      hostname: 'esta',
      pidAlive: () => false,
    });
    expect(facts.index).toEqual({ kind: 'missing' });
    expect(facts.conflicts).toHaveLength(1);
    const report = evaluate(facts);
    const status = (id: string) => report.checks.find((check) => check.id === id)?.status;
    expect(status('conflicts')).toBe('warn');
    expect(status('locks')).toBe('warn');
    expect(status('index')).toBe('warn');
    expect(status('remote')).toBe('warn'); // só local
  });

  it('gpgsign ligado no repositório avisa que os commits do Cabeção não são assinados', async () => {
    const brain = await brainRepo();
    await git(brain, ['config', 'commit.gpgsign', 'true']);
    const json = parseJson(await machine().cabecao(['doctor', '--brain', brain, '--json', '--offline']));
    expect(json.data.checks.find((check: { id: string }) => check.id === 'gpgsign').status).toBe('warn');
  });

  it('lê o registro dos clientes sem executar nada', async () => {
    const brain = await brainRepo();
    const m = machine();
    await mkdir(join(m.home, '.cursor'), { recursive: true });
    await writeFile(join(m.home, '.cursor', 'mcp.json'), '{"mcpServers":{"cabecao":{"command":"x","args":[]}}}');
    const json = parseJson(await m.cabecao(['doctor', '--brain', brain, '--json', '--offline']));
    const clients = json.data.checks.find((check: { id: string }) => check.id === 'clients');
    expect(clients).toMatchObject({ status: 'warn', fix: expect.stringContaining('install-client cursor') });
    expect(m.calls).toEqual([]);
    // o arquivo continua como estava
    expect(await readFile(join(m.home, '.cursor', 'mcp.json'), 'utf8')).toContain('"command":"x"');
  });

  it('index.lock velho do git aparece como trava órfã', async () => {
    const brain = await brainRepo();
    const lock = join(brain, '.git', 'index.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    const json = parseJson(await machine().cabecao(['doctor', '--brain', brain, '--json', '--offline']));
    const locks = json.data.checks.find((check: { id: string }) => check.id === 'locks');
    expect(locks.status).toBe('warn');
    expect(locks.items[0]).toContain('index.lock');
  });
});
