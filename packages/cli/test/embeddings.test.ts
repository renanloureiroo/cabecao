// Comandos do marco 2 pela CLI, com o embedder falso de teste (`CABECAO_TEST_FAKE_EMBEDDER=1`: sem rede, sem
// runtime, sem download): embeddings on/off/status/switch, search --mode, sync com o índice, compact, eval, reindex e
// as verificações novas do doctor.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBrainConfig, runGit } from '@cabecao/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkEmbeddings,
  checkEmbeddingsModel,
  checkEmbeddingsPending,
  checkEmbeddingsRuntime,
  type DoctorFacts,
} from '../src/doctor/checks.ts';
import { FAKE_EMBEDDER_ENV } from '../src/embeddings.ts';
import { bareRemote, brainRepo, disposeSandbox, git, machine, parseJson, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(() => {
  disposeSandbox();
});

/** Uma máquina com o embedder falso ligado. */
function fakeMachine(name: string) {
  const m = machine(name);
  const env = { ...m.env, [FAKE_EMBEDDER_ENV]: '1', CABECAO_CACHE_DIR: join(m.home, 'cache') };
  return {
    ...m,
    env,
    // `embeddings` e `compact` são só do usuário no terminal: por padrão, um terminal controlador em que ninguém
    // responde (cada teste que pergunta injeta o seu); `{ terminal: undefined }` simula um agente
    run: (args: readonly string[], extra: Parameters<typeof m.cabecao>[1] = {}) =>
      m.cabecao(args, { env, terminal: { prompt: async () => null }, ...extra }),
  };
}

async function withRemote(): Promise<{ a: string; remote: string }> {
  const a = await brainRepo('a');
  const remote = await bareRemote();
  await git(a, ['remote', 'add', 'origin', remote]);
  await git(a, ['push', '--quiet', '-u', 'origin', 'main']);
  return { a, remote };
}

describe('cabecao embeddings', { timeout: TEST_TIMEOUT_MS * 2 }, () => {
  it('on sem terminal é de agente: recusado (só o usuário no terminal); sem resposta no terminal, nada muda', async () => {
    const dir = await brainRepo();
    const m = fakeMachine('a');
    const agent = await m.run(['embeddings', 'on', 'multilingual-e5-small', '--brain', dir, '--json'], {
      terminal: undefined,
    });
    expect(agent.code).toBe(4);
    expect(parseJson(agent).error.code).toBe('human_only');
    const status = await m.run(['embeddings', 'status', '--brain', dir, '--json'], { terminal: undefined });
    expect(status.code, status.stderr).toBe(0);
    const result = await m.run(['embeddings', 'on', '--brain', dir, '--json']);
    expect(result.code).toBe(1);
    const out = parseJson(result);
    expect(out.error.code).toBe('model_required');
    expect(result.stderr).toMatch(/multilingual-e5-small/);
    expect(result.stderr).toMatch(/Gemma Terms of Use/);
    expect((await readBrainConfig(dir)).embedding).toBeUndefined();
  });

  it('on pergunta no terminal, grava a escolha num commit e calcula; status e search mostram o modo híbrido', async () => {
    const dir = await brainRepo();
    const m = fakeMachine('a');
    const asked: string[] = [];
    const prompt = async (question: string) => {
      asked.push(question);
      return '5';
    };
    // o usuário num terminal controlador: a pergunta vai a ele (o terminal é injetado)
    const result = await m.run(['embeddings', 'on', '--brain', dir], { terminal: { prompt } });
    expect(result.code, result.stderr).toBe(0);
    expect(asked[0]).toMatch(/Qual modelo/);
    expect(result.stderr).toMatch(/Modelos sugeridos/);
    expect(result.stderr).toMatch(/FALSO de teste/);
    expect(result.stdout).toMatch(/ligada com multilingual-e5-small/);
    const config = await readBrainConfig(dir);
    expect(config.embedding).toMatchObject({ model: 'multilingual-e5-small', variant: 'q8', dims: 384, recipe: 1 });
    expect(await git(dir, ['log', '-1', '--format=%B'])).toMatch(/modelo de embeddings multilingual-e5-small/);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');

    const status = parseJson(await m.run(['embeddings', 'status', '--brain', dir, '--json'])).data;
    expect(status).toMatchObject({ configured: true, model: 'multilingual-e5-small', pending: 0, fake: true });
    expect(status.index_bytes).toBeGreaterThan(1000);
    const text = await m.run(['embeddings', 'status', '--brain', dir]);
    expect(text.stdout).toMatch(/sem vetor \(na fila\): 0/);
    expect(text.stdout).toMatch(/Tamanho da branch de índice/);

    const search = parseJson(await m.run(['search', 'filas', '--brain', dir, '--json'])).data;
    expect(search.mode_used).toBe('hybrid');
    const keyword = parseJson(await m.run(['search', 'filas', '--mode', 'keyword', '--brain', dir, '--json'])).data;
    expect(keyword.mode_used).toBe('keyword');
    const shown = await m.run(['search', 'filas', '--brain', dir]);
    expect(shown.stdout).toMatch(/por palavra-chave e significado/);
    expect(shown.stdout).toMatch(/Modo: hybrid/);
    const bad = await m.run(['search', 'filas', '--mode', 'vector', '--brain', dir]);
    expect(bad.code).toBe(2);

    const brainStatus = await m.run(['status', '--brain', dir]);
    expect(brainStatus.stdout).toMatch(/trechos sem vetor: 0 de \d+/);
  });

  it('licença que não é de código aberto: pergunta no terminal (sem resposta, cancela); --yes aceita', async () => {
    const dir = await brainRepo();
    const m = fakeMachine('a');
    const refused = await m.run(['embeddings', 'on', 'embeddinggemma-300m', '--brain', dir, '--json']);
    expect(refused.code).toBe(1);
    expect(parseJson(refused).error.code).toBe('cancelled');
    expect((await readBrainConfig(dir)).embedding).toBeUndefined();
    const accepted = await m.run(['embeddings', 'on', 'embeddinggemma-300m', '--yes', '--brain', dir, '--json']);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(parseJson(accepted).data).toMatchObject({ model: 'embeddinggemma-300m', variant: 'q4', chosen_now: true });
  });

  it('segunda máquina: on usa o modelo já gravado, sem perguntar e sem calcular o que veio pelo sync', async () => {
    const { a, remote } = await withRemote();
    const ma = fakeMachine('a');
    expect((await ma.run(['embeddings', 'on', 'multilingual-e5-small', '--brain', a])).code).toBe(0);
    const synced = parseJson(await ma.run(['sync', '--brain', a, '--json'])).data;
    expect(synced.status).toBe('ok');
    expect(synced.index.pushed).toBeGreaterThan(20);
    const syncText = await ma.run(['sync', '--brain', a]);
    expect(syncText.stdout).toMatch(/Índice: vetores recebidos 0 · calculados 0 · enviados 0 · geração 0/);

    const b = join(a, '..', 'b');
    await runGit(['clone', '--quiet', remote, b], { cwd: join(a, '..') });
    const mb = fakeMachine('b');
    const on = await mb.run(['embeddings', 'on', '--brain', b, '--json']);
    expect(on.code, on.stderr).toBe(0);
    expect(parseJson(on).data).toMatchObject({
      model: 'multilingual-e5-small',
      chosen_now: false,
      computed: 0,
      commit: null,
    });
    const other = await mb.run(['embeddings', 'on', 'bge-m3', '--brain', b, '--json']);
    expect(parseJson(other).error.code).toBe('model_already_chosen');
    expect(parseJson(other).error.hint).toMatch(/embeddings switch bge-m3/);
  });

  it('off desliga só nesta máquina; on religa', async () => {
    const dir = await brainRepo();
    const m = fakeMachine('a');
    expect((await m.run(['embeddings', 'on', 'multilingual-e5-small', '--brain', dir])).code).toBe(0);
    const off = await m.run(['embeddings', 'off', '--brain', dir]);
    expect(off.code).toBe(0);
    expect(off.stdout).toMatch(/desligada NESTA máquina/);
    expect((await readBrainConfig(dir)).embedding?.model).toBe('multilingual-e5-small');
    expect(parseJson(await m.run(['search', 'filas', '--brain', dir, '--json'])).data.mode_used).toBe('keyword');
    expect(parseJson(await m.run(['embeddings', 'status', '--brain', dir, '--json'])).data.enabled_here).toBe(false);
    expect((await m.run(['embeddings', 'on', '--brain', dir])).code).toBe(0);
    expect(parseJson(await m.run(['search', 'filas', '--brain', dir, '--json'])).data.mode_used).toBe('hybrid');
  });

  it('switch troca o modelo depois de calcular tudo; compact tira a pasta antiga', async () => {
    const { a } = await withRemote();
    const m = fakeMachine('a');
    expect((await m.run(['embeddings', 'on', 'multilingual-e5-small', '--brain', a])).code).toBe(0);
    const switched = await m.run(['embeddings', 'switch', 'multilingual-e5-base', '--brain', a, '--json']);
    expect(switched.code, switched.stderr).toBe(0);
    expect(parseJson(switched).data).toMatchObject({ switched: true, from: 'multilingual-e5-small-q8-fake-r1' });
    expect((await readBrainConfig(a)).embedding?.model).toBe('multilingual-e5-base');
    const compact = await m.run(['compact', '--brain', a]);
    expect(compact.code, compact.stderr).toBe(0);
    expect(compact.stdout).toMatch(/geração 0 → 1/);
    expect(compact.stdout).toMatch(/multilingual-e5-small-q8-fake-r1/);
    expect(compact.stdout).toMatch(/Envio da geração nova: ok/);
    const noIndex = await m.run(['compact', '--brain', await brainRepo('sem-indice')]);
    expect(noIndex.stdout).toMatch(/Nada a compactar/);
    expect((await m.run(['embeddings', 'switch', '--brain', a])).code).toBe(2);
    expect((await m.run(['embeddings', 'quebrado', '--brain', a])).code).toBe(2);
  });

  it('eval imprime a tabela de métricas; reindex --full reconstrói o banco', async () => {
    const dir = await brainRepo();
    const m = fakeMachine('a');
    expect((await m.run(['embeddings', 'on', 'multilingual-e5-small', '--brain', dir])).code).toBe(0);
    const questions = join(dir, '..', 'perguntas.jsonl');
    await writeFile(
      questions,
      '# perguntas\n{"query": "RabbitMQ", "expected": "wiki/entities/RabbitMQ.md", "kind": "exact"}\n{"query": "custo de operação das filas", "expected": ["wiki/decisions/usar-sqs-para-filas.md"], "kind": "paraphrase"}\n',
    );
    const evaluated = await m.run(['eval', questions, '--brain', dir]);
    expect(evaluated.code, evaluated.stderr).toBe(0);
    expect(evaluated.stdout).toMatch(/configuração\s+MRR\s+nDCG/);
    expect(evaluated.stdout).toMatch(/^keyword\s+1,000/m);
    expect(evaluated.stdout).toMatch(/fusion α=0\.5/);
    expect(evaluated.stdout).toMatch(/MRR por tipo de pergunta/);
    const json = parseJson(await m.run(['eval', questions, '--alpha', '0.4', '--k', '5', '--brain', dir, '--json']));
    expect(json.data.report.configs.map((c: { name: string }) => c.name)).toEqual([
      'keyword',
      'vector',
      'fusion α=0.4',
    ]);
    const broken = join(dir, '..', 'ruim.jsonl');
    await writeFile(broken, '{"query": "x", "expect": "y"}\n');
    const bad = await m.run(['eval', broken, '--brain', dir, '--json']);
    expect(bad.code).toBe(1);
    expect(parseJson(bad).error.code).toBe('EEVALQUESTIONS');

    const reindexed = parseJson(await m.run(['reindex', '--full', '--brain', dir, '--json'])).data;
    expect(reindexed.full).toBe(true);
    expect(reindexed.total).toBeGreaterThan(20);
    expect((await m.run(['reindex', '--brain', dir])).stdout).toMatch(/Banco local atualizado/);
  });

  it('doctor mostra a busca por significado e os trechos sem embedding', async () => {
    const dir = await brainRepo();
    const m = fakeMachine('a');
    const before = parseJson(await m.run(['doctor', '--offline', '--brain', dir, '--json'])).data;
    expect(before.checks.find((c: { id: string }) => c.id === 'embeddings')?.message).toMatch(/desativada/);
    expect((await m.run(['embeddings', 'on', 'multilingual-e5-small', '--brain', dir])).code).toBe(0);
    await writeFile(join(dir, 'wiki', 'concepts', 'Nova.md'), '---\ntitle: Nova\n---\nTexto sem vetor.\n');
    await m.run(['reindex', '--brain', dir]);
    const after = parseJson(await m.run(['doctor', '--offline', '--brain', dir, '--json'])).data;
    const pending = after.checks.find((c: { id: string }) => c.id === 'embeddings-pending');
    expect(pending?.status).toBe('warn');
    expect(pending?.message).toMatch(/^1 de \d+ trechos sem embedding/);
  });
});

describe('verificações do doctor (puras)', () => {
  const base: DoctorFacts = {
    platform: 'linux',
    nodeVersion: '24.0.0',
    git: { kind: 'ok', version: '2.45.0', supported: true, minimum: '2.38' },
    brain: { kind: 'resolved', root: '/c' },
  };
  const configured = {
    kind: 'configured' as const,
    model: 'multilingual-e5-small',
    variant: 'q8',
    revision: '0123456789abcdef0123456789abcdef01234567',
    enabledHere: true,
    fake: false,
    modelDir: 'multilingual-e5-small-q8-r1',
    runtime: { installed: true, upToDate: true, backend: 'native', problem: null, dir: '/cache/runtime' },
    modelCached: true,
    chunks: 10,
    pending: 0,
  };

  it('tudo pronto: ok nas quatro', () => {
    const facts = { ...base, embeddings: configured };
    for (const check of [checkEmbeddings, checkEmbeddingsRuntime, checkEmbeddingsModel, checkEmbeddingsPending]) {
      expect(check(facts)?.status).toBe('ok');
    }
  });

  it('segunda máquina sem runtime, sem modelo, sem revisão e com fila: UM aviso, com tudo nos itens e a correção', () => {
    const facts = {
      ...base,
      embeddings: {
        ...configured,
        revision: null,
        runtime: { ...configured.runtime, installed: false, problem: 'sem manifesto' },
        modelCached: false,
        pending: 3,
      },
    };
    expect(checkEmbeddings(facts)).toMatchObject({
      status: 'warn',
      message: expect.stringMatching(/ligada no cérebro, mas falta nesta máquina/),
      fix: expect.stringMatching(/embeddings on/),
      items: [
        'runtime não instalado (sem manifesto)',
        expect.stringMatching(/modelo .* não baixado/),
        '3 de 10 trechos sem vetor',
        expect.stringMatching(/sem revisão/),
      ],
    });
    // a mesma causa não vira quatro avisos
    expect(checkEmbeddingsRuntime(facts)).toBeNull();
    expect(checkEmbeddingsModel(facts)).toBeNull();
    expect(checkEmbeddingsPending(facts)).toBeNull();
  });

  it('com o runtime e o modelo nesta máquina: revisão e fila continuam como avisos próprios', () => {
    const facts = { ...base, embeddings: { ...configured, revision: null, pending: 3 } };
    expect(checkEmbeddings(facts)).toMatchObject({ status: 'warn', message: expect.stringMatching(/sem revisão/) });
    expect(checkEmbeddingsPending(facts)?.message).toMatch(/^3 de 10 trechos sem embedding/);
  });

  it('configuração inválida é falha; desligada aqui não verifica runtime nem modelo; desativada é ok', () => {
    const invalid = {
      ...base,
      embeddings: {
        kind: 'invalid' as const,
        model: 'x',
        variant: 'y',
        revision: null,
        enabledHere: true,
        fake: false,
        message: 'modelo desconhecido',
      },
    };
    expect(checkEmbeddings(invalid)?.status).toBe('fail');
    const off = { ...base, embeddings: { ...configured, enabledHere: false } };
    expect(checkEmbeddings(off)?.message).toMatch(/desligada nesta máquina/);
    expect(checkEmbeddingsRuntime(off)).toBeNull();
    expect(checkEmbeddingsModel(off)).toBeNull();
    expect(checkEmbeddings({ ...base, embeddings: { kind: 'off' } })?.status).toBe('ok');
    expect(checkEmbeddings(base)).toBeNull();
  });
});
