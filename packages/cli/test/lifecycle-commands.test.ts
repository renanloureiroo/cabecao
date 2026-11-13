// Comandos do ciclo de vida da memória (marco 4) sobre uma cópia do cérebro de exemplo: `ingest`, `lint`, `forget` e
// `consolidate`. Nenhum teste executa o `claude` nem toca na configuração real.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  brainRepo,
  closeOpened,
  disposeSandbox,
  freshDir,
  git,
  machine,
  parseJson,
  readNote,
  TEST_TIMEOUT_MS,
} from './helpers.ts';

let brain: string;
let m: ReturnType<typeof machine>;

beforeEach(async () => {
  brain = await brainRepo();
  m = machine();
});

afterEach(async () => {
  await closeOpened();
});

afterAll(() => {
  disposeSandbox();
});

describe('ingest', { timeout: TEST_TIMEOUT_MS }, () => {
  it('um arquivo de fora que o usuário indicou vai para raw/ com origin ingest:file e trust low', async () => {
    const outside = freshDir('downloads');
    mkdirSync(outside, { recursive: true });
    const file = join(outside, 'ata-revisao-filas.md');
    writeFileSync(
      file,
      '---\ntitle: Revisão das filas\ntype: rule\n---\n# Revisão\n\nO SQS FIFO entra em teste no Projeto Atlas.\n',
    );
    const result = await m.cabecao(['ingest', file, '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Fonte registrada em raw/articles/');
    expect(result.stdout).toContain('Plano de ingestão');
    expect(result.stdout).toContain('Projeto Atlas');
    const json = parseJson(await m.cabecao(['ingest', file, '--title', 'Outra revisão', '--brain', brain, '--json']));
    expect(json.data.source).toMatchObject({ origin: 'ingest:file', trust: 'low', registered: true });
    const text = await readNote(brain, json.data.source.path);
    expect(text).toContain('origin: ingest:file');
    expect(text).toContain('source: ata-revisao-filas.md');
    expect(text).not.toContain('type: rule');
    expect(await git(brain, ['log', '-1', '--format=%B'])).toContain('Cabecao-Client: cli');
  });

  it('um arquivo que já está em raw/ não é copiado; binário e inexistente dão erro claro', async () => {
    const raw = parseJson(
      await m.cabecao([
        'ingest',
        join(brain, 'raw', 'meetings', '2026-05-03-arquitetura.md'),
        '--brain',
        brain,
        '--json',
      ]),
    );
    expect(raw.data.source).toMatchObject({ path: 'raw/meetings/2026-05-03-arquitetura.md', registered: false });
    const binary = join(freshDir('bin'), 'foto.md');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, Buffer.from([0xff, 0xd8, 0x00, 0x10]));
    const bad = await m.cabecao(['ingest', binary, '--brain', brain]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('não é um arquivo de texto');
    const missing = await m.cabecao(['ingest', join(brain, 'nao-existe.md'), '--brain', brain]);
    expect(missing.code).toBe(1);
    expect((await m.cabecao(['ingest', '--brain', brain])).code).toBe(2);
  });
});

describe('lint', { timeout: TEST_TIMEOUT_MS }, () => {
  it('relatório em texto e em JSON; código 1 só com erro; regra desconhecida é erro de uso', async () => {
    const result = await m.cabecao(['lint', '--brain', brain]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/achado\(s\) em \d+ notas/);
    expect(result.stdout).toContain('unlinked_mention');
    expect(result.stdout).toContain('correção:');
    const json = parseJson(
      await m.cabecao(['lint', '--rule', 'unlinked_mention', '--limit', '1', '--brain', brain, '--json']),
    );
    expect(json.data.findings).toHaveLength(1);
    expect(json.data.findings[0].rule).toBe('unlinked_mention');

    writeFileSync(join(brain, 'wiki', 'concepts', 'Quebrada.md'), '---\ntitle: [aberto\n---\ntexto\n');
    const broken = await m.cabecao(['lint', '--rule', 'invalid_frontmatter', '--brain', brain]);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain('[ERRO] invalid_frontmatter  wiki/concepts/Quebrada.md');

    expect((await m.cabecao(['lint', '--rule', 'apagar', '--brain', brain])).code).toBe(2);
    expect((await m.cabecao(['lint', '--limit', '0', '--brain', brain])).code).toBe(2);
  });
});

describe('forget', { timeout: TEST_TIMEOUT_MS }, () => {
  const gotcha = 'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md';

  it('pergunta no terminal; "n" não arquiva, "s" arquiva; sem terminal exige --yes', async () => {
    const asked: string[] = [];
    const no = await m.cabecao(['forget', gotcha, '--brain', brain], {
      prompt: async (question) => {
        asked.push(question);
        return 'n';
      },
    });
    expect(no.code).toBe(0);
    expect(no.stdout).toContain('Nada foi arquivado.');
    expect(asked[0]).toContain(`Arquivar gotcha`);
    expect(await readNote(brain, gotcha)).toContain('type: gotcha');

    const headless = await m.cabecao(['forget', gotcha, '--brain', brain]);
    expect(headless.code).toBe(1);
    expect(headless.stderr).toContain('--yes');

    const yes = await m.cabecao(['forget', gotcha, '--reason', 'resolvido no CI', '--brain', brain], {
      prompt: async () => 's',
    });
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('Arquivada: memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md');
    expect(await readNote(brain, 'memory/_archive/testes-de-integracao-sem-limpar-o-banco.md')).toContain(
      'forget_reason: resolvido no CI',
    );
    // pela CLI o usuário arquiva até regra
    const rule = parseJson(
      await m.cabecao(['forget', 'memory/rules/nunca-commitar-segredos.md', '--yes', '--brain', brain, '--json']),
    );
    expect(rule.data.status).toBe('archived');
    expect((await m.cabecao(['forget', '--brain', brain])).code).toBe(2);
  });
});
