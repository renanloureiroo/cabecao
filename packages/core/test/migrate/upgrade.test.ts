// Migrações do esquema (`cabecao upgrade`) com uma migração de TESTE (o esquema real ainda é o 1, sem migração), a
// atualização do modelo do cérebro e a regra de compatibilidade entre máquinas de versões diferentes.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENTS_MD_CONTENT, REQUIRED_GITIGNORE_LINES } from '../../src/init/index.ts';
import {
  applyMigration,
  applyTemplate,
  checkTemplate,
  lineDiff,
  MIGRATIONS,
  type Migration,
  MigrationError,
  PREVIOUS_TEMPLATE_HASHES,
  pendingMigrations,
  upgradeBrain,
  withSchemaVersion,
} from '../../src/migrate/index.ts';
import { contentHash } from '../../src/obsidian/index.ts';
import { syncBrain } from '../../src/sync/index.ts';
import { SUPPORTED_SCHEMA_VERSION } from '../../src/vault/index.ts';
import {
  cleanupAll,
  createBrainRepo,
  createTwoMachines,
  git,
  openTest,
  readText,
  TEST_TIMEOUT_MS,
  TODAY,
} from '../brain/helpers.ts';

afterAll(async () => {
  await cleanupAll();
});

/** Migração de teste 1 → 2: troca `trust: high` por `trust: alta` nas regras e cria um arquivo novo. */
const TEST_MIGRATION: Migration = {
  from: 1,
  to: 2,
  description: 'migração de teste: marca as regras',
  migrate: (tree) => {
    const changes = [];
    for (const [path, content] of tree) {
      if (path.startsWith('memory/rules/') && content.includes('trust: high')) {
        changes.push({ path, content: content.replace('trust: high', 'trust: alta') });
      }
    }
    changes.push({ path: 'memory/MIGRADO.md', content: '# migrado\n' });
    return changes;
  },
};
const SECOND: Migration = {
  from: 2,
  to: 3,
  description: 'segunda migração de teste',
  migrate: () => [{ path: 'memory/MIGRADO.md', content: null }],
};

const schemaOf = async (dir: string): Promise<number> =>
  (JSON.parse(await readText(dir, '.cabecao.json')) as { schemaVersion: number }).schemaVersion;

describe('cadeia de migrações', () => {
  it('as migrações reais vão até o esquema deste Cabeção, sem buraco', () => {
    expect(MIGRATIONS.at(-1)?.to ?? 1).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(pendingMigrations(1)).toHaveLength(SUPPORTED_SCHEMA_VERSION - 1);
    for (const migration of MIGRATIONS) expect(migration.to).toBe(migration.from + 1);
  });

  it('acha a cadeia em ordem e recusa buraco', () => {
    expect(pendingMigrations(1, [SECOND, TEST_MIGRATION], 3)).toEqual([TEST_MIGRATION, SECOND]);
    expect(pendingMigrations(3, [SECOND, TEST_MIGRATION], 3)).toEqual([]);
    expect(() => pendingMigrations(1, [SECOND], 3)).toThrow(MigrationError);
  });

  it('aplicar é puro: a árvore de entrada não muda, e o schemaVersion sobe mantendo as outras chaves', () => {
    const config = '{\n  "schemaVersion": 1,\n  "noteDirs": ["wiki"],\n  "x": {"y": 1}\n}\n';
    const tree = new Map([
      ['.cabecao.json', config],
      ['memory/rules/r.md', '---\ntrust: high\n---\n'],
    ]);
    const before = new Map(tree);
    const applied = applyMigration(tree, TEST_MIGRATION);
    expect(tree).toEqual(before);
    expect(applied.changes.map((change) => change.path)).toEqual(['memory/rules/r.md', 'memory/MIGRADO.md']);
    expect(JSON.parse(applied.tree.get('.cabecao.json') as string)).toEqual({
      schemaVersion: 2,
      noteDirs: ['wiki'],
      x: { y: 1 },
    });
    expect(Object.keys(JSON.parse(withSchemaVersion(config, 7)))).toEqual(['schemaVersion', 'noteDirs', 'x']);
  });

  it('recusa migração que mexe em .git/, .cabecao/ ou fora do cérebro', () => {
    for (const path of ['.git/config', '.cabecao/cabecao.db', '../fora.md', '/etc/passwd', 'a\\b.md']) {
      const evil: Migration = { from: 1, to: 2, description: 'má', migrate: () => [{ path, content: 'x' }] };
      expect(() => applyMigration(new Map(), evil), path).toThrow(MigrationError);
    }
  });
});

describe('upgradeBrain', () => {
  it(
    'aplica em ordem, um commit por migração (ação migrate, mesma sessão), com ponto de restauração; depois não faz nada',
    async () => {
      const dir = await createBrainRepo();
      const start = await git(dir, ['rev-parse', 'HEAD']);
      const plan = await upgradeBrain(dir, { dryRun: true, migrations: [TEST_MIGRATION, SECOND], supported: 3 });
      expect(plan.status).toBe('planned');
      expect(plan.steps.map((step) => step.changes.map((change) => change.path))).toEqual([
        ['memory/rules/nunca-commitar-segredos.md', 'memory/MIGRADO.md'],
        ['memory/MIGRADO.md'],
      ]);
      expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(start);
      expect(await schemaOf(dir)).toBe(1);

      const result = await upgradeBrain(dir, {
        migrations: [TEST_MIGRATION, SECOND],
        supported: 3,
        machine: 'maquina-a',
        now: () => TODAY,
      });
      expect(result).toMatchObject({ status: 'upgraded', from: 1, to: 3 });
      expect(await schemaOf(dir)).toBe(3);
      expect(await readText(dir, 'memory/rules/nunca-commitar-segredos.md')).toContain('trust: alta');
      expect(existsSync(join(dir, 'memory', 'MIGRADO.md'))).toBe(false);
      // ponto de restauração no commit de antes
      expect(result.restorePoint?.tag).toMatch(/^cabecao\/restore\/.*-upgrade$/);
      expect(await git(dir, ['rev-parse', `${result.restorePoint?.tag}^{commit}`])).toBe(start);
      // um commit por migração, no padrão do cérebro, com a mesma sessão
      const log = await git(dir, ['log', '--format=%B%x00', `${start}..HEAD`]);
      const messages = log
        .split('\0')
        .map((m) => m.trim())
        .filter(Boolean)
        .reverse();
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatch(/^vault backup: /);
      expect(messages[0]).toContain('migrate: migração de teste: marca as regras (esquema 1 → 2)');
      expect(messages[1]).toContain('(esquema 2 → 3)');
      for (const message of messages) {
        expect(message).toContain(`Cabecao-Session: ${result.session}`);
        expect(message).toContain('Cabecao-Machine: maquina-a');
        expect(message).not.toMatch(/Co-Authored|Claude/i);
      }
      expect(await git(dir, ['status', '--porcelain'])).toBe('');

      const again = await upgradeBrain(dir, { migrations: [TEST_MIGRATION, SECOND], supported: 3 });
      expect(again).toMatchObject({ status: 'up_to_date', steps: [] });
      expect(await git(dir, ['rev-list', '--count', `${start}..HEAD`])).toBe('2');

      // este código entende só o esquema 1: o cérebro migrado pela migração de teste não abre mais
      const brain = await openTest(dir, { machine: 'maquina-a' }).catch((error: unknown) => error);
      expect(brain).toBeInstanceOf(Error); // esquema 3 é mais novo do que este código entende
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'recusa esquema mais novo, pasta suja e cérebro fora de sincronia; o real não tem migração pendente',
    async () => {
      const dir = await createBrainRepo();
      expect(await upgradeBrain(dir)).toMatchObject({ status: 'up_to_date', from: 1, to: 1 });

      const config = await readText(dir, '.cabecao.json');
      await writeFile(join(dir, '.cabecao.json'), withSchemaVersion(config, 5));
      await expect(upgradeBrain(dir, { migrations: [TEST_MIGRATION], supported: 2 })).rejects.toMatchObject({
        code: 'schema_too_new',
        hint: expect.stringContaining('Atualize o Cabeção'),
      });
      await writeFile(join(dir, '.cabecao.json'), config);

      await writeFile(join(dir, 'wiki', 'nova.md'), '# nova\n');
      await expect(upgradeBrain(dir, { migrations: [TEST_MIGRATION], supported: 2 })).rejects.toMatchObject({
        code: 'dirty',
      });
      expect(await schemaOf(dir)).toBe(1);
      // simulação funciona mesmo com a pasta suja: não grava nada
      expect((await upgradeBrain(dir, { dryRun: true, migrations: [TEST_MIGRATION], supported: 2 })).status).toBe(
        'planned',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'compatibilidade: a máquina antiga recusa integrar o remoto migrado, sem perder as mudanças dela',
    async () => {
      const { a, b } = await createTwoMachines();
      // B (Cabeção antigo) tem uma edição ainda não enviada
      await writeFile(join(b, 'wiki', 'concepts', 'Nota de B.md'), '---\ntype: concept\ntitle: Nota de B\n---\nde B\n');
      // A (Cabeção novo) migra para o esquema 2 e envia
      expect(await upgradeBrain(a, { migrations: [TEST_MIGRATION], supported: 2, now: () => TODAY })).toMatchObject({
        status: 'upgraded',
      });
      await git(a, ['push', '--quiet']);
      expect(
        await upgradeBrain(b, { migrations: [TEST_MIGRATION], supported: 2 }).catch((e: unknown) => e),
      ).toMatchObject({
        code: 'dirty',
      });

      const bHead = await git(b, ['rev-parse', 'HEAD']);
      const result = await syncBrain(b, { machine: 'maquina-b', now: () => TODAY });
      expect(result).toMatchObject({ status: 'blocked', reason: 'schema-too-new', pushed: 0 });
      expect(result.message).toContain('Atualize o Cabeção');
      // nada do remoto foi aplicado: a configuração e as notas de B continuam no esquema 1
      expect(await schemaOf(b)).toBe(1);
      expect(await readText(b, 'memory/rules/nunca-commitar-segredos.md')).not.toContain('trust: alta');
      // a edição de B virou commit local, que vai depois da atualização
      expect(await git(b, ['log', '-1', '--format=%H'])).not.toBe(bHead);
      expect(await git(b, ['show', 'HEAD:wiki/concepts/Nota de B.md'])).toContain('de B');
      expect(await git(b, ['status', '--porcelain'])).toBe('');
      // e o remoto continua no esquema 2 de A, sem nada de B
      expect(await git(a, ['pull', '--quiet', '--ff-only']).then(() => 'ok')).toBe('ok');
      expect(existsSync(join(a, 'wiki', 'concepts', 'Nota de B.md'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('atualização do modelo do cérebro', () => {
  /** O AGENTS.md das betas 0.1.0-beta.0 e beta.1: o atual com as três linhas antigas. */
  const OLD_AGENTS = AGENTS_MD_CONTENT.replace(
    /- Grave com `remember`[^\n]*\n- Fontes de fora[^\n]*\n- Antes de encerrar[^\n]*\n/,
    '- Grave com `remember` o que for durável e não óbvio. Prefira as tools do Cabeção a editar os arquivos à mão: elas validam o frontmatter, procuram segredos e fazem o commit (que `undo` desfaz). Antes de gravar, use `search` para não repetir uma memória que já existe.\n- Antes de encerrar, grave um handoff com `remember` e `type: handoff`: o que foi feito, o que falta, as decisões e as armadilhas. O próximo `recall` o traz.\n',
  )
    .replace(
      /- Não apague arquivos\.[^\n]*\n/,
      '- Não apague arquivos. Para tirar uma memória de circulação, marque `valid_until` nela (com `write_page`) ou peça ao usuário que a arquive em `memory/_archive/`.\n',
    )
    // a linha das regras das betas (antes da decisão 37)
    .replace(
      /- Regras \(`type: rule`, em `memory\/rules\/`\)[^\n]*\n/,
      '- Regras (`type: rule`) só o usuário cria. Um agente pode propor uma regra em `wiki/syntheses/`, nunca gravá-la em `memory/rules/`.\n',
    );

  it('o hash conhecido é o do AGENTS.md das betas', () => {
    expect(OLD_AGENTS).not.toBe(AGENTS_MD_CONTENT);
    expect(PREVIOUS_TEMPLATE_HASHES['AGENTS.md']).toContain(contentHash(OLD_AGENTS));
    // com CRLF (git no Windows) também
    expect(contentHash(OLD_AGENTS.replace(/\n/g, '\r\n'))).toBe(contentHash(OLD_AGENTS));
  });

  it(
    'troca o modelo antigo sem edição, acrescenta linhas, nunca troca o editado sem confirmação',
    async () => {
      const dir = await createBrainRepo();
      await writeFile(join(dir, 'AGENTS.md'), OLD_AGENTS);
      await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n\nMinhas instruções.\n');
      await writeFile(join(dir, '.gitignore'), '.cabecao/\n# meu\nsegredos/\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '--quiet', '-m', 'beta antiga']);

      const items = await checkTemplate(dir);
      expect(Object.fromEntries(items.map((item) => [item.path, item.state]))).toEqual({
        'AGENTS.md': 'outdated',
        'CLAUDE.md': 'edited',
        '.gitignore': 'lines_missing',
        '.gitattributes': 'current',
      });
      expect(items.find((item) => item.path === '.gitignore')?.added).toContain('.obsidian/workspace.json');

      const result = await applyTemplate(dir, items, { machine: 'maquina-a', now: () => TODAY });
      expect(result.written.map((item) => item.path)).toEqual(['AGENTS.md', '.gitignore']);
      expect(await readText(dir, 'AGENTS.md')).toBe(AGENTS_MD_CONTENT);
      expect(await readText(dir, 'CLAUDE.md')).toBe('@AGENTS.md\n\nMinhas instruções.\n');
      const ignore = await readText(dir, '.gitignore');
      expect(ignore.startsWith('.cabecao/\n# meu\nsegredos/\n')).toBe(true);
      for (const line of REQUIRED_GITIGNORE_LINES) expect(ignore).toContain(line);
      expect(result.aside).toEqual([{ path: 'CLAUDE.md', aside: '.cabecao/template/CLAUDE.md' }]);
      expect(await readFile(join(dir, '.cabecao', 'template', 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
      expect(await git(dir, ['status', '--porcelain'])).toBe('');
      expect(await git(dir, ['log', '-1', '--format=%B'])).toContain('edit: AGENTS.md trocado pelo modelo atual');

      // de novo: nada a fazer
      const second = await checkTemplate(dir);
      expect(second.filter((item) => item.state !== 'current' && item.state !== 'edited')).toEqual([]);
      // com confirmação, o editado é trocado
      const confirmed = await applyTemplate(dir, second, { replace: ['CLAUDE.md'] });
      expect(confirmed.written).toEqual([{ path: 'CLAUDE.md', how: 'replaced' }]);
      expect(await readText(dir, 'CLAUDE.md')).toBe('@AGENTS.md\n');
    },
    TEST_TIMEOUT_MS,
  );

  it('diff legível: linhas que saem e entram, com contexto', () => {
    const diff = lineDiff('a\nb\nc\nd\ne\nf\n', 'a\nb\nC\nd\ne\nf\n');
    expect(diff.split('\n')).toEqual(['--- antes', '+++ depois', '@@', ' a', ' b', '-c', '+C', ' d', ' e']);
  });
});
