import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { hello, NODE_ENGINES, PRODUCT_NAME } from '../src/index.ts';

it('hello identifica o núcleo', () => {
  expect(hello()).toBe('cabecao: núcleo carregado');
});

it('NODE_ENGINES é igual ao engines do pacote publicado', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8'));
  expect(pkg.name).toBe(PRODUCT_NAME);
  expect(pkg.engines.node).toBe(NODE_ENGINES);
});
