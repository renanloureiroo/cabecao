import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BrainError } from '../../src/brain/index.ts';
import { parseCommitTrailers } from '../../src/git/index.ts';
import { collectIndexEntries, readBrainConfig, renderIndexMd } from '../../src/vault/index.ts';
import { fake } from '../security/corpus.ts';
import {
  cleanupAll,
  commitCount,
  commitFiles,
  commitMessageOf,
  createBrainRepo,
  disposeSandbox,
  head,
  openTest,
  porcelain,
  readText,
  snapshot,
  TEST_TIMEOUT_MS,
} from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

async function errorOf(promise: Promise<unknown>): Promise<BrainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('a operação deveria ter falhado');
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Token falso do GitHub, montado em tempo de execução: nunca aparece inteiro neste arquivo. */
const fakeToken = (seed: number): string => `${'gh'}${'p_'}${fake(BASE62, 36, seed)}`;

/** O catálogo do disco é o mesmo que o sync geraria para estas notas. */
async function expectCatalogConsistent(dir: string): Promise<void> {
  const config = await readBrainConfig(dir);
  const expected = renderIndexMd(await collectIndexEntries(dir, config), { groupOrder: config.noteDirs });
  expect(await readText(dir, 'index.md')).toBe(expected);
}

describe('fluxo de escrita', { timeout: TEST_TIMEOUT_MS }, () => {
  it('remember: arquivo, banco, um commit com os quatro rodapés e index.md e log.md no mesmo commit', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const { session_handle: session } = await brain.recall({ task: 'testes do Atlas' });
    const commitsBefore = await commitCount(dir);
    const result = await brain.remember({
      type: 'gotcha',
      title: 'Cache do Atlas guarda sessão antiga',
      content: 'Limpe o cache com `make cache-clear` depois de trocar de conta.\n',
      scope: 'project:atlas',
      tags: ['cache'],
      relations: { part_of: ['Projeto Atlas'] },
      session_handle: session,
    });
    expect(result).toMatchObject({ action: 'add', changed: true, warnings: [] });
    expect(result.path).toBe('memory/gotchas/cache-do-atlas-guarda-sessao-antiga.md');
    expect(result.commit).toBe(await head(dir));
    expect(await commitCount(dir)).toBe(commitsBefore + 1);

    const text = await readText(dir, String(result.path));
    expect(text).toMatch(/^---\nid: /);
    expect(text).toMatch(/\norigin: agent:teste\n/);
    expect(text).toMatch(/\ntrust: medium\n/);
    expect(text).toMatch(/\nscope: project:atlas\n/);
    expect(text).toMatch(/\npart_of: \["\[\[Projeto Atlas\]\]"\]\n/);

    const message = await commitMessageOf(dir);
    expect(message).toMatch(
      /^vault backup: 2026-11-12 14:32:10\.482\n\nadd gotcha: Cache do Atlas guarda sessão antiga\n\n/,
    );
    expect(parseCommitTrailers(message)).toEqual({
      op: result.op,
      session,
      machine: 'maquina-a',
      client: 'teste',
      reverts: [],
    });
    expect(await commitFiles(dir, 'HEAD')).toEqual(['index.md', 'log.md', result.path].sort());
    expect(await porcelain(dir)).toBe('');
    expect((await readText(dir, 'log.md')).trimEnd().split('\n').at(-1)).toBe(
      '- 2026-11-12 · add gotcha: Cache do Atlas guarda sessão antiga',
    );
    expect(await readText(dir, 'index.md')).toContain('- [[cache-do-atlas-guarda-sessao-antiga]] · gotcha');
    await expectCatalogConsistent(dir);

    // banco: a busca acha a nota na hora
    const found = await brain.search({ query: 'cache-clear' });
    expect(found.hits.map((hit) => hit.path)).toEqual([result.path]);
    expect(found.hits[0]).toMatchObject({ trust: 'medium', origin: 'agent:teste', validity: 'current' });
    const read = await brain.read({ path: String(result.path) });
    expect(read.outgoing_links.map((link) => link.path)).toContain('wiki/entities/Projeto Atlas.md');
  });

  it('remember sem título usa a primeira linha; remember seguido de search acha a nota', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const result = await brain.remember({
      type: 'preference',
      content: '# Prefere pnpm a npm\n\nUse pnpm em todo projeto novo.\n',
    });
    expect(result.path).toBe('memory/preferences/prefere-pnpm-a-npm.md');
    expect((await brain.search({ query: 'pnpm' })).hits.map((hit) => hit.path)).toContain(result.path);
    const fact = await brain.remember({
      type: 'fact',
      content: 'O Atlas publica às sextas.\n',
      subject: 'Projeto Atlas',
      predicate: 'releases_on',
      object: 'sexta',
    });
    expect(fact.path).toMatch(/^memory\/facts\//);
    expect(await readText(dir, String(fact.path))).toMatch(/\nsubject: "\[\[Projeto Atlas\]\]"\n/);
    expect(await porcelain(dir)).toBe('');
  });

  it('segredo no conteúdo ou no frontmatter: recusa com regra e linha, sem ecoar o segredo, sem arquivo nem commit', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const before = await snapshot(dir);
    const sha = await head(dir);
    const token = fakeToken(7);
    const error = await errorOf(
      brain.remember({ type: 'gotcha', title: 'Token do CI', content: `Linha um.\nO token é ${token}\n` }),
    );
    expect(error.code).toBe('secret_detected');
    expect(error.details.secrets).toEqual([
      expect.objectContaining({ where: 'content', line: 2, rule: 'github-token', field: null }),
    ]);
    const json = JSON.stringify(error.toJSON());
    expect(json).not.toContain(token);
    expect(error.message).not.toContain(token);
    expect(error.message).toMatch(/linha 2/);
    expect(error.nextStep).toBeTruthy();

    const inFrontmatter = await errorOf(
      brain.writePage({
        path: 'wiki/concepts/Credenciais.md',
        mode: 'create',
        frontmatter: { type: 'concept', title: 'Credenciais', ci_token: token },
        content: 'Sem nada aqui.\n',
      }),
    );
    expect(inFrontmatter.code).toBe('secret_detected');
    expect(inFrontmatter.details.secrets?.[0]).toMatchObject({ where: 'frontmatter', field: 'ci_token' });
    expect(JSON.stringify(inFrontmatter.toJSON())).not.toContain(token);

    const patched = await errorOf(
      brain.patchPage({
        path: 'wiki/entities/SQS.md',
        old: (await brain.read({ path: 'wiki/entities/SQS.md' })).note.content.slice(0, 20),
        new: `chave ${token} `,
      }),
    );
    expect(patched.code).toBe('secret_detected');

    expect(await snapshot(dir)).toEqual(before);
    expect(await head(dir)).toBe(sha);
    expect(await porcelain(dir)).toBe('');
    expect((await brain.search({ query: 'Token do CI' })).hits).toEqual([]);
  });

  it('regra vinda de um agente é recusada; o usuário (CLI) pode criar', async () => {
    const dir = await createBrainRepo();
    const agent = await openTest(dir);
    const sha = await head(dir);
    const remembered = await errorOf(agent.remember({ type: 'rule', title: 'Sempre X', content: 'Sempre faça X.\n' }));
    expect(remembered.code).toBe('rule_requires_human');
    expect(remembered.nextStep).toMatch(/preference/);
    const page = await errorOf(
      agent.writePage({
        path: 'memory/rules/sempre-x.md',
        mode: 'create',
        frontmatter: { type: 'rule', title: 'Sempre X' },
        content: 'Sempre.\n',
      }),
    );
    expect(page.code).toBe('rule_requires_human');
    const patch = await errorOf(
      agent.patchPage({ path: 'memory/rules/nunca-commitar-segredos.md', old: 'Nunca grave', new: 'Grave' }),
    );
    expect(patch.code).toBe('rule_requires_human');
    expect(await head(dir)).toBe(sha);

    const human = await openTest(dir, { client: 'cli' });
    expect(human.actor).toBe('human');
    const rule = await human.remember({
      type: 'rule',
      title: 'Sempre rodar os testes',
      content: 'Rode os testes antes do commit.\n',
    });
    const text = await readText(dir, String(rule.path));
    expect(text).toMatch(/\ntrust: high\n/);
    expect(text).toMatch(/\norigin: human\n/);
    expect(parseCommitTrailers(await commitMessageOf(dir)).client).toBe('cli');
  });

  it('write_page: create, overwrite e append; campos do Cabeção protegidos; trust high de agente rebaixado', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const created = await brain.writePage({
      path: 'wiki/concepts/Backpressure.md',
      mode: 'create',
      frontmatter: { type: 'concept', title: 'Backpressure', tags: ['filas'], origin: 'human', trust: 'high', id: 'X' },
      content: '# Backpressure\n\nQuando o consumidor não dá conta.\n',
    });
    expect(created).toMatchObject({ action: 'add', path: 'wiki/concepts/Backpressure.md', changed: true });
    expect(created.warnings.map((w) => `${w.code}:${w.field}`).sort()).toEqual([
      'ignored_field:id',
      'ignored_field:origin',
      'trust_lowered:trust',
    ]);
    let text = await readText(dir, created.path);
    expect(text).toMatch(/\norigin: agent:teste\n/);
    expect(text).toMatch(/\ntrust: medium\n/);

    const appended = await brain.writePage({
      path: created.path,
      mode: 'append',
      content: '## Exemplo\n\nUm exemplo.\n',
    });
    expect(appended).toMatchObject({ action: 'update', changed: true });
    text = await readText(dir, created.path);
    expect(text).toMatch(/Quando o consumidor não dá conta\.\n\n## Exemplo\n\nUm exemplo\.\n$/);

    const overwritten = await brain.writePage({
      path: created.path,
      mode: 'overwrite',
      frontmatter: { title: 'Contrapressão', type: 'concept' },
      content: 'Texto novo.\n',
    });
    expect(overwritten.changed).toBe(true);
    text = await readText(dir, created.path);
    expect(text).toMatch(/\ntitle: Contrapressão\n/);
    expect(text).not.toMatch(/\ntags:/); // overwrite com frontmatter: só ficam os campos enviados e os do Cabeção
    expect(text).toMatch(/\nid: [0-9A-Z]{26}\n/);
    expect(text).toMatch(/\norigin: agent:teste\n/);
    expect(text).toMatch(/---\nTexto novo\.\n$/);

    const same = await brain.writePage({ path: created.path, mode: 'overwrite', content: 'Texto novo.\n' });
    expect(same).toMatchObject({ changed: false, commit: null });

    expect(
      (
        await errorOf(
          brain.writePage({
            path: created.path,
            mode: 'create',
            frontmatter: { type: 'concept', title: 'X' },
            content: '',
          }),
        )
      ).code,
    ).toBe('already_exists');
    expect((await errorOf(brain.writePage({ path: 'wiki/concepts/Nada.md', mode: 'append', content: 'x' }))).code).toBe(
      'not_found',
    );
    expect(
      (
        await errorOf(
          brain.writePage({
            path: 'wiki/concepts/Sem tipo.md',
            mode: 'create',
            frontmatter: { title: 'X' },
            content: '',
          }),
        )
      ).code,
    ).toBe('invalid_note');
    const noTitle = await errorOf(
      brain.writePage({
        path: 'wiki/concepts/Sem titulo.md',
        mode: 'create',
        frontmatter: { type: 'concept' },
        content: '',
      }),
    );
    expect(noTitle.code).toBe('invalid_note');
    expect(noTitle.details.issues?.some((issue) => issue.field === 'title')).toBe(true);
    expect(
      (
        await errorOf(
          brain.writePage({
            path: 'fora/x.md',
            mode: 'create',
            frontmatter: { type: 'concept', title: 'X' },
            content: '',
          }),
        )
      ).code,
    ).toBe('invalid_path');
    expect(
      (
        await errorOf(
          brain.writePage({
            path: '../x.md',
            mode: 'create',
            frontmatter: { type: 'concept', title: 'X' },
            content: '',
          }),
        )
      ).code,
    ).toBe('unsafe_path');
    expect(
      (
        await errorOf(
          brain.writePage({ path: created.path, mode: 'overwrite', frontmatter: { type: 'entity' }, content: '' }),
        )
      ).code,
    ).toBe('invalid_note');
    expect((await errorOf(brain.writePage({ path: created.path, mode: 'apagar' as never, content: '' }))).code).toBe(
      'invalid_argument',
    );
    expect(await porcelain(dir)).toBe('');
    await expectCatalogConsistent(dir);
  });

  it('patch_page: substituição exata e única', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const path = 'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md';
    const result = await brain.patchPage({ path, old: '`make db-reset`', new: '`make db-reset-all`' });
    expect(result).toMatchObject({ action: 'update', changed: true });
    expect(await readText(dir, path)).toContain('Rode `make db-reset-all` antes');
    const files = await commitFiles(dir, 'HEAD');
    expect(files).toContain(path);
    expect(files).toContain('log.md');
    const ambiguous = await errorOf(brain.patchPage({ path, old: 'make', new: 'gmake' }));
    expect(ambiguous.code).toBe('ambiguous_patch');
    expect(ambiguous.details.occurrences).toBe(2);
    expect((await errorOf(brain.patchPage({ path, old: 'não existe isto', new: 'x' }))).code).toBe('patch_not_found');
    expect((await errorOf(brain.patchPage({ path, old: '', new: 'x' }))).code).toBe('invalid_argument');
    expect(await porcelain(dir)).toBe('');
  });

  it('falha depois da gravação: arquivo, banco e git voltam ao estado anterior', async () => {
    const dir = await createBrainRepo();
    for (const step of ['written', 'indexed', 'cataloged'] as const) {
      const brain = await openTest(dir, {
        faultAt: (current) => {
          if (current === step) throw new Error(`falha simulada em ${current}`);
        },
      });
      const before = await snapshot(dir);
      const sha = await head(dir);
      await expect(brain.remember({ type: 'gotcha', title: `Falha ${step}`, content: 'zebralunar\n' })).rejects.toThrow(
        /falha simulada/,
      );
      await expect(
        brain.patchPage({ path: 'wiki/entities/SQS.md', old: '# SQS', new: '# zebralunar' }),
      ).rejects.toThrow(/falha simulada/);
      expect(await snapshot(dir)).toEqual(before);
      expect(await head(dir)).toBe(sha);
      expect(await porcelain(dir)).toBe('');
      expect((await brain.search({ query: 'zebralunar' })).hits).toEqual([]);
      await brain.close();
    }
    // e o cérebro continua utilizável
    const brain = await openTest(dir);
    await brain.remember({ type: 'gotcha', title: 'Depois da falha', content: 'zebralunar\n' });
    expect((await brain.search({ query: 'zebralunar' })).hits.length).toBe(1);
    expect(await porcelain(dir)).toBe('');
  });

  it('edição feita fora do Cabeção na mesma nota entra antes, num commit edit próprio', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    const path = 'wiki/entities/SQS.md';
    const original = await readText(dir, path);
    const edited = `${original}\nParágrafo escrito no Obsidian.\n`;
    await writeFile(join(dir, ...path.split('/')), edited);
    const before = await commitCount(dir);
    const result = await brain.writePage({ path, mode: 'append', content: 'Parágrafo do agente.\n' });
    expect(await commitCount(dir)).toBe(before + 2);
    const edit = await commitMessageOf(dir, 'HEAD~1');
    expect(edit).toMatch(/\n\nedit: 1 nota alterada fora do Cabeção\n- wiki\/entities\/SQS\.md\n\n/);
    expect(parseCommitTrailers(edit).client).toBe('manual');
    expect(parseCommitTrailers(await commitMessageOf(dir)).op).toBe(result.op);
    // desfazer a operação devolve a nota à versão do usuário, não à de antes da edição dele
    await brain.undo();
    expect(await readText(dir, path)).toBe(edited);
    expect(await porcelain(dir)).toBe('');
  });

  it('argumentos inválidos', async () => {
    const dir = await createBrainRepo();
    const brain = await openTest(dir);
    expect((await errorOf(brain.remember({ type: 'inventado', content: 'x' }))).code).toBe('invalid_argument');
    expect((await errorOf(brain.remember({ type: 'gotcha', content: '' }))).code).toBe('invalid_argument');
    expect((await errorOf(brain.remember({ type: 'gotcha', content: 'x', session_handle: 'abc' }))).code).toBe(
      'invalid_argument',
    );
    expect((await errorOf(brain.remember({ type: 'gotcha', content: 'x', relations: { amigo_de: ['A'] } }))).code).toBe(
      'invalid_argument',
    );
    const badDate = await errorOf(brain.remember({ type: 'gotcha', content: 'x', valid_until: '2026-13-40' }));
    expect(badDate.code).toBe('invalid_note');
  });
});
