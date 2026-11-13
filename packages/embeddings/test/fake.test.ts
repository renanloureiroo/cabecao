import { describe, expect, it } from 'vitest';
import { createFakeEmbedder, dot } from '../src/index.ts';

describe('createFakeEmbedder', () => {
  it('é determinístico, normalizado e tem as dimensões pedidas', async () => {
    const a = createFakeEmbedder(64);
    const b = createFakeEmbedder(64);
    expect(a).toMatchObject({ dims: 64, backend: 'fake', model: 'fake-64' });
    const [x] = await a.embed(['Decidimos usar SQS'], 'passage');
    const [y] = await b.embed(['Decidimos usar SQS'], 'passage');
    expect(x).toHaveLength(64);
    expect(Array.from(x ?? [])).toEqual(Array.from(y ?? []));
    expect(dot(x ?? new Float32Array(), x ?? new Float32Array())).toBeCloseTo(1, 5);
  });

  it('textos com palavras em comum ficam mais próximos; acento e caixa não importam', async () => {
    const fake = createFakeEmbedder(256);
    const [q, near, far, accent] = await fake.embed(
      [
        'fila de mensagens SQS',
        'migramos a fila de mensagens para SQS',
        'receita de bolo de cenoura',
        'FILÁ DE MENSAGENS sqs',
      ],
      'passage',
    );
    const z = new Float32Array(256);
    expect(dot(q ?? z, near ?? z)).toBeGreaterThan(dot(q ?? z, far ?? z));
    expect(dot(q ?? z, accent ?? z)).toBeCloseTo(1, 5);
  });

  it('texto vazio ou sem palavras ainda dá um vetor unitário; o tipo não muda o vetor', async () => {
    const fake = createFakeEmbedder(8);
    for (const [v] of [await fake.embed([''], 'query'), await fake.embed(['!!!'], 'query')]) {
      expect(dot(v ?? new Float32Array(), v ?? new Float32Array())).toBeCloseTo(1, 5);
    }
    const [q] = await fake.embed([{ text: 'corpo', title: 'Título' }], 'query');
    const [p] = await fake.embed(['Título corpo'], 'passage');
    expect(Array.from(q ?? [])).toEqual(Array.from(p ?? []));
  });

  it('recusa dims inválidas e falha depois de liberado', async () => {
    expect(() => createFakeEmbedder(0)).toThrow(RangeError);
    const fake = createFakeEmbedder(4, { model: 'teste' });
    expect(fake.model).toBe('teste');
    await fake.dispose();
    await expect(fake.embed(['x'], 'query')).rejects.toMatchObject({ code: 'EMBEDDINGS_DISPOSED' });
  });
});
