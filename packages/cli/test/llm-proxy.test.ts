// Regressão da revisão adversária (PR #20, M2): com HTTP_PROXY/HTTPS_PROXY no ambiente, o pedido a um servidor desta
// máquina (Ollama, LM Studio) não pode ir por túnel ao proxy, em texto puro. Arquivo próprio: ligar o proxy do ambiente
// vale para o processo inteiro (cada arquivo de teste roda no seu).
import type { Server } from 'node:http';
import * as nodeHttp from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ANSWER_SCHEMA, createHttpProvider, HTTP_PRESETS } from '@cabecao/core';
import { afterAll, describe, expect, it } from 'vitest';
import { enableProxyFromEnv } from '../src/llm/machine.ts';

const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('M2: proxy do ambiente e servidor local', () => {
  it.skipIf(typeof (nodeHttp as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv !== 'function')(
    'o pedido ao servidor local vai direto; o proxy não recebe nada (prova p10)',
    async () => {
      let local = 0;
      const ollama = createServer((req, res) => {
        local++;
        req.resume();
        req.on('end', () => {
          const content = JSON.stringify({ status: 'not_found', claims: [], missing: 'nada' });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { content }, finish_reason: 'stop' }] }));
        });
      });
      const ollamaPort = await listen(ollama);
      const proxied: string[] = [];
      const proxy = createServer((req, res) => {
        proxied.push(`${req.method} ${req.url}`);
        res.writeHead(502);
        res.end();
      });
      proxy.on('connect', (req, socket) => {
        proxied.push(`CONNECT ${req.url}`);
        socket.end('HTTP/1.1 503 x\r\ncontent-length: 0\r\n\r\n');
      });
      const proxyPort = await listen(proxy);
      const url = `http://127.0.0.1:${proxyPort}`;
      expect(await enableProxyFromEnv({ HTTP_PROXY: url, HTTPS_PROXY: url })).toContain('sem proxy');
      const provider = createHttpProvider({
        id: 'ollama',
        preset: { ...HTTP_PRESETS.ollama, stream: false },
        model: 'llama3.2',
        baseUrl: `http://localhost:${ollamaPort}/v1`,
        requireKey: false,
        resolveKey: async () => ({ key: null, missing: '' }),
      });
      await provider.generate({
        system: 's',
        user: 'Pergunta: trecho-do-cerebro',
        schema: ANSWER_SCHEMA,
        maxOutputTokens: 100,
        timeoutMs: 5_000,
      });
      expect(proxied).toEqual([]);
      expect(local).toBe(1);
    },
  );
});
