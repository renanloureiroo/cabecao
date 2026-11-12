/** Nome do produto, usado pela CLI e pelo servidor. */
export const PRODUCT_NAME = 'cabecao';

/** Faixa de versões do Node aceita, igual ao campo `engines` do pacote publicado. */
export const NODE_ENGINES = '^22.16.0 || >=24.0.0';

export function hello(): string {
  return `${PRODUCT_NAME}: núcleo carregado`;
}

export * from './db/index.ts';
export * from './git/index.ts';
export * from './init/index.ts';
export * from './markdown/index.ts';
export * from './security/index.ts';
export * from './sync/index.ts';
export * from './util/index.ts';
export * from './vault/index.ts';
