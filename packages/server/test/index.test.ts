import { expect, it } from 'vitest';
import { serverInfo } from '../src/index.ts';

it('serverInfo usa o nome do produto', () => {
  expect(serverInfo('1.2.3')).toEqual({ name: 'cabecao', version: '1.2.3' });
});
