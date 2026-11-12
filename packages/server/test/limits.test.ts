// Mensagens e campos grandes demais (revisão adversária do marco 1, M7): antes, um pedido acima do limite do
// transporte stdio (10 MiB) fechava a conexão sem resposta e o servidor saía com código 0. Agora a mensagem grande
// demais recebe um erro JSON-RPC com o mesmo `id`, a conexão continua, e os campos de texto têm teto no esquema.
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { INPUT_LIMITS, LineLimiter } from '../src/index.ts';
import type { JsonRpcResponse } from './helpers.ts';
import { createBrainRepo, disposeSandbox, git, startInMemory, stopAll, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(async () => {
  await stopAll();
  disposeSandbox();
});

/** Passa `chunks` pelo filtro e devolve as linhas entregues e os excessos relatados. */
async function filter(
  chunks: readonly string[],
  maxBytes: number,
): Promise<{ lines: string[]; oversize: { id: unknown; bytes: number }[] }> {
  const oversize: { id: unknown; bytes: number }[] = [];
  const limiter = new LineLimiter({ maxBytes, onOversize: ({ id, bytes }) => oversize.push({ id, bytes }) });
  const out: Buffer[] = [];
  limiter.on('data', (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((resolve) => limiter.on('end', resolve));
  const source = new PassThrough();
  source.pipe(limiter);
  for (const chunk of chunks) source.write(chunk);
  source.end();
  await ended;
  return { lines: Buffer.concat(out).toString('utf8').split('\n'), oversize };
}

describe('LineLimiter', () => {
  it('linhas dentro do limite passam iguais, mesmo chegando aos pedaços', async () => {
    const a = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const b = JSON.stringify({ jsonrpc: '2.0', id: 'dois', method: 'ping', params: { texto: 'ção' } });
    const text = `${a}\n${b}\n`;
    const { lines, oversize } = await filter([text.slice(0, 10), text.slice(10, 50), text.slice(50)], 200);
    expect(lines).toEqual([a, b, '']);
    expect(oversize).toEqual([]);
  });

  it('linha grande demais: descartada, e o id de primeiro nível é achado mesmo depois do conteúdo', async () => {
    const big = 'x'.repeat(5000);
    const idLast = `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"read","arguments":{"id":"falso","content":"${big}\\"id\\":9"}},"id":42}`;
    const idString = `{"id":"abc\\"d","jsonrpc":"2.0","method":"x","params":{"c":"${big}"}}`;
    const notification = `{"jsonrpc":"2.0","method":"notifications/x","params":{"c":"${big}"}}`;
    const after = '{"jsonrpc":"2.0","id":7,"method":"ping"}';
    const text = `${idLast}\n${idString}\n${notification}\n${after}\n`;
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += 777) pieces.push(text.slice(at, at + 777));
    const { lines, oversize } = await filter(pieces, 1000);
    expect(lines).toEqual([after, '']);
    expect(oversize.map((item) => item.id)).toEqual([42, 'abc"d', undefined]);
    expect(oversize[0]?.bytes).toBe(Buffer.byteLength(idLast));
  });
});

describe('servidor stdio', { timeout: TEST_TIMEOUT_MS }, () => {
  it('mensagem acima do limite: erro JSON-RPC com o mesmo id, e a conexão continua respondendo', async () => {
    const dir = await createBrainRepo();
    const server = startInMemory(dir, { generation: 'legacy', maxMessageBytes: 64 * 1024 });
    await server.client.open();
    const content = 'palavra comum de texto '.repeat(4000);
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 'grande',
      method: 'tools/call',
      params: {
        name: 'write_page',
        arguments: {
          path: 'wiki/concepts/grande.md',
          mode: 'create',
          frontmatter: { type: 'concept', title: 'g' },
          content,
        },
      },
    });
    const response: JsonRpcResponse = await server.client.raw(line, 'grande');
    expect(response.error?.code).toBe(-32600);
    expect(response.error?.message).toMatch(/grande demais/);
    const ping = await server.client.request('ping');
    expect(ping.error).toBeUndefined();
    const status = await server.client.call('status');
    expect(status.isError).not.toBe(true);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    await server.stop();
    await server.done;
  });

  it('campo de texto acima do teto do esquema: erro claro, nada gravado', async () => {
    const dir = await createBrainRepo();
    const server = startInMemory(dir, { generation: 'legacy' });
    await server.client.open();
    const content = 'a'.repeat(INPUT_LIMITS.content + 1);
    const response = await server.client.request('tools/call', {
      name: 'write_page',
      arguments: {
        path: 'wiki/concepts/grande.md',
        mode: 'create',
        frontmatter: { type: 'concept', title: 'g' },
        content,
      },
    });
    const text =
      response.error?.message ??
      (response.result === undefined ? '' : JSON.stringify(response.result.content ?? response.result));
    expect(
      response.error !== undefined || (response.result as { isError?: boolean } | undefined)?.isError === true,
    ).toBe(true);
    expect(text).toMatch(/1\.000\.000|1000000/);
    // o SDK devolve a recusa do esquema como erro de tool, com a mensagem do teto
    const title = await server.client.call('remember', {
      type: 'gotcha',
      title: 't'.repeat(INPUT_LIMITS.short + 1),
      content: 'x',
    });
    expect(title.isError).toBe(true);
    expect(title.content.map((block) => block.text).join('')).toMatch(/limite é 1\.000 caracteres/);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    await server.stop();
    await server.done;
  });
});
