import { PRODUCT_NAME } from '@cabecao/core';

/** Identificação que o servidor MCP vai anunciar aos clientes. */
export function serverInfo(version: string): { name: string; version: string } {
  return { name: PRODUCT_NAME, version };
}
