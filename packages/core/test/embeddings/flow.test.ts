// Fluxo completo da busca por significado entre duas máquinas e um remoto bare, com o embedder falso (sem rede):
// ativar na A, sincronizar, entrar com a B pelo clone sem calcular nada, buscar nas duas e ver o mesmo resultado; só
// o que mudou é recalculado; o grafo exportado é idêntico byte a byte; compactação, troca de modelo e eval.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/git/index.ts';
import { GRAPH_EDGES_PATH, GRAPH_NODES_PATH, readIndexFile } from '../../src/indexstore/index.ts';
import { readBrainConfig } from '../../src/vault/index.ts';
import { cleanupAll, createBrainRepo, disposeSandbox, git, readText, TEST_TIMEOUT_MS } from '../brain/helpers.ts';
import { cloneMachine, fakeProvider, hitPaths, openHuman, remoteRefs, TEST_EMBEDDING } from './helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

/** Remoto bare com o cérebro de exemplo e a máquina A, já com o primeiro envio. */
async function world(): Promise<{ a: string; remote: string }> {
  const a = await createBrainRepo('a');
  const remote = join(a, '..', 'remoto.git');
  await runGit(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  await git(a, ['remote', 'add', 'origin', remote]);
  await git(a, ['push', '--quiet', '-u', 'origin', 'main']);
  return { a, remote };
}

const QUESTION = 'por que trocamos o broker de mensagens?';

describe('embeddings entre duas máquinas', { timeout: TEST_TIMEOUT_MS * 2 }, () => {
  it('A ativa e sincroniza; B entra pelo clone sem calcular nenhum vetor; a busca híbrida dá o mesmo resultado nas duas', async () => {
    const { a, remote } = await world();
    const providerA = fakeProvider();
    const brainA = await openHuman(a, providerA);
    await brainA.setEmbedding(TEST_EMBEDDING);
    const computed = await brainA.computeEmbeddings();
    expect(computed.computed).toBeGreaterThan(20);
    expect(computed.pending).toBe(0);
    expect(providerA.stats.passages).toBe(computed.computed);

    const synced = await brainA.sync();
    expect(synced.status).toBe('ok');
    expect(synced.index).toMatchObject({ participating: true, computed: 0, pending: 0, generation: 0, error: null });
    expect(synced.index?.pushed).toBe(computed.computed);
    const refs = await remoteRefs(remote);
    expect(refs.get('refs/heads/cabecao/index')).toBeDefined();
    expect(refs.get('refs/heads/main')).toBe(await git(a, ['rev-parse', 'HEAD']));

    // segunda máquina: `init` com a URL é um clone comum, que traz a branch de índice
    const b = await cloneMachine(remote, 'b');
    expect((await readBrainConfig(b)).embedding).toMatchObject(TEST_EMBEDDING);
    const providerB = fakeProvider();
    const brainB = await openHuman(b, providerB);
    const syncB = await brainB.sync();
    expect(syncB.status).toBe('ok');
    expect(syncB.index).toMatchObject({ participating: true, computed: 0, pending: 0, pushed: 0 });
    expect(providerB.stats.passages).toBe(0);
    const statusB = await brainB.embeddingsStatus();
    expect(statusB).toMatchObject({ configured: true, pending: 0, runtime: 'ready', generation: 0 });
    expect(statusB.with_vector).toBe(statusB.chunks);

    const onA = await brainA.search({ query: QUESTION });
    const onB = await brainB.search({ query: QUESTION });
    expect(onA.mode_used).toBe('hybrid');
    expect(onA.mode_requested).toBe('auto');
    expect(onA.warnings).toEqual([]);
    expect(hitPaths(onB)).toEqual(hitPaths(onA));
    expect(onB.hits.map((hit) => hit.score)).toEqual(onA.hits.map((hit) => hit.score));
    expect(providerB.stats.passages).toBe(0);
    expect(providerB.stats.queries).toBe(1);
  });

  it('só o que falta é calculado: editar recalcula o trecho; mover não recalcula; mudar o título recalcula a nota', async () => {
    const { a } = await world();
    const provider = fakeProvider();
    const brain = await openHuman(a, provider);
    await brain.setEmbedding(TEST_EMBEDDING);
    const first = await brain.computeEmbeddings();
    expect(first.computed).toBe(first.chunks);

    // nada mudou: nada a calcular, e o modelo nem carrega
    const loads = provider.stats.loads;
    expect((await brain.computeEmbeddings()).computed).toBe(0);
    expect(provider.stats.loads).toBe(loads);

    // editar um parágrafo: só o trecho afetado
    const sqs = 'wiki/decisions/usar-sqs-para-filas.md';
    const text = await readText(a, sqs);
    writeFileSync(join(a, sqs), text.replace('por custo de operação.', 'por custo de operação e menos plantão.'));
    expect((await brain.computeEmbeddings()).computed).toBe(1);

    // mover/renomear o arquivo: a chave é o texto embutido, que não muda
    await git(a, ['add', '-A']);
    await git(a, ['commit', '--quiet', '-m', 'edição']);
    await git(a, ['mv', sqs, 'wiki/decisions/sqs-movida.md']);
    await git(a, ['commit', '--quiet', '-m', 'mover']);
    expect((await brain.computeEmbeddings()).computed).toBe(0);

    // mudar o título (frontmatter): o prefixo de contexto muda em todos os trechos da nota
    const moved = await readText(a, 'wiki/decisions/sqs-movida.md');
    const sections = (moved.match(/^## /gm) ?? []).length + 1;
    writeFileSync(
      join(a, 'wiki/decisions/sqs-movida.md'),
      moved
        .replace('title: Usar SQS para filas', 'title: Adotar SQS nas filas')
        .replace('# Usar SQS para filas', '# Adotar SQS nas filas'),
    );
    expect((await brain.computeEmbeddings()).computed).toBe(sections);

    // mudar só tags (frontmatter fora do título): nada
    const tagged = await readText(a, 'wiki/decisions/sqs-movida.md');
    writeFileSync(
      join(a, 'wiki/decisions/sqs-movida.md'),
      tagged.replace('tags: [infra, filas]', 'tags: [infra, filas, aws]'),
    );
    expect((await brain.computeEmbeddings()).computed).toBe(0);
  });

  it('a ativação e as edições feitas na A chegam à B como vetores: B recebe e não recalcula', async () => {
    const { a, remote } = await world();
    // a B já existia antes de a A ativar a busca por significado
    const b = await cloneMachine(remote, 'b');
    const providerB = fakeProvider();
    const brainB = await openHuman(b, providerB);
    expect((await brainB.sync()).index?.participating).toBe(false);
    const brainA = await openHuman(a, fakeProvider());
    await brainA.setEmbedding(TEST_EMBEDDING);
    const computed = await brainA.computeEmbeddings();
    expect((await brainA.sync()).status).toBe('ok');
    // o modelo e os vetores chegam no mesmo sync
    const first = await brainB.sync();
    expect(first.pulled).toBe(1);
    expect(first.index).toMatchObject({ participating: true, received: computed.computed, computed: 0, pending: 0 });
    expect((await brainB.search({ query: 'filas' })).mode_used).toBe('hybrid');

    writeFileSync(
      join(a, 'wiki/concepts/Novo.md'),
      '---\ntitle: Conceito novo\n---\nUm texto inédito sobre zebras lunares.\n',
    );
    const syncA = await brainA.sync();
    expect(syncA.index?.computed).toBe(1);
    expect(syncA.index?.pushed).toBe(1);
    const syncB = await brainB.sync();
    expect(syncB.pulled).toBe(1);
    expect(syncB.index).toMatchObject({ received: 1, computed: 0, pending: 0 });
    expect(providerB.stats.passages).toBe(0);
  });

  it('o grafo exportado vai para a branch de índice e é idêntico byte a byte nas duas máquinas', async () => {
    const { a, remote } = await world();
    const brainA = await openHuman(a, fakeProvider());
    await brainA.setEmbedding(TEST_EMBEDDING);
    const syncA = await brainA.sync();
    expect(syncA.index?.graph_written).toBe(true);
    const b = await cloneMachine(remote, 'b');
    const brainB = await openHuman(b, fakeProvider());
    const syncB = await brainB.sync();
    // B gera o mesmo grafo a partir das mesmas notas: nada a gravar
    expect(syncB.index?.graph_written).toBe(false);
    const nodesA = await readIndexFile(a, GRAPH_NODES_PATH);
    const nodesB = await readIndexFile(b, GRAPH_NODES_PATH);
    const edgesA = await readIndexFile(a, GRAPH_EDGES_PATH);
    expect(nodesA?.length).toBeGreaterThan(100);
    expect(edgesA?.length).toBeGreaterThan(100);
    expect(nodesB?.equals(nodesA as Buffer)).toBe(true);
    expect((await readIndexFile(b, GRAPH_EDGES_PATH))?.equals(edgesA as Buffer)).toBe(true);
    // e a B, regenerando do zero no próprio banco, chega aos mesmos bytes
    await brainB.reindex({ full: true });
    expect((await brainB.sync()).index?.graph_written).toBe(false);
  });

  it('cérebro sem embedding configurado: o sync não cria branch de índice (nem só para o grafo)', async () => {
    const { a, remote } = await world();
    const brain = await openHuman(a, fakeProvider());
    writeFileSync(join(a, 'wiki/concepts/Outro.md'), '---\ntitle: Outro\n---\nTexto.\n');
    const synced = await brain.sync();
    expect(synced.status).toBe('ok');
    expect(synced.index).toMatchObject({ participating: false, computed: 0 });
    expect([...(await remoteRefs(remote)).keys()].some((ref) => ref.includes('cabecao/index'))).toBe(false);
    expect(await git(a, ['for-each-ref', 'refs/heads/cabecao/'])).toBe('');
    const searched = await brain.search({ query: 'filas' });
    expect(searched.mode_used).toBe('keyword');
    expect(searched.mode_reason).toMatch(/não está ativada/);
  });

  it('sem runtime nesta máquina, o sync continua e só diz quantos trechos estão sem embedding', async () => {
    const { a, remote } = await world();
    const brainA = await openHuman(a, fakeProvider());
    await brainA.setEmbedding(TEST_EMBEDDING);
    await brainA.computeEmbeddings();
    expect((await brainA.sync()).status).toBe('ok');
    const b = await cloneMachine(remote, 'b');
    const brainB = await openHuman(b, fakeProvider({ unavailable: true }));
    writeFileSync(join(b, 'wiki/concepts/Na B.md'), '---\ntitle: Na B\n---\nEscrito sem runtime.\n');
    const synced = await brainB.sync();
    expect(synced.status).toBe('ok');
    expect(synced.pushed).toBe(1);
    expect(synced.index).toMatchObject({ participating: true, computed: 0, pending: 1 });
    expect(synced.index?.skipped).toMatch(/não está instalado/);
    // e a busca em modo auto cai para palavra-chave, dizendo por quê
    const searched = await brainB.search({ query: 'filas' });
    expect(searched.mode_used).toBe('keyword');
    expect(searched.mode_reason).toMatch(/não está instalado/);
    // a A calcula o que faltou no próximo sync dela
    expect((await brainA.sync()).index).toMatchObject({ computed: 1, pending: 0 });
  });

  it('embeddings off: esta máquina para de calcular e de buscar por significado, sem mexer no cérebro', async () => {
    const { a } = await world();
    const { setLocalEmbeddingsDisabled } = await import('../../src/embeddings/index.ts');
    const provider = fakeProvider();
    const brain = await openHuman(a, provider);
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    await setLocalEmbeddingsDisabled(a, true);
    writeFileSync(join(a, 'wiki/concepts/Desligado.md'), '---\ntitle: Desligado\n---\nTexto.\n');
    const synced = await brain.sync();
    expect(synced.index).toMatchObject({ participating: true, computed: 0, pending: 1 });
    expect(synced.index?.skipped).toMatch(/desligada nesta máquina/);
    expect((await brain.search({ query: 'filas' })).mode_used).toBe('keyword');
    expect((await brain.embeddingsStatus()).enabled_here).toBe(false);
    expect((await readBrainConfig(a)).embedding).toMatchObject(TEST_EMBEDDING);
    await expect(brain.computeEmbeddings()).rejects.toMatchObject({ code: 'embeddings_unavailable' });
    await setLocalEmbeddingsDisabled(a, false);
    expect((await brain.search({ query: 'filas' })).mode_used).toBe('hybrid');
  });

  it('compact na A abre uma geração nova; a B, com vetores ainda não enviados, migra sozinha sem perder nada', async () => {
    const { a, remote } = await world();
    const brainA = await openHuman(a, fakeProvider());
    await brainA.setEmbedding(TEST_EMBEDDING);
    await brainA.computeEmbeddings();
    expect((await brainA.sync()).status).toBe('ok');
    const b = await cloneMachine(remote, 'b');
    const providerB = fakeProvider();
    const brainB = await openHuman(b, providerB);
    expect((await brainB.sync()).index?.computed).toBe(0);

    // B escreve e calcula o vetor, mas ainda não envia
    writeFileSync(
      join(b, 'wiki/concepts/Só na B.md'),
      '---\ntitle: Só na B\n---\nVetor calculado antes da compactação.\n',
    );
    expect((await brainB.computeEmbeddings()).computed).toBe(1);

    // A apaga uma nota (o vetor dela vira órfão) e compacta
    await git(a, ['rm', '--quiet', 'wiki/entities/Lumen Logística.md']);
    await git(a, ['commit', '--quiet', '-m', 'remove']);
    expect((await brainA.sync()).status).toBe('ok');
    const compacted = await brainA.compactIndex();
    expect(compacted?.generation).toEqual({ from: 0, to: 1 });
    expect(compacted?.removed.orphans).toBeGreaterThan(0);
    const pushedGen = await brainA.sync();
    expect(pushedGen.index?.generation).toBe(1);
    expect((await remoteRefs(remote)).has('refs/heads/cabecao/index-1')).toBe(true);

    // B sincroniza: adota a geração 1 e drena dela o vetor que só a B tinha
    const syncB = await brainB.sync();
    expect(syncB.status).toBe('ok');
    expect(syncB.index).toMatchObject({ generation: 1, computed: 0, pending: 0 });
    expect(providerB.stats.passages).toBe(1);
    const syncA = await brainA.sync();
    expect(syncA.index).toMatchObject({ generation: 1, computed: 0, pending: 0 });
    expect(await git(b, ['for-each-ref', '--format=%(refname)', 'refs/heads/cabecao/'])).toBe(
      'refs/heads/cabecao/index-1',
    );
  });

  it('switch: calcula tudo numa pasta nova; o modelo antigo segue em uso até o fim; a troca chega à outra máquina', async () => {
    const { a, remote } = await world();
    const providerA = fakeProvider();
    const brainA = await openHuman(a, providerA);
    await brainA.setEmbedding(TEST_EMBEDDING);
    const first = await brainA.computeEmbeddings();
    expect((await brainA.sync()).status).toBe('ok');
    const next = { model: 'multilingual-e5-base', variant: 'q8', dims: 768, recipe: 1 };

    // a troca interrompida no meio: o .cabecao.json continua no modelo antigo, e a busca também
    const half = await openHuman(a, fakeProvider({ failAfterPassages: 10 }), { embedRoundSize: 5 });
    await expect(half.switchEmbeddings(next)).rejects.toMatchObject({ code: 'embeddings_unavailable' });
    expect((await readBrainConfig(a)).embedding?.model).toBe(TEST_EMBEDDING.model);
    await half.close();
    expect((await brainA.search({ query: 'filas' })).mode_reason).toMatch(/multilingual-e5-small/);

    // retomada: só o que faltou do modelo novo, e então o .cabecao.json muda num commit
    const again = fakeProvider();
    const brain2 = await openHuman(a, again);
    const switched = await brain2.switchEmbeddings(next);
    expect(switched.switched).toBe(true);
    expect(switched.computed).toBe(first.chunks - 10);
    expect(switched.from).toBe('multilingual-e5-small-q8-r1');
    expect(switched.to).toBe('multilingual-e5-base-q8-r1');
    expect((await readBrainConfig(a)).embedding?.model).toBe('multilingual-e5-base');
    expect(await git(a, ['log', '-1', '--format=%B'])).toMatch(/modelo de embeddings multilingual-e5-base/);
    expect((await brain2.search({ query: 'filas' })).mode_reason).toMatch(/multilingual-e5-base/);

    const synced = await brain2.sync();
    expect(synced.index?.pushed).toBe(switched.computed + 10);
    const b = await cloneMachine(remote, 'b');
    const providerB = fakeProvider();
    const brainB = await openHuman(b, providerB);
    expect((await brainB.sync()).index).toMatchObject({ computed: 0, pending: 0 });
    expect(providerB.stats.passages).toBe(0);
    // a pasta antiga sai no compact
    const compacted = await brain2.compactIndex();
    expect(compacted?.removed.models).toEqual(['multilingual-e5-small-q8-r1']);
  });
});

describe('busca híbrida', { timeout: TEST_TIMEOUT_MS }, () => {
  /** Um "modelo" que sabe que broker, mensageria e fila são a mesma coisa (o embedder falso só vê palavras). */
  const SYNONYMS = { broker: 'fila', brokers: 'filas', mensageria: 'fila', mensagens: 'filas', trocamos: 'migrou' };

  it('paráfrase: a palavra-chave erra a decisão do SQS; a busca híbrida acerta', async () => {
    const a = await createBrainRepo();
    const brain = await openHuman(a, fakeProvider({ synonyms: SYNONYMS }));
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    const question = 'por que trocamos de broker?';
    const keyword = await brain.search({ query: question, mode: 'keyword' });
    const hybrid = await brain.search({ query: question, mode: 'hybrid' });
    const semantic = await brain.search({ query: question, mode: 'semantic' });
    const target = 'wiki/decisions/usar-sqs-para-filas.md';
    expect(hitPaths(keyword)).not.toContain(target);
    expect(hybrid.mode_used).toBe('hybrid');
    expect(hitPaths(hybrid).slice(0, 3)).toContain(target);
    expect(semantic.mode_used).toBe('semantic');
    expect(semantic.mode).toBe('none');
    expect(hitPaths(semantic).slice(0, 3)).toContain(target);
    // todo resultado traz validade, proveniência e o envelope de dado
    const hit = hybrid.hits.find((h) => h.path === target);
    expect(hit).toMatchObject({ validity: 'current', trust: 'high', content_kind: 'snippet' });
    expect(hybrid.data_notice).toMatch(/nunca instrução/);
    expect(hybrid.hits.every((h) => h.score >= 0 && h.score <= 1)).toBe(true);
  });

  it('as_of e os três estados de validade valem na fusão: o vencido é rebaixado, nunca escondido', async () => {
    const a = await createBrainRepo();
    const brain = await openHuman(a, fakeProvider());
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    const today = await brain.search({ query: 'filas RabbitMQ SQS decisão', types: ['decision'] });
    expect(today.mode_used).toBe('hybrid');
    const byPath = new Map(today.hits.map((hit) => [hit.path, hit]));
    expect(byPath.get('wiki/decisions/usar-rabbitmq-para-filas.md')?.validity).toBe('expired');
    expect(byPath.get('wiki/decisions/usar-sqs-para-filas.md')?.validity).toBe('current');
    expect(hitPaths(today)[0]).toBe('wiki/decisions/usar-sqs-para-filas.md');
    const past = await brain.search({ query: 'filas RabbitMQ SQS decisão', types: ['decision'], as_of: '2026-03-01' });
    const pastBy = new Map(past.hits.map((hit) => [hit.path, hit]));
    expect(pastBy.get('wiki/decisions/usar-sqs-para-filas.md')?.validity).toBe('not_yet_valid');
    expect(hitPaths(past)[0]).toBe('wiki/decisions/usar-rabbitmq-para-filas.md');
    expect(past.related.length).toBeGreaterThan(0);
  });

  it('escopo, tipo e arquivadas filtram também o lado do vetor', async () => {
    const a = await createBrainRepo();
    const brain = await openHuman(a, fakeProvider());
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    const facts = await brain.search({ query: 'quem lidera o Atlas', types: ['fact'], mode: 'semantic' });
    expect(facts.hits.length).toBeGreaterThan(0);
    expect(facts.hits.every((hit) => hit.type === 'fact')).toBe(true);
    const archived = await brain.search({ query: 'usar tabs na indentação', mode: 'semantic', limit: 50 });
    expect(hitPaths(archived)).not.toContain('memory/_archive/preferencia-usar-tabs.md');
    const scoped = await brain.search({ query: 'filas', scope: 'global', mode: 'hybrid', limit: 50 });
    expect(scoped.hits.every((hit) => hit.scope === 'global')).toBe(true);
  });

  it('trecho ainda sem vetor concorre só pela palavra-chave', async () => {
    const a = await createBrainRepo();
    const brain = await openHuman(a, fakeProvider());
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    writeFileSync(join(a, 'wiki/concepts/Zebra.md'), '---\ntitle: Zebra\n---\nA zebralunar não tem vetor ainda.\n');
    const found = await brain.search({ query: 'zebralunar' });
    expect(found.mode_used).toBe('hybrid');
    expect(hitPaths(found)[0]).toBe('wiki/concepts/Zebra.md');
  });

  it('o runtime cai no meio da busca: a busca não cai, volta por palavra-chave com um aviso', async () => {
    const a = await createBrainRepo();
    let broken = false;
    const brain = await openHuman(a, fakeProvider({ failQueries: () => broken }));
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    expect((await brain.search({ query: 'filas' })).mode_used).toBe('hybrid');
    broken = true;
    const fallback = await brain.search({ query: 'filas' });
    expect(fallback.mode_used).toBe('keyword');
    expect(fallback.warnings).toHaveLength(1);
    expect(fallback.warnings[0]).toMatch(/caiu/);
    expect(fallback.hits.length).toBeGreaterThan(0);
    const keyword = await brain.search({ query: 'filas', mode: 'keyword' });
    expect(hitPaths(fallback)).toEqual(hitPaths(keyword));
    broken = false;
    expect((await brain.search({ query: 'filas' })).mode_used).toBe('hybrid');
  });

  it('modelo que não carrega: modo auto cai para palavra-chave; pedir semantic avisa', async () => {
    const a = await createBrainRepo();
    const ok = await openHuman(a, fakeProvider());
    await ok.setEmbedding(TEST_EMBEDDING);
    await ok.close();
    const brain = await openHuman(a, fakeProvider({ failLoad: true }));
    const auto = await brain.search({ query: 'filas' });
    expect(auto.mode_used).toBe('keyword');
    expect(auto.warnings[0]).toMatch(/não abriu/);
    const semantic = await brain.search({ query: 'filas', mode: 'semantic' });
    expect(semantic.mode_used).toBe('keyword');
    expect(semantic.warnings.length).toBe(1);
  });

  it('sem embeddings ativados, a busca por palavra-chave não muda (mesmos resultados e pontuações de antes)', async () => {
    const a = await createBrainRepo();
    const withProvider = await openHuman(a, fakeProvider());
    const plain = await openHuman(a, undefined as never);
    const one = await withProvider.search({ query: 'filas SQS' });
    const two = await plain.search({ query: 'filas SQS', mode: 'keyword' });
    expect(one.mode_used).toBe('keyword');
    expect(one.hits).toEqual(two.hits);
    expect(one.mode).toBe(two.mode);
  });

  it('mode inválido é recusado', async () => {
    const a = await createBrainRepo();
    const brain = await openHuman(a, fakeProvider());
    await expect(brain.search({ query: 'x', mode: 'vector' as never })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });
});

describe('eval', { timeout: TEST_TIMEOUT_MS }, () => {
  it('compara palavra-chave, vetor e fusão nas perguntas do usuário', async () => {
    const a = await createBrainRepo();
    const brain = await openHuman(a, fakeProvider({ synonyms: { broker: 'fila', trocamos: 'migrou' } }));
    await brain.setEmbedding(TEST_EMBEDDING);
    await brain.computeEmbeddings();
    const { parseEvalQuestions } = await import('../../src/vector/index.ts');
    const questions = parseEvalQuestions(
      [
        '{"query": "por que trocamos de broker?", "expected": "wiki/decisions/usar-sqs-para-filas.md", "kind": "paraphrase"}',
        '{"query": "RabbitMQ", "expected": "wiki/entities/RabbitMQ.md", "kind": "exact"}',
      ].join('\n'),
    );
    const out = await brain.evaluateSearch({ questions });
    expect(out.vector).toBe(true);
    expect(out.report.configs.map((c) => c.name)).toEqual([
      'keyword',
      'vector',
      'fusion α=0.3',
      'fusion α=0.5',
      'fusion α=0.7',
    ]);
    const keyword = out.report.configs[0];
    const fusion = out.report.configs[3];
    expect(keyword?.byKind.exact?.mrr).toBe(1);
    expect(fusion?.byKind.paraphrase?.mrr ?? 0).toBeGreaterThan(keyword?.byKind.paraphrase?.mrr ?? 0);
    expect(out.report.differences).toHaveLength(4);

    // sem embeddings: só a palavra-chave
    const b = await createBrainRepo('b');
    const plain = await openHuman(b, fakeProvider());
    const only = await plain.evaluateSearch({ questions });
    expect(only.vector).toBe(false);
    expect(only.report.configs.map((c) => c.name)).toEqual(['keyword']);
  });
});
