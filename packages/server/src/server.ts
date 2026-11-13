// Fábrica do servidor MCP. A mesma fábrica atende as duas gerações do protocolo: `serveStdio` decide a geração na
// abertura da conexão (`initialize` → 2025-11-25; `server/discover` ou envelope `_meta` → 2026-07-28) e fixa uma
// instância por conexão. A fábrica não guarda estado nem abre nada: o que dura vem do `ServerRuntime`.
import { PRODUCT_NAME } from '@cabecao/core';
import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_INSTRUCTIONS } from './instructions.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import type { ServerRuntime } from './tools.ts';
import { registerTools } from './tools.ts';

/** Identificação que o servidor MCP anuncia aos clientes. */
export function serverInfo(version: string): { name: string; version: string } {
  return { name: PRODUCT_NAME, version };
}

/**
 * Uma instância nova do servidor, com as tools, os resources, os prompts e as instruções. Não abre o cérebro, não cria arquivo e
 * não toca no git: isso só acontece na primeira chamada de tool ou leitura de resource.
 */
export function buildServer(runtime: ServerRuntime): McpServer {
  const server = new McpServer(serverInfo(runtime.version), {
    instructions: SERVER_INSTRUCTIONS,
    // Só vão para o fio na geração 2026-07-28. A lista de tools e as instruções mudam só com a versão do pacote.
    cacheHints: {
      'server/discover': { ttlMs: 300_000, cacheScope: 'public' },
      'tools/list': { ttlMs: 300_000, cacheScope: 'public' },
      'resources/list': { ttlMs: 300_000, cacheScope: 'public' },
      'resources/templates/list': { ttlMs: 300_000, cacheScope: 'public' },
      'prompts/list': { ttlMs: 300_000, cacheScope: 'public' },
    },
  });
  registerTools(server, runtime);
  registerResources(server, runtime);
  registerPrompts(server);
  return server;
}
