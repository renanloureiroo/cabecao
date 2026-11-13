import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bareRemote,
  disposeSandbox,
  freshDir,
  git,
  machine,
  obsidianNote,
  parseJson,
  readNote,
  TEST_TIMEOUT_MS,
  writeNote,
} from './helpers.ts';

afterAll(() => {
  disposeSandbox();
});

describe('init', { timeout: TEST_TIMEOUT_MS }, () => {
  it('remoto vazio: cria, envia, monta o índice, roda o doctor e grava a configuração da máquina', async () => {
    const remote = await bareRemote();
    const a = machine('a');
    const dir = join(a.home, 'meu cérebro');
    const result = await a.cabecao(['init', remote, '--dir', dir, '--machine', 'maquina-a', '--no-clients']);
    expect(result.code).toBe(0);
    // o fim leva ao primeiro sucesso: "Pronto", onde ficou, o teste, os opcionais detectados e o diagnóstico curto
    expect(result.stdout).toMatch(/^Pronto\. Seu cérebro está em ~[\\/]meu cérebro \(máquina maquina-a\) e em /);
    expect(result.stdout).toContain('Repositório vazio');
    expect(result.stdout).toMatch(/Índice local: \d+ notas? indexadas?/);
    expect(result.stdout).toContain('Agentes: pulados (--no-clients)');
    expect(result.stdout).toContain('Teste agora:\n');
    expect(result.stdout).toContain('peça a ele: "guarde que eu prefiro respostas curtas, em tópicos"');
    expect(result.stdout).toContain('cabecao search "respostas curtas"');
    expect(result.stdout).toMatch(/Opcional \(rode quando quiser\):\n {2}cabecao schedule on/);
    expect(result.stdout).toContain('cabecao embeddings on');
    expect(result.stdout).toMatch(/Diagnóstico: \d+ ok, /);
    expect(result.stdout).toContain(`Em outra máquina, rode cabecao init ${remote}`);
    const json = parseJson(await machine('c').cabecao(['init', remote, '--no-clients', '--json']));
    expect(json.data.test).toHaveLength(3);
    expect(json.data.optional.map((step: { id: string }) => step.id)).toEqual(['schedule', 'embeddings']);
    // progresso no stderr, nada de stack
    expect(result.stderr).toContain('cabecao: consultando o remoto...');
    expect(result.stderr).not.toMatch(/\n\s+at /);

    expect(existsSync(join(dir, '.cabecao.json'))).toBe(true);
    expect(existsSync(join(dir, '.cabecao', 'cabecao.db'))).toBe(true);
    expect(await git(remote, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(await git(remote, ['log', '--oneline', 'main'])).not.toBe('');
    const config = JSON.parse(await readFile(join(a.configDir, 'config.json'), 'utf8'));
    expect(config).toEqual({ machine: 'maquina-a', defaultBrain: dir });
  });

  it('segunda máquina com a mesma URL: só baixa (joined); --json traz os cinco passos', async () => {
    const remote = await bareRemote();
    const a = machine('a');
    expect((await a.cabecao(['init', remote, '--dir', join(a.home, 'cabecao'), '--no-clients'])).code).toBe(0);
    await writeNote(join(a.home, 'cabecao'), 'wiki/concepts/filas.md', obsidianNote('Filas', 'Usamos SQS para filas.'));
    expect((await a.cabecao(['sync'])).code).toBe(0);

    const b = machine('b');
    const result = await b.cabecao(['init', remote, '--no-clients', '--json']);
    expect(result.code).toBe(0);
    const json = parseJson(result);
    expect(json.ok).toBe(true);
    expect(json.command).toBe('init');
    expect(json.data.init.case).toBe('joined');
    expect(json.data.init.root).toBe(join(b.home, 'cabecao'));
    expect(json.data.index.notes).toBeGreaterThan(0);
    expect(json.data.clients).toEqual({ skipped: true });
    expect(json.data.doctor.summary.fail).toBe(0);
    expect(json.data.doctor.checks.map((check: { id: string }) => check.id)).toContain('index');
    // em --json o stderr fica sem o progresso
    expect(result.stderr).toBe('');
    expect(await readNote(join(b.home, 'cabecao'), 'wiki/concepts/filas.md')).toContain('SQS');
  });

  it('sem URL: cérebro só local, e diz como ligar o remoto depois sem citar comando inexistente', async () => {
    const a = machine('a');
    const result = await a.cabecao(['init', '--no-clients']);
    expect(result.code).toBe(0);
    const dir = join(a.home, 'cabecao');
    expect(result.stdout).toContain('Cérebro criado só nesta máquina');
    expect(result.stdout).toContain('git remote add origin <url>');
    expect(result.stdout).toContain('git push -u origin main');
    expect(result.stdout).not.toContain('cabecao remote');
    expect(existsSync(join(dir, '.cabecao.json'))).toBe(true);

    // o caminho sugerido funciona: liga um remoto vazio e o sync envia
    const remote = await bareRemote();
    await git(dir, ['remote', 'add', 'origin', remote]);
    await git(dir, ['push', '--quiet', '-u', 'origin', 'main']);
    await writeNote(dir, 'wiki/concepts/nova.md', obsidianNote('Nova', 'Texto novo.'));
    const sync = await a.cabecao(['sync', '--json']);
    expect(sync.code).toBe(0);
    expect(parseJson(sync).data.pushed).toBe(1);
  });

  it('pasta que já é este cérebro: nada muda e os passos seguintes rodam de novo', async () => {
    const a = machine('a');
    expect((await a.cabecao(['init', '--no-clients'])).code).toBe(0);
    const again = await a.cabecao(['init', '--no-clients', '--json']);
    expect(again.code).toBe(0);
    expect(parseJson(again).data.init.case).toBe('already-initialized');
  });

  it('adota um vault de Markdown sem mover nada', async () => {
    const seed = freshDir('vault');
    await writeNote(seed, 'Notas/ideia.md', '# Ideia\n\nUma ideia qualquer.\n');
    await writeNote(seed, 'Notas/outra.md', '# Outra\n\nOutra nota.\n');
    await git(seed, ['init', '--quiet', '--initial-branch=main']);
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '--quiet', '-m', 'vault']);
    const remote = await bareRemote();
    await git(seed, ['push', '--quiet', remote, 'main']);

    const a = machine('a');
    const result = await a.cabecao(['init', remote, '--no-clients', '--json']);
    expect(result.code).toBe(0);
    expect(parseJson(result).data.init.case).toBe('adopted');
    expect(await readNote(join(a.home, 'cabecao'), 'Notas/ideia.md')).toContain('Uma ideia qualquer');
  });

  it('remoto com código: recusa, explica o que fazer, sai com 1 e não deixa nada', async () => {
    const seed = freshDir('codigo');
    await writeFile(join(seed, 'package.json'), '{"name":"app"}\n');
    await mkdir(join(seed, 'src'));
    for (let i = 0; i < 5; i++) await writeFile(join(seed, 'src', `m${i}.ts`), 'export {};\n');
    await git(seed, ['init', '--quiet', '--initial-branch=main']);
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '--quiet', '-m', 'app']);
    const remote = await bareRemote();
    await git(seed, ['push', '--quiet', remote, 'main']);

    const a = machine('a');
    const dir = join(a.home, 'cabecao');
    const result = await a.cabecao(['init', remote, '--no-clients']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('O cérebro não foi criado');
    expect(result.stderr).toContain('O que fazer: use um repositório vazio');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(a.configDir, 'config.json'))).toBe(false);

    const json = await a.cabecao(['init', remote, '--no-clients', '--json']);
    expect(json.code).toBe(1);
    expect(parseJson(json)).toMatchObject({ ok: false, command: 'init', data: { init: { case: 'refused' } } });
  });

  it('remoto que não existe: remote-error com o que fazer e a opção de começar só local', async () => {
    const a = machine('a');
    const missing = join(freshDir('nada'), 'nao-existe.git');
    const result = await a.cabecao(['init', missing, '--no-clients']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('O cérebro não foi criado');
    expect(result.stderr).toContain('O que fazer:');
    expect(result.stderr).toContain('"cabecao init" sem a URL');
    expect(existsSync(join(a.home, 'cabecao'))).toBe(false);
  });

  it('URL inválida: remote-error de URL, código 1', async () => {
    const a = machine('a');
    const result = await a.cabecao(['init', '--no-clients', '--json', '--', '-x']);
    expect(result.code).toBe(1);
    expect(parseJson(result).data.init).toMatchObject({ case: 'remote-error', error: { category: 'invalid-url' } });
  });

  it('pasta ocupada por outra coisa: target-not-empty, código 1, nada tocado', async () => {
    const a = machine('a');
    const dir = join(a.home, 'ocupada');
    await writeNote(dir, 'meu.txt', 'meu arquivo');
    const result = await a.cabecao(['init', '--dir', dir, '--no-clients']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('O que fazer: Escolha com --dir uma pasta que ainda não existe');
    expect(result.stderr).not.toContain('esvazie');
    expect(await readNote(dir, 'meu.txt')).toBe('meu arquivo');
  });

  it('registra o servidor nos clientes encontrados (pasta do usuário falsa), sem executar nada', async () => {
    const a = machine('a');
    await mkdir(join(a.home, '.cursor'), { recursive: true });
    await mkdir(join(a.home, '.gemini', 'antigravity-cli'), { recursive: true });
    const result = await a.cabecao(['init'], { binPath: join(a.home, 'bin-que-nao-existe.mjs') });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Agentes:');
    expect(result.stdout).toMatch(/Cursor +servidor MCP registrado em ~[\\/]\.cursor[\\/]mcp\.json/);
    expect(result.stdout).toMatch(/Antigravity +servidor MCP registrado/);
    expect(result.stdout).not.toContain('Gemini CLI');
    expect(result.stdout).toContain('1. No Cursor, peça:');
    // os dois leem skills: o opcional aparece, com o comando
    expect(result.stdout).toMatch(/cabecao install-skills +ensina Cursor, Antigravity a usar o cérebro/);
    const cursor = JSON.parse(await readFile(join(a.home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursor.mcpServers.cabecao.args.slice(-3)).toEqual(['mcp', '--brain', join(a.home, 'cabecao')]);
    expect(a.calls).toEqual([]);
    // o doctor do init lê o registro que acabou de ser feito
    const doctor = await a.cabecao(['doctor', '--offline', '--json'], {
      binPath: join(a.home, 'bin-que-nao-existe.mjs'),
    });
    const clients = parseJson(doctor).data.checks.find((check: { id: string }) => check.id === 'clients');
    expect(clients.status).toBe('ok');
  });

  it('erros de uso: duas URLs, --dir vazio, --dir e --brain diferentes', async () => {
    const a = machine('a');
    expect((await a.cabecao(['init', 'x', 'y'])).code).toBe(2);
    expect((await a.cabecao(['init', '--dir='])).code).toBe(2);
    expect((await a.cabecao(['init', '--dir', 'um', '--brain', 'outro'])).code).toBe(2);
  });
});
