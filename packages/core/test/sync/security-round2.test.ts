// Regressão da segunda rodada da revisão adversária, no sync:
// - R2-4: um `.cabecao.json` inválido commitado por outro cliente git não derruba o cérebro nesta máquina (fica a
//   versão local e a do remoto vira cópia de conflito), e o sync roda mesmo com o `.cabecao.json` daqui inválido,
//   para poder receber a correção;
// - R2-3: um segredo escondido por um escape do YAML no frontmatter (`"\x01ghp_..."`) é achado nos valores
//   decodificados, tanto numa edição de fora quanto num commit que seria enviado.
import { describe, expect, it } from 'vitest';
import { openBrain } from '../../src/brain/index.ts';
import { fake } from '../security/corpus.ts';
import { BRAIN_CONFIG, createWorld, git, leftovers, read, remove, TEST_TIMEOUT_MS, write } from './helpers.ts';

const AT = new Date(2026, 10, 12, 14, 32, 10);
const now = (): Date => AT;
const COPY = '.cabecao.conflict-b-20261112-143210.json';
const BROKEN = '{ "schemaVersion": 1, "noteDirs": [\n';
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Token falso do GitHub, montado em tempo de execução. */
const fakeToken = (seed: number): string => `${'gh'}${'p_'}${fake(BASE62, 36, seed)}`;

async function opens(dir: string): Promise<boolean> {
  const brain = await openBrain(dir, { client: 'teste', actor: 'agent' });
  await brain.close();
  return true;
}

describe.concurrent('R2-4: .cabecao.json inválido vindo do remoto', { timeout: TEST_TIMEOUT_MS }, () => {
  it('fica a versão local, a do remoto vira cópia de conflito, o remoto é corrigido e o cérebro abre', async () => {
    const { world, a } = await createWorld();
    try {
      const b = await world.clone('b');
      write(a.dir, '.cabecao.json', BROKEN);
      write(a.dir, 'wiki/nova.md', '# Nova\n');
      await git(a.dir, ['add', '-A']);
      await git(a.dir, ['commit', '--quiet', '-m', 'quebra config (Obsidian Git)']);
      await git(a.dir, ['push', '--quiet']);
      write(b.dir, 'wiki/de-b.md', '# De B\n');

      const rb = await b.sync({ now });
      expect(rb.status).toBe('ok');
      expect(rb.conflicts).toEqual([expect.objectContaining({ path: '.cabecao.json', kind: 'invalid', copy: COPY })]);
      expect(rb.conflicts[0]?.reason).toMatch(/JSON/);
      expect(read(b.dir, '.cabecao.json')).toBe(BRAIN_CONFIG);
      expect(read(b.dir, COPY)).toBe(BROKEN);
      expect(read(b.dir, 'wiki/nova.md')).toBe('# Nova\n');
      expect(await leftovers(b.dir)).toEqual([]);
      expect(await opens(b.dir)).toBe(true);
      expect(await git(world.remote, ['show', 'main:.cabecao.json'])).toBe(BRAIN_CONFIG.trimEnd());
      expect(await git(b.dir, ['log', '--format=%B', '-n', '3'])).toContain('.cabecao.json inválido vindo do remoto');

      // o sync seguinte não refaz nada, e a máquina que quebrou recebe a versão boa (e a cópia)
      expect((await b.sync({ now })).status).toBe('ok');
      const ra = await a.sync({ now });
      expect(ra.status).toBe('ok');
      expect(read(a.dir, '.cabecao.json')).toBe(BRAIN_CONFIG);
      expect(read(a.dir, COPY)).toBe(BROKEN);
      expect(await opens(a.dir)).toBe(true);
    } finally {
      world.cleanup();
    }
  });

  it('campo inválido e arquivo apagado no remoto também não entram; mudança válida entra; esquema novo para o sync', async () => {
    const { world, a } = await createWorld();
    try {
      const b = await world.clone('b');
      // A é outro cliente git (Obsidian Git, terminal): recebe, muda e envia sem passar pelo Cabeção
      const push = async (change: () => void, label: string): Promise<void> => {
        await git(a.dir, ['pull', '--quiet', '--no-rebase']);
        change();
        await git(a.dir, ['add', '-A']);
        await git(a.dir, ['commit', '--quiet', '-m', label]);
        await git(a.dir, ['push', '--quiet']);
      };

      await push(
        () => write(a.dir, '.cabecao.json', '{"schemaVersion": 1, "noteDirs": [], "indexMd": "x.txt"}\n'),
        'campo',
      );
      const r1 = await b.sync({ now });
      expect(r1.conflicts.map((conflict) => conflict.kind)).toEqual(['invalid']);
      expect(read(b.dir, '.cabecao.json')).toBe(BRAIN_CONFIG);
      remove(b.dir, COPY);
      await b.sync({ now });

      await push(() => remove(a.dir, '.cabecao.json'), 'apaga');
      const r2 = await b.sync({ now });
      expect(r2.conflicts).toEqual([{ path: '.cabecao.json', kind: 'invalid', reason: 'o arquivo foi apagado' }]);
      expect(read(b.dir, '.cabecao.json')).toBe(BRAIN_CONFIG);
      expect(await opens(b.dir)).toBe(true);

      const valid = `${JSON.stringify({ schemaVersion: 1, noteDirs: ['wiki', 'memory', 'raw', 'Projetos'], indexMd: 'index.md' }, null, 2)}\n`;
      await push(() => write(a.dir, '.cabecao.json', valid), 'válida');
      const r3 = await b.sync({ now });
      expect(r3.conflicts).toEqual([]);
      expect(read(b.dir, '.cabecao.json')).toBe(valid);

      const newer = `${JSON.stringify({ schemaVersion: 99, noteDirs: ['wiki'], indexMd: 'index.md' })}\n`;
      await push(() => write(a.dir, '.cabecao.json', newer), 'esquema novo');
      const r4 = await b.sync({ now });
      // esquema mais novo não é "inválido", mas esta máquina não o entende: nada é aplicado nem enviado até atualizar
      // o Cabeção (regra de compatibilidade do `cabecao upgrade`)
      expect(r4).toMatchObject({ status: 'blocked', reason: 'schema-too-new', conflicts: [] });
      expect(r4.message).toContain('esquema 99');
      expect(read(b.dir, '.cabecao.json')).toBe(valid);
      expect(await opens(b.dir)).toBe(true);
    } finally {
      world.cleanup();
    }
  });

  it('com o .cabecao.json daqui inválido (já commitado), o sync roda e recebe a correção', async () => {
    const { world, a } = await createWorld();
    try {
      const b = await world.clone('b');
      // o estado de antes desta correção: o inválido chegou e foi commitado nas duas máquinas
      write(a.dir, '.cabecao.json', BROKEN);
      await git(a.dir, ['commit', '--quiet', '-am', 'quebra']);
      await git(a.dir, ['push', '--quiet']);
      await git(b.dir, ['pull', '--quiet', '--no-rebase']);
      await expect(openBrain(b.dir, { client: 'teste', actor: 'agent' })).rejects.toMatchObject({
        code: 'invalid_config',
      });

      write(b.dir, 'wiki/de-b.md', '# De B\n');
      const r1 = await b.sync({ now });
      expect(r1.status).toBe('ok');
      expect(r1.configProblem).toMatch(/última versão válida do histórico/);
      expect(r1.message).toMatch(/Configuração inválida nesta pasta/);
      expect(await git(world.remote, ['show', 'main:wiki/de-b.md'])).toBe('# De B');

      // a correção vem de A
      await a.sync({ now });
      write(a.dir, '.cabecao.json', BRAIN_CONFIG);
      await git(a.dir, ['commit', '--quiet', '-am', 'conserta']);
      await git(a.dir, ['push', '--quiet']);
      const r2 = await b.sync({ now });
      expect(r2.status).toBe('ok');
      expect(read(b.dir, '.cabecao.json')).toBe(BRAIN_CONFIG);
      expect(read(b.dir, 'wiki/de-b.md')).toBe('# De B\n');
      expect(await opens(b.dir)).toBe(true);
      expect((await b.sync({ now })).configProblem).toBeUndefined();
    } finally {
      world.cleanup();
    }
  });

  it('sem versão válida no histórico, o sync roda com a configuração padrão', async () => {
    const { world, a } = await createWorld({ seed: false });
    try {
      // reescreve o único commit com a configuração inválida (e sem remoto, que teria outro histórico)
      write(a.dir, '.cabecao.json', BROKEN);
      await git(a.dir, ['commit', '--quiet', '--amend', '-a', '--no-edit']);
      await git(a.dir, ['remote', 'remove', 'origin']);
      write(a.dir, 'wiki/nova.md', '# Nova\n');
      const result = await a.sync({ now });
      expect(result.status).toBe('ok');
      expect(result.configProblem).toMatch(/configuração padrão/);
      expect(await git(a.dir, ['show', 'HEAD:wiki/nova.md'])).toBe('# Nova');
    } finally {
      world.cleanup();
    }
  });
});

describe.concurrent('R2-3: segredo escondido por escape do YAML no frontmatter', { timeout: TEST_TIMEOUT_MS }, () => {
  it('edição de fora com "\\x01<token>", "\\x67hp_..." ou "\\a<token>": o sync bloqueia sem commitar', async () => {
    const { world, a } = await createWorld();
    try {
      const token = fakeToken(11);
      for (const [i, escaped] of [`\\x01${token}`, `\\x67${token.slice(1)}`, `\\a${token}`, `\\t${token}`].entries()) {
        write(a.dir, 'wiki/cfg.md', `---\ntype: concept\ntags: ["${escaped}"]\n---\ncorpo ${i}\n`);
        const result = await a.sync({ now });
        expect(result.status, escaped).toBe('blocked');
        expect(result.reason, escaped).toBe('secrets');
        expect(result.secrets?.[0], escaped).toMatchObject({ path: 'wiki/cfg.md', line: 3, where: 'pending' });
        expect(JSON.stringify(result), escaped).not.toContain(token);
      }
      expect(await git(world.remote, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('wiki/cfg.md');
    } finally {
      world.cleanup();
    }
  });

  it('commit feito por fora com o token escondido: o envio é bloqueado', async () => {
    const { world, a } = await createWorld();
    try {
      const token = fakeToken(12);
      write(a.dir, 'wiki/cfg.md', `---\nchave:\n  - "\\x01${token}"\n---\ncorpo\n`);
      await git(a.dir, ['add', '-A']);
      await git(a.dir, ['commit', '--quiet', '-m', 'commit do Obsidian Git']);
      const result = await a.sync({ now });
      expect(result.status).toBe('blocked');
      expect(result.secrets?.[0]).toMatchObject({ path: 'wiki/cfg.md', where: 'outgoing' });
      expect(await git(world.remote, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('wiki/cfg.md');
    } finally {
      world.cleanup();
    }
  });

  it('o marcador cabecao:allow-secret na linha do YAML libera, como no texto cru', async () => {
    const { world, a } = await createWorld();
    try {
      const token = fakeToken(13);
      write(a.dir, 'wiki/cfg.md', `---\nchave: "\\x01${token}" # ${'cabecao'}:allow-secret\n---\ncorpo\n`);
      const result = await a.sync({ now });
      expect(result.status).toBe('ok');
    } finally {
      world.cleanup();
    }
  });
});
