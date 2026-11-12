import { describe, expect, it } from 'vitest';
import type { DirContext } from '../../src/util/index.ts';
import { cacheDir, configDir } from '../../src/util/index.ts';

function ctx(platform: NodeJS.Platform, homedir: string, env: Record<string, string | undefined> = {}): DirContext {
  return { platform, homedir, env };
}

describe('configDir e cacheDir', () => {
  it('Linux: ~/.config e ~/.cache', () => {
    const linux = ctx('linux', '/home/ana');
    expect(configDir(linux)).toBe('/home/ana/.config/cabecao');
    expect(cacheDir(linux)).toBe('/home/ana/.cache/cabecao');
  });

  it('macOS: os mesmos caminhos do Linux, não ~/Library', () => {
    const mac = ctx('darwin', '/Users/ana');
    expect(configDir(mac)).toBe('/Users/ana/.config/cabecao');
    expect(cacheDir(mac)).toBe('/Users/ana/.cache/cabecao');
  });

  it('respeita XDG_CONFIG_HOME e XDG_CACHE_HOME', () => {
    const linux = ctx('linux', '/home/ana', { XDG_CONFIG_HOME: '/etc/xdg-ana', XDG_CACHE_HOME: '/var/cache/ana' });
    expect(configDir(linux)).toBe('/etc/xdg-ana/cabecao');
    expect(cacheDir(linux)).toBe('/var/cache/ana/cabecao');
  });

  it('ignora XDG vazio ou relativo, como manda a especificação', () => {
    const linux = ctx('linux', '/home/ana', { XDG_CONFIG_HOME: '', XDG_CACHE_HOME: 'relativo/cache' });
    expect(configDir(linux)).toBe('/home/ana/.config/cabecao');
    expect(cacheDir(linux)).toBe('/home/ana/.cache/cabecao');
  });

  it('Windows: %APPDATA% e %LOCALAPPDATA%', () => {
    const windows = ctx('win32', 'C:\\Users\\Ana', {
      APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming',
      LOCALAPPDATA: 'D:\\Local',
      XDG_CONFIG_HOME: 'C:\\xdg',
    });
    expect(configDir(windows)).toBe('C:\\Users\\Ana\\AppData\\Roaming\\cabecao');
    expect(cacheDir(windows)).toBe('D:\\Local\\cabecao');
  });

  it('Windows sem as variáveis: cai na pasta do usuário', () => {
    const windows = ctx('win32', 'C:\\Users\\Ana');
    expect(configDir(windows)).toBe('C:\\Users\\Ana\\AppData\\Roaming\\cabecao');
    expect(cacheDir(windows)).toBe('C:\\Users\\Ana\\AppData\\Local\\cabecao');
  });

  it('CABECAO_CONFIG_DIR e CABECAO_CACHE_DIR vencem tudo e são usadas como estão', () => {
    const env = {
      CABECAO_CONFIG_DIR: '/tmp/teste/config',
      CABECAO_CACHE_DIR: '/tmp/teste/cache',
      XDG_CONFIG_HOME: '/xdg',
      XDG_CACHE_HOME: '/xdg',
    };
    expect(configDir(ctx('linux', '/home/ana', env))).toBe('/tmp/teste/config');
    expect(cacheDir(ctx('darwin', '/Users/ana', env))).toBe('/tmp/teste/cache');
    const windows = ctx('win32', 'C:\\Users\\Ana', { CABECAO_CONFIG_DIR: 'E:\\cfg', CABECAO_CACHE_DIR: 'E:\\cache' });
    expect(configDir(windows)).toBe('E:\\cfg');
    expect(cacheDir(windows)).toBe('E:\\cache');
  });

  it('sem argumento usa o ambiente do processo', () => {
    const saved = process.env.CABECAO_CONFIG_DIR;
    process.env.CABECAO_CONFIG_DIR = process.platform === 'win32' ? 'C:\\qualquer\\lugar' : '/qualquer/lugar';
    try {
      expect(configDir()).toBe(process.env.CABECAO_CONFIG_DIR);
    } finally {
      if (saved === undefined) delete process.env.CABECAO_CONFIG_DIR;
      else process.env.CABECAO_CONFIG_DIR = saved;
    }
    expect(cacheDir().endsWith('cabecao') || process.env.CABECAO_CACHE_DIR !== undefined).toBe(true);
  });
});
