import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitError, GitStateError } from '../../src/git/errors.ts';
import {
  commitPaths,
  createRestorePoint,
  currentBranch,
  defaultRemoteBranch,
  findCommitsByTrailer,
  headSha,
  isRepo,
  restorePointName,
  revertCommits,
  statusPorcelain,
} from '../../src/git/ops.ts';
import { runGit } from '../../src/git/run.ts';
import {
  configureRepo,
  createSandbox,
  message,
  out,
  type Sandbox,
  SESSION_A,
  SESSION_B,
  TEST_TIMEOUT_MS,
  write,
} from './helpers.ts';

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });

let sandbox: Sandbox;
let counter = 0;

/** Um repositório novo por teste, para que um não dependa do outro. */
function newRepo(branch = 'main'): Promise<string> {
  counter += 1;
  return sandbox.initRepo(`cérebro ${counter}`, branch);
}

beforeAll(() => {
  sandbox = createSandbox();
});

afterAll(() => {
  sandbox.cleanup();
});

describe('isRepo, headSha e currentBranch', () => {
  it('reconhece repositório, pasta comum e pasta inexistente', async () => {
    const repo = await newRepo();
    write(repo, 'wiki/nota.md', 'x\n');
    expect(await isRepo(repo)).toBe(true);
    expect(await isRepo(join(repo, 'wiki'))).toBe(true);
    expect(await isRepo(sandbox.root)).toBe(false);
    expect(await isRepo(join(sandbox.root, 'não existe'))).toBe(false);
  });

  it('repositório sem commits: headSha nulo, branch já tem o nome escolhido', async () => {
    const repo = await newRepo('trunk');
    expect(await headSha(repo)).toBeNull();
    expect(await currentBranch(repo)).toBe('trunk');
  });

  it('devolve o SHA do último commit e nulo para a branch com HEAD solto', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', 'a\n');
    const sha = await commitPaths(repo, ['a.md'], message('01OP1'));
    expect(sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await headSha(repo)).toBe(sha);
    expect(await currentBranch(repo)).toBe('main');
    await runGit(['checkout', '--quiet', '--detach'], { cwd: repo });
    expect(await currentBranch(repo)).toBeNull();
    expect(await headSha(repo)).toBe(sha);
  });

  it('fora de um repositório, headSha e currentBranch lançam GitError', async () => {
    await expect(headSha(sandbox.root)).rejects.toBeInstanceOf(GitError);
    await expect(currentBranch(sandbox.root)).rejects.toBeInstanceOf(GitError);
  });
});

describe('statusPorcelain', () => {
  it('lista novos, alterados, apagados e renomeados, com acento e espaço sem escape', async () => {
    const repo = await newRepo();
    write(repo, 'alterada.md', '1\n');
    write(repo, 'apagada.md', '1\n');
    write(repo, 'nome antigo.md', 'conteúdo longo o bastante para o git reconhecer a renomeação\n');
    await commitPaths(repo, ['alterada.md', 'apagada.md', 'nome antigo.md'], message('01OP1'));
    expect(await statusPorcelain(repo)).toEqual([]);

    write(repo, 'alterada.md', '2\n');
    rmSync(join(repo, 'apagada.md'));
    await runGit(['mv', 'nome antigo.md', 'nome novo.md'], { cwd: repo });
    write(repo, 'wiki/anotação nova.md', 'x\n');
    write(repo, 'wiki/outra.md', 'x\n');
    await runGit(['add', '--', 'wiki/outra.md'], { cwd: repo });

    const status = await statusPorcelain(repo);
    expect(status).toHaveLength(5);
    expect(status).toEqual(
      expect.arrayContaining([
        { index: ' ', worktree: 'M', path: 'alterada.md' },
        { index: ' ', worktree: 'D', path: 'apagada.md' },
        { index: 'R', worktree: ' ', path: 'nome novo.md', origPath: 'nome antigo.md' },
        { index: '?', worktree: '?', path: 'wiki/anotação nova.md' },
        { index: 'A', worktree: ' ', path: 'wiki/outra.md' },
      ]),
    );
  });
});

describe('commitPaths', () => {
  it('commita só os caminhos da lista, com a mensagem exata, e deixa o resto como estava', async () => {
    const repo = await newRepo();
    write(repo, 'wiki/dentro.md', 'dentro\n');
    write(repo, 'fora-preparado.md', 'fora\n');
    write(repo, 'fora-solto.md', 'fora\n');
    await runGit(['add', '--', 'fora-preparado.md'], { cwd: repo });

    const text = message('01OP1', { session: SESSION_A });
    const sha = await commitPaths(repo, ['wiki/dentro.md'], text);

    expect(sha).toBe(await headSha(repo));
    expect(await out(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('wiki/dentro.md');
    expect(await out(repo, ['log', '-1', '--format=%B'])).toBe(text.trimEnd());
    expect(await statusPorcelain(repo)).toEqual(
      expect.arrayContaining([
        { index: 'A', worktree: ' ', path: 'fora-preparado.md' },
        { index: '?', worktree: '?', path: 'fora-solto.md' },
      ]),
    );
  });

  it('o autor é a identidade do git do usuário, sem coautoria nem atribuição', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', 'a\n');
    await commitPaths(repo, ['a.md'], message('01OP1'));
    expect(await out(repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe(
      'Teste Cabeção <teste@cabecao.invalid>|Teste Cabeção <teste@cabecao.invalid>',
    );
    expect(await out(repo, ['log', '-1', '--format=%B'])).not.toMatch(/co-authored-by|generated with|noreply@/i);
  });

  it('inclui alterações e exclusões, e trata nomes com colchetes, asterisco e acento como literais', async () => {
    const repo = await newRepo();
    const special = 'wiki/nota [rascunho] ação.md';
    write(repo, special, '1\n');
    write(repo, 'wiki/nota r ação.md', '1\n');
    write(repo, 'apagar.md', '1\n');
    await commitPaths(repo, [special, 'wiki/nota r ação.md', 'apagar.md'], message('01OP1'));

    write(repo, special, '2\n');
    write(repo, 'wiki/nota r ação.md', '2\n');
    rmSync(join(repo, 'apagar.md'));
    await commitPaths(repo, [special, 'apagar.md'], message('01OP2'));

    const changed = (await out(repo, ['show', '--name-status', '--format=', '-z', 'HEAD'])).split('\0').filter(Boolean);
    expect(changed).toEqual(['D', 'apagar.md', 'M', special]);
    // Como padrão, "[rascunho]" casaria com "r" e levaria a outra nota junto.
    expect(await statusPorcelain(repo)).toEqual([{ index: ' ', worktree: 'M', path: 'wiki/nota r ação.md' }]);
  });

  it('uma pasta na lista leva tudo que há dentro dela', async () => {
    const repo = await newRepo();
    write(repo, 'raw/fonte/a.md', 'a\n');
    write(repo, 'raw/fonte/sub/b.md', 'b\n');
    write(repo, 'raw/outra.md', 'c\n');
    await commitPaths(repo, ['raw/fonte'], message('01OP1'));
    expect((await out(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n')).toEqual([
      'raw/fonte/a.md',
      'raw/fonte/sub/b.md',
    ]);
  });

  it('devolve nulo quando nenhum caminho mudou, mesmo com outras mudanças no repositório', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', 'a\n');
    const first = await commitPaths(repo, ['a.md'], message('01OP1'));
    write(repo, 'b.md', 'b\n');
    await runGit(['add', '--', 'b.md'], { cwd: repo });
    expect(await commitPaths(repo, ['a.md'], message('01OP2'))).toBeNull();
    expect(await headSha(repo)).toBe(first);
    expect(await statusPorcelain(repo)).toEqual([{ index: 'A', worktree: ' ', path: 'b.md' }]);
  });

  it('aguenta centenas de caminhos de uma vez', async () => {
    const repo = await newRepo();
    const paths = Array.from(
      { length: 600 },
      (_, i) => `wiki/conceitos/anotação número ${String(i).padStart(4, '0')} com nome comprido.md`,
    );
    for (const path of paths) write(repo, path, `${path}\n`);
    await commitPaths(repo, paths, message('01OP1'));
    expect(await out(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect((await out(repo, ['ls-files', '-z'])).split('\0').filter(Boolean)).toHaveLength(600);
    expect(await statusPorcelain(repo)).toEqual([]);
  });

  it('usa --no-verify: um hook que recusa tudo não impede o commit', async () => {
    const repo = await newRepo();
    for (const hook of ['pre-commit', 'commit-msg']) {
      const file = join(repo, '.git', 'hooks', hook);
      writeFileSync(file, '#!/bin/sh\necho "hook recusou" >&2\nexit 1\n');
      chmodSync(file, 0o755);
    }
    write(repo, 'a.md', 'a\n');
    // Controle: sem --no-verify o hook barra o commit.
    await runGit(['add', '--', 'a.md'], { cwd: repo });
    await expect(runGit(['commit', '-m', 'controle'], { cwd: repo })).rejects.toBeInstanceOf(GitError);
    expect(await commitPaths(repo, ['a.md'], message('01OP1'))).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('não assina por padrão, mesmo com commit.gpgsign ligado; com sign segue a configuração', async () => {
    const repo = await newRepo();
    await runGit(['config', '--local', 'commit.gpgsign', 'true'], { cwd: repo });
    await runGit(['config', '--local', 'gpg.program', 'cabecao-gpg-que-nao-existe'], { cwd: repo });
    write(repo, 'a.md', 'a\n');
    const sha = await commitPaths(repo, ['a.md'], message('01OP1'));
    expect(sha).not.toBeNull();
    expect(await out(repo, ['log', '-1', '--format=%G?'])).toBe('N');
    write(repo, 'a.md', 'b\n');
    await expect(commitPaths(repo, ['a.md'], message('01OP2'), { sign: true })).rejects.toBeInstanceOf(GitError);
    expect(await headSha(repo)).toBe(sha);
  });

  it('recusa lista vazia e caminho que não existe', async () => {
    const repo = await newRepo();
    await expect(commitPaths(repo, [], message('01OP1'))).rejects.toBeInstanceOf(TypeError);
    await expect(commitPaths(repo, ['nao-existe.md'], message('01OP1'))).rejects.toBeInstanceOf(GitError);
    expect(await headSha(repo)).toBeNull();
  });
});

describe('findCommitsByTrailer', () => {
  it('acha por operação e por sessão, do mais novo para o mais antigo, aceitando o começo do identificador', async () => {
    const repo = await newRepo();
    const shas: Record<string, string | null> = {};
    const commits: [string, string | undefined][] = [
      ['01JD3K8Y6Z9W2T4N5P7Q8R0S1V', SESSION_A],
      ['01JD3K9AAAAAAAAAAAAAAAAAAA', SESSION_B],
      ['01JD3KBBBBBBBBBBBBBBBBBBBB', SESSION_A],
      ['01JD3KCCCCCCCCCCCCCCCCCCCC', undefined],
    ];
    for (const [op, session] of commits) {
      write(repo, `${op}.md`, `${op}\n`);
      shas[op] = await commitPaths(repo, [`${op}.md`], message(op, session === undefined ? {} : { session }));
    }

    const bySession = await findCommitsByTrailer(repo, { session: SESSION_A });
    expect(bySession.map((commit) => commit.sha)).toEqual([
      shas['01JD3KBBBBBBBBBBBBBBBBBBBB'],
      shas['01JD3K8Y6Z9W2T4N5P7Q8R0S1V'],
    ]);
    expect(bySession[0]).toMatchObject({
      subject: 'vault backup: 2026-11-12 14:32:10.482',
      trailers: {
        op: '01JD3KBBBBBBBBBBBBBBBBBBBB',
        session: SESSION_A,
        machine: 'macbook',
        client: 'cli',
        reverts: [],
      },
    });
    expect(bySession[0]?.message).toContain('add fact: nota da operação 01JD3KBBBBBBBBBBBBBBBBBBBB');
    expect(Number.isNaN(Date.parse(bySession[0]?.authorDate ?? ''))).toBe(false);

    expect((await findCommitsByTrailer(repo, { session: '01JD3K7M' })).map((commit) => commit.sha)).toEqual(
      bySession.map((commit) => commit.sha),
    );
    expect((await findCommitsByTrailer(repo, { op: '01JD3K9A' })).map((commit) => commit.sha)).toEqual([
      shas['01JD3K9AAAAAAAAAAAAAAAAAAA'],
    ]);
    expect(await findCommitsByTrailer(repo, { op: '01JD3KCCCCCCCCCCCCCCCCCCCC' })).toHaveLength(1);
    expect(await findCommitsByTrailer(repo, { op: '01ZZZ' })).toEqual([]);
  });

  it('ignora o texto do rodapé citado no corpo de outro commit e commits de outros clientes', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', 'a\n');
    await runGit(['add', '--', 'a.md'], { cwd: repo });
    await runGit(
      [
        'commit',
        '--no-verify',
        '-m',
        'vault backup: 2026-11-12 10:00:00',
        '-m',
        `Cabecao-Session: ${SESSION_A}`,
        '-m',
        'fim do corpo',
      ],
      { cwd: repo },
    );
    write(repo, 'b.md', 'b\n');
    const real = await commitPaths(repo, ['b.md'], message('01OP1', { session: SESSION_A }));
    expect((await findCommitsByTrailer(repo, { session: SESSION_A })).map((commit) => commit.sha)).toEqual([real]);
  });

  it('repositório sem commits devolve lista vazia; busca vazia é recusada', async () => {
    const repo = await newRepo();
    expect(await findCommitsByTrailer(repo, { op: '01OP1' })).toEqual([]);
    await expect(findCommitsByTrailer(repo, { op: ' ' })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('revertCommits', () => {
  it('desfaz uma sessão inteira com um commit só, sem reescrever histórico, e as notas voltam idênticas', async () => {
    const repo = await newRepo();
    write(repo, 'wiki/nota.md', 'versão original\ncom ação\n');
    write(repo, 'wiki/apagada.md', 'será apagada pela sessão\n');
    const base = await commitPaths(repo, ['wiki'], message('01OP0'));

    write(repo, 'wiki/nota.md', 'versão da sessão\ncom ação\n');
    write(repo, 'wiki/criada.md', 'nova\n');
    await commitPaths(repo, ['wiki'], message('01OP1', { session: SESSION_A }));
    rmSync(join(repo, 'wiki/apagada.md'));
    write(repo, 'wiki/nota.md', 'segunda versão da sessão\ncom ação\n');
    await commitPaths(repo, ['wiki'], message('01OP2', { session: SESSION_A }));
    const before = (await out(repo, ['rev-list', 'HEAD'])).split('\n');

    // Trabalho em andamento em outro arquivo não atrapalha nem é levado junto.
    write(repo, 'rascunho.md', 'não commitado\n');
    const targets = await findCommitsByTrailer(repo, { session: SESSION_A });
    const text = message('01OP3', { reverts: ['01OP2', '01OP1'] });
    const sha = await revertCommits(
      repo,
      targets.map((commit) => commit.sha),
      text,
    );

    expect(sha).toBe(await headSha(repo));
    const after = (await out(repo, ['rev-list', 'HEAD'])).split('\n');
    expect(after).toEqual([sha, ...before]);
    expect(await out(repo, ['log', '-1', '--format=%B'])).toBe(text.trimEnd());
    expect(await out(repo, ['rev-parse', 'HEAD^{tree}'])).toBe(await out(repo, ['rev-parse', `${base}^{tree}`]));
    expect(readFileSync(join(repo, 'wiki/nota.md'), 'utf8')).toBe('versão original\ncom ação\n');
    expect(readFileSync(join(repo, 'wiki/apagada.md'), 'utf8')).toBe('será apagada pela sessão\n');
    expect(existsSync(join(repo, 'wiki/criada.md'))).toBe(false);
    expect(await statusPorcelain(repo)).toEqual([{ index: '?', worktree: '?', path: 'rascunho.md' }]);
    expect(await out(repo, ['status'])).not.toMatch(/revert/i);

    const undo = await findCommitsByTrailer(repo, { op: '01OP3' });
    expect(undo[0]?.trailers.reverts).toEqual(['01OP2', '01OP1']);
  });

  it('recusa com o índice sujo, sem mexer em nada', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', '1\n');
    const first = await commitPaths(repo, ['a.md'], message('01OP1'));
    write(repo, 'b.md', 'preparado\n');
    await runGit(['add', '--', 'b.md'], { cwd: repo });
    await expect(revertCommits(repo, [first ?? ''], message('01OP2', { reverts: '01OP1' }))).rejects.toBeInstanceOf(
      GitStateError,
    );
    expect(await headSha(repo)).toBe(first);
    expect(await statusPorcelain(repo)).toEqual([{ index: 'A', worktree: ' ', path: 'b.md' }]);
  });

  it('em conflito, lança GitError e devolve o repositório ao estado anterior', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', '1\n');
    await commitPaths(repo, ['a.md'], message('01OP1'));
    write(repo, 'a.md', '2\n');
    const second = await commitPaths(repo, ['a.md'], message('01OP2'));
    write(repo, 'a.md', '3\n');
    const third = await commitPaths(repo, ['a.md'], message('01OP3'));
    write(repo, 'solto.md', 'não commitado\n');

    const error = await revertCommits(repo, [second ?? ''], message('01OP4', { reverts: '01OP2' })).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.stderr).toContain('could not revert');
    expect(await headSha(repo)).toBe(third);
    expect(readFileSync(join(repo, 'a.md'), 'utf8')).toBe('3\n');
    expect(await statusPorcelain(repo)).toEqual([{ index: '?', worktree: '?', path: 'solto.md' }]);
    expect(await out(repo, ['status'])).not.toMatch(/revert|unmerged/i);
  });

  it('não assina e não roda hooks', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', '1\n');
    const first = await commitPaths(repo, ['a.md'], message('01OP1'));
    write(repo, 'a.md', '2\n');
    const second = await commitPaths(repo, ['a.md'], message('01OP2'));
    await runGit(['config', '--local', 'commit.gpgsign', 'true'], { cwd: repo });
    await runGit(['config', '--local', 'gpg.program', 'cabecao-gpg-que-nao-existe'], { cwd: repo });
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);

    const sha = await revertCommits(repo, [second ?? ''], message('01OP3', { reverts: '01OP2' }));
    expect(sha).not.toBeNull();
    expect(await out(repo, ['rev-parse', 'HEAD^{tree}'])).toBe(await out(repo, ['rev-parse', `${first}^{tree}`]));
  });

  it('valida os SHAs antes de chamar o git', async () => {
    const repo = await newRepo();
    await expect(revertCommits(repo, [], 'x')).rejects.toBeInstanceOf(TypeError);
    await expect(revertCommits(repo, ['--abort'], 'x')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('createRestorePoint', () => {
  it('cria a tag local cabecao/restore/<data> no commit atual', async () => {
    const repo = await newRepo();
    write(repo, 'a.md', '1\n');
    const sha = await commitPaths(repo, ['a.md'], message('01OP1'));
    const date = new Date(2026, 10, 12, 14, 32, 10, 482);
    expect(restorePointName(date)).toBe('2026-11-12-143210-482');

    const point = await createRestorePoint(repo, date);
    expect(point).toEqual({ tag: 'cabecao/restore/2026-11-12-143210-482', sha });
    expect(await out(repo, ['rev-parse', 'refs/tags/cabecao/restore/2026-11-12-143210-482'])).toBe(sha);
    // Tag leve: aponta direto para o commit, sem objeto de tag nem assinatura.
    expect(await out(repo, ['cat-file', '-t', 'refs/tags/cabecao/restore/2026-11-12-143210-482'])).toBe('commit');

    write(repo, 'a.md', '2\n');
    await commitPaths(repo, ['a.md'], message('01OP2'));
    const named = await createRestorePoint(repo, 'antes-do-consolidate');
    expect(named.tag).toBe('cabecao/restore/antes-do-consolidate');
    expect(named.sha).toBe(await headSha(repo));
    // O ponto anterior continua onde estava.
    expect(await out(repo, ['rev-parse', point.tag])).toBe(sha);
  });

  it('recusa nome repetido, nome inválido e repositório sem commits', async () => {
    const repo = await newRepo();
    await expect(createRestorePoint(repo, 'x')).rejects.toBeInstanceOf(GitStateError);
    write(repo, 'a.md', '1\n');
    await commitPaths(repo, ['a.md'], message('01OP1'));
    await createRestorePoint(repo, 'x');
    await expect(createRestorePoint(repo, 'x')).rejects.toBeInstanceOf(GitError);
    await expect(createRestorePoint(repo, 'com espaço')).rejects.toBeInstanceOf(GitError);
    await expect(createRestorePoint(repo, '-d')).rejects.toBeInstanceOf(TypeError);
    expect(await out(repo, ['tag', '--list'])).toBe('cabecao/restore/x');
  });
});

describe('defaultRemoteBranch', () => {
  it.each(['trunk', 'master', 'main'])(
    'descobre a branch "%s" do remoto, no clone e no remoto acrescentado depois',
    async (branch) => {
      const remote = await sandbox.initBare(`remoto ${branch}.git`, branch);
      const origin = await newRepo(branch);
      write(origin, 'a.md', '1\n');
      await commitPaths(origin, ['a.md'], message('01OP1'));
      await runGit(['remote', 'add', 'origin', remote], { cwd: origin });
      // Antes do primeiro envio não há refs/remotes/origin/HEAD: a resposta vem do remoto, se ele a der.
      expect([null, branch]).toContain(await defaultRemoteBranch(origin));
      await runGit(['push', '--quiet', 'origin', branch], { cwd: origin });
      expect(await defaultRemoteBranch(origin)).toBe(branch);

      const clone = join(sandbox.root, `clone de ${branch}`);
      await runGit(['clone', '--quiet', remote, clone], { cwd: sandbox.root });
      await configureRepo(clone);
      expect(await defaultRemoteBranch(clone)).toBe(branch);
      expect(await defaultRemoteBranch(clone, { refresh: true })).toBe(branch);
      // O nome local não interfere: o que vale é o que o remoto usa.
      await runGit(['checkout', '--quiet', '-b', 'outra'], { cwd: clone });
      expect(await defaultRemoteBranch(clone, { remote: 'origin' })).toBe(branch);
    },
  );

  it('remoto inexistente lança GitError classificado como not-found', async () => {
    const repo = await newRepo();
    const noRemote = await defaultRemoteBranch(repo).catch((e) => e);
    expect(noRemote).toBeInstanceOf(GitError);
    expect(noRemote.category).toBe('not-found');

    await runGit(['remote', 'add', 'origin', join(sandbox.root, 'sumiu.git')], { cwd: repo });
    const gone = await defaultRemoteBranch(repo).catch((e) => e);
    expect(gone).toBeInstanceOf(GitError);
    expect(gone.category).toBe('not-found');
    await expect(defaultRemoteBranch(repo, { remote: '--upload-pack=x' })).rejects.toBeInstanceOf(TypeError);
  });

  it('push atrás do remoto é classificado como rejected (stderr gerado aqui)', async () => {
    const remote = await sandbox.initBare('remoto-disputado.git');
    const a = await newRepo();
    write(a, 'a.md', '1\n');
    await commitPaths(a, ['a.md'], message('01OP1'));
    await runGit(['remote', 'add', 'origin', remote], { cwd: a });
    await runGit(['push', '--quiet', 'origin', 'main'], { cwd: a });
    const b = join(sandbox.root, 'segunda máquina');
    await runGit(['clone', '--quiet', remote, b], { cwd: sandbox.root });
    await configureRepo(b);
    write(b, 'b.md', '1\n');
    await commitPaths(b, ['b.md'], message('01OP2'));
    await runGit(['push', '--quiet', 'origin', 'main'], { cwd: b });

    write(a, 'c.md', '1\n');
    await commitPaths(a, ['c.md'], message('01OP3'));
    const error = await runGit(['push', 'origin', 'main'], { cwd: a }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.stderr).toContain('[rejected]');
    expect(error.category).toBe('rejected');
  });
});
