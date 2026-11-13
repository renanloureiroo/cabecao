import { describe, expect, it } from 'vitest';
import { findNpm, npmChildEnv } from '../src/npm.ts';

const has =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe('findNpm', () => {
  it('usa o npm_execpath (dentro do npx) com o mesmo node', () => {
    const { npm } = findNpm({
      env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
      execPath: '/usr/bin/node',
      platform: 'linux',
      exists: has('/usr/lib/node_modules/npm/bin/npm-cli.js'),
    });
    expect(npm).toEqual({
      command: '/usr/bin/node',
      prefix: ['/usr/lib/node_modules/npm/bin/npm-cli.js'],
      via: 'npm_execpath',
    });
  });

  it('ignora o npm_execpath do pnpm e acha o npm-cli.js ao lado do node', () => {
    const { npm, tried } = findNpm({
      env: { npm_execpath: '/home/u/.pnpm/pnpm.cjs' },
      execPath: '/opt/node/bin/node',
      platform: 'linux',
      exists: has('/home/u/.pnpm/pnpm.cjs', '/opt/node/lib/node_modules/npm/bin/npm-cli.js'),
    });
    expect(npm?.via).toBe('node-sibling');
    expect(npm?.prefix).toEqual(['/opt/node/lib/node_modules/npm/bin/npm-cli.js']);
    expect(tried[0]).toContain('pnpm.cjs');
  });

  it('no Windows acha o npm-cli.js ao lado do node.exe, nunca o npm.cmd', () => {
    const { npm } = findNpm({
      env: {},
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      platform: 'win32',
      exists: has('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'),
    });
    expect(npm).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefix: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
      via: 'node-sibling',
    });
  });

  it('no Windows procura o npm-cli.js nas pastas do Path', () => {
    const { npm } = findNpm({
      env: { Path: 'C:\\Windows;D:\\tools\\node' },
      execPath: 'D:\\volta\\node.exe',
      platform: 'win32',
      exists: has('D:\\tools\\node\\node_modules\\npm\\bin\\npm-cli.js'),
    });
    expect(npm?.via).toBe('path');
    expect(npm?.command).toBe('D:\\volta\\node.exe');
  });

  it('fora do Windows segue o link do npm no PATH até o npm-cli.js', () => {
    const { npm } = findNpm({
      env: { PATH: '/nada:/usr/local/bin' },
      execPath: '/elsewhere/node',
      platform: 'darwin',
      exists: has('/usr/local/bin/npm'),
      realpath: () => '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    });
    expect(npm).toEqual({
      command: '/elsewhere/node',
      prefix: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js'],
      via: 'path',
    });
  });

  it('sem nada, devolve null e o que tentou', () => {
    const result = findNpm({ env: {}, execPath: '/x/bin/node', platform: 'linux', exists: () => false });
    expect(result.npm).toBeNull();
    expect(result.tried).toEqual(['/x/lib/node_modules/npm/bin/npm-cli.js']);
  });
});

describe('npmChildEnv', () => {
  it('tira as variáveis que mandariam o npm instalar globalmente', () => {
    const env = npmChildEnv({
      PATH: '/bin',
      npm_config_global: 'true',
      NPM_CONFIG_PREFIX: '/usr',
      npm_config_cache: '/c',
    });
    expect(env).toEqual({ PATH: '/bin', npm_config_cache: '/c' });
  });
});
