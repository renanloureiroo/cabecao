import { expect, it } from 'vitest';
import { hello, RUNTIME_DIR_NAME } from '../src/index.ts';

it('hello avisa que o runtime ainda não existe', () => {
  expect(hello()).toContain('ainda não implementado');
  expect(RUNTIME_DIR_NAME).toBe('runtime');
});
