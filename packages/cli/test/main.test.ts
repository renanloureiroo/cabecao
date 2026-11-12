import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { run, VERSION } from '../src/main.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

it('--version e -v imprimem só a versão do package.json', () => {
  expect(VERSION).toBe(pkg.version);
  expect(run(['--version'])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  expect(run(['-v'])).toEqual(run(['--version']));
});

it('sem argumentos ou com --help mostra a ajuda', () => {
  const help = run([]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain(`cabecao ${pkg.version}`);
  expect(help.stdout).toContain('--version');
  expect(run(['--help'])).toEqual(help);
  expect(run(['-h'])).toEqual(help);
});

it('comando desconhecido sai com código 2 e explica em stderr', () => {
  const result = run(['init']);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('comando desconhecido: init');
});
