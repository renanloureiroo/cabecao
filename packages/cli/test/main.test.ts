import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '../src/commands.ts';
import { CliError, UsageError } from '../src/errors.ts';
import { run, VERSION } from '../src/main.ts';
import type { CommandContext, CommandModule, CommandSpec } from '../src/types.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** Registro de mentira: cada comando guarda o contexto recebido e conta quantas vezes foi carregado. */
function fakeRegistry(runImpl: CommandModule['run'] = () => ({ text: 'feito', data: { feito: true } })) {
  const loads = vi.fn(async (): Promise<CommandModule> => ({ run: runImpl }));
  const commands: CommandSpec[] = [
    {
      name: 'eco',
      summary: 'Repete os argumentos',
      usage: ['eco [texto...] [--alto]'],
      options: {
        alto: { type: 'boolean', short: 'a', description: 'Em maiúsculas' },
        nome: { type: 'string', valueName: 'quem', description: 'Quem fala' },
      },
      details: 'Texto de detalhe do eco.',
      load: loads,
    },
    { name: 'outro', summary: 'Outro comando', usage: ['outro'], load: loads },
  ];
  return { commands, loads };
}

describe('opções globais', () => {
  it('--version e -v imprimem só a versão do package.json', async () => {
    expect(VERSION).toBe(pkg.version);
    expect(await run(['--version'])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
    expect(await run(['-v'])).toEqual(await run(['--version']));
  });

  it('--version com --json devolve um objeto', async () => {
    const result = await run(['--version', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, command: null, data: { version: pkg.version } });
  });

  it('sem argumentos, --help, -h e help mostram a ajuda geral com a lista de comandos', async () => {
    const help = await run([]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain(`cabecao ${pkg.version}`);
    expect(help.stdout).toContain('--version');
    expect(help.stdout).toContain('--json');
    expect(help.stdout).toContain('--brain <pasta>');
    for (const command of COMMANDS) expect(help.stdout).toContain(command.name);
    expect(await run(['--help'])).toEqual(help);
    expect(await run(['-h'])).toEqual(help);
    expect(await run(['help'])).toEqual(help);
  });

  it('a ajuda em --json lista os comandos', async () => {
    const { commands } = fakeRegistry();
    const result = await run(['--help', '--json'], { commands });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.commands.map((command: { name: string }) => command.name)).toEqual(['eco', 'outro']);
  });

  it('--version e --help não carregam o código de nenhum comando', async () => {
    const { commands, loads } = fakeRegistry();
    await run(['--version'], { commands });
    await run(['--help'], { commands });
    await run(['eco', '--help'], { commands });
    await run(['eco', '--version'], { commands });
    await run(['help', 'eco'], { commands });
    expect(loads).not.toHaveBeenCalled();
  });
});

describe('ajuda de comando', () => {
  it('cabecao <comando> --help mostra uso, opções, globais e detalhes', async () => {
    const { commands } = fakeRegistry();
    const result = await run(['eco', '--help'], { commands });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('cabecao eco: Repete os argumentos');
    expect(result.stdout).toContain('cabecao eco [texto...] [--alto]');
    expect(result.stdout).toContain('-a, --alto');
    expect(result.stdout).toContain('--nome <quem>');
    expect(result.stdout).toContain('Opções globais:');
    expect(result.stdout).toContain('Texto de detalhe do eco.');
    expect(await run(['help', 'eco'], { commands })).toEqual(result);
    expect(await run(['--help', 'eco'], { commands })).toEqual(result);
  });

  it('a ajuda de install-client cita os sete clientes', async () => {
    const result = await run(['install-client', '--help']);
    expect(result.code).toBe(0);
    for (const client of ['claude-code', 'claude-desktop', 'codex', 'cursor', 'vscode', 'antigravity', 'gemini']) {
      expect(result.stdout).toContain(client);
    }
  });
});

describe('execução', () => {
  it('passa opções, posicionais e o contexto injetado ao comando', async () => {
    let seen: CommandContext | undefined;
    const { commands } = fakeRegistry((ctx) => {
      seen = ctx;
      return { text: 'ok' };
    });
    const cwd = resolve('/tmp/cwd-de-teste');
    const result = await run(['eco', 'um', '--alto', 'dois', '--nome', 'ana'], {
      commands,
      cwd,
      env: { X: '1' },
      platform: 'linux',
    });
    expect(result).toEqual({ code: 0, stdout: 'ok\n', stderr: '' });
    expect(seen?.command).toBe('eco');
    expect(seen?.positionals).toEqual(['um', 'dois']);
    expect(seen?.values.alto).toBe(true);
    expect(seen?.values.nome).toBe('ana');
    expect(seen?.json).toBe(false);
    expect(seen?.brain).toBeUndefined();
    expect(seen?.env).toEqual({ X: '1' });
    expect(seen?.platform).toBe('linux');
    expect(seen?.cwd).toBe(cwd);
  });

  it('--brain vale antes ou depois do comando e é resolvido a partir da pasta atual', async () => {
    const brains: Array<string | undefined> = [];
    const { commands } = fakeRegistry((ctx) => {
      brains.push(ctx.brain);
      return {};
    });
    const cwd = resolve('/tmp/base');
    await run(['--brain', 'meu', 'eco'], { commands, cwd });
    await run(['eco', '--brain=meu'], { commands, cwd });
    await run(['eco'], { commands, cwd, env: { CABECAO_BRAIN: 'meu' } });
    await run(['eco', '--brain', 'outro'], { commands, cwd, env: { CABECAO_BRAIN: 'meu' } });
    await run(['eco'], { commands, cwd, env: { CABECAO_BRAIN: '' } });
    expect(brains).toEqual([
      resolve(cwd, 'meu'),
      resolve(cwd, 'meu'),
      resolve(cwd, 'meu'),
      resolve(cwd, 'outro'),
      undefined,
    ]);
  });

  it('--json embrulha o resultado e não imprime o texto', async () => {
    const { commands } = fakeRegistry();
    const result = await run(['--json', 'eco'], { commands });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, command: 'eco', data: { feito: true } });
    const plain = await run(['eco'], { commands });
    expect(plain.stdout).toBe('feito\n');
  });

  it('o código devolvido pelo comando vira o código de saída', async () => {
    const { commands } = fakeRegistry(() => ({ code: 1, data: { parcial: true } }));
    const result = await run(['eco', '--json'], { commands });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, command: 'eco', data: { parcial: true } });
  });
});

describe('erros', () => {
  it('comando desconhecido sai com código 2 e explica em stderr', async () => {
    const result = await run(['comando-que-nao-existe']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('comando desconhecido: comando-que-nao-existe');
    expect(result.stderr).toContain('cabecao --help');
  });

  it('help de um comando que não existe é erro de uso', async () => {
    const result = await run(['help', 'nada']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('comando desconhecido: nada');
  });

  it('opção desconhecida e valor faltando são erros de uso, em português', async () => {
    const { commands } = fakeRegistry();
    const unknown = await run(['eco', '--xyz'], { commands });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('opção desconhecida: --xyz');
    expect(unknown.stderr).toContain('cabecao eco --help');
    const missing = await run(['eco', '--nome'], { commands });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('a opção --nome precisa de um valor');
    const global = await run(['--xyz']);
    expect(global.code).toBe(2);
    expect(global.stderr).toContain('opção desconhecida: --xyz');
    const emptyBrain = await run(['eco', '--brain='], { commands });
    expect(emptyBrain.code).toBe(2);
  });

  it('erro de uso com --json também sai em JSON no stdout', async () => {
    const result = await run(['--json', 'nada']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      command: null,
      error: { kind: 'usage', message: 'comando desconhecido: nada' },
    });
  });

  it('UsageError lançado pelo comando sai com código 2', async () => {
    const { commands } = fakeRegistry(() => {
      throw new UsageError('falta o texto');
    });
    const result = await run(['eco'], { commands });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cabecao: falta o texto');
  });

  it('CliError sai com código 1, a dica e sem stack', async () => {
    const { commands } = fakeRegistry(() => {
      throw new CliError('nada configurado', { code: 'ENADA', hint: 'Rode cabecao init.' });
    });
    const result = await run(['eco', '--json'], { commands });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('cabecao: nada configurado\nRode cabecao init.\n');
    expect(JSON.parse(result.stdout).error).toEqual({
      kind: 'runtime',
      message: 'nada configurado',
      code: 'ENADA',
      next_step: 'Rode cabecao init.',
      hint: 'Rode cabecao init.',
    });
  });

  it('erro inesperado sai com código 1, sem stack, a menos de CABECAO_DEBUG=1', async () => {
    const { commands } = fakeRegistry(() => {
      throw new TypeError('quebrou por dentro');
    });
    const quiet = await run(['eco'], { commands });
    expect(quiet.code).toBe(1);
    expect(quiet.stderr).toContain('cabecao: quebrou por dentro');
    expect(quiet.stderr).toContain('CABECAO_DEBUG=1');
    expect(quiet.stderr).not.toMatch(/\n\s+at /);
    const loud = await run(['eco'], { commands, env: { CABECAO_DEBUG: '1' } });
    expect(loud.code).toBe(1);
    expect(loud.stderr).toMatch(/TypeError: quebrou por dentro\n\s+at /);
  });

  it('falha ao carregar o módulo do comando vira erro de execução', async () => {
    const commands: CommandSpec[] = [
      {
        name: 'quebrado',
        summary: 'x',
        usage: ['quebrado'],
        load: () => Promise.reject(new Error('módulo sumiu')),
      },
    ];
    const result = await run(['quebrado'], { commands });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('módulo sumiu');
  });
});

describe('comando dono do stdout', () => {
  function owner(runImpl: CommandModule['run']): CommandSpec[] {
    return [{ name: 'proto', summary: 'x', usage: ['proto'], ownsStdout: true, load: async () => ({ run: runImpl }) }];
  }

  it('o roteador não escreve nada no stdout: nem texto, nem JSON, nem o JSON de erro', async () => {
    const ok = await run(['proto', '--json'], { commands: owner(() => ({ text: 'não', data: { x: 1 } })) });
    expect(ok).toEqual({ code: 0, stdout: '', stderr: '' });
    const failed = await run(['proto', '--json'], {
      commands: owner(() => {
        throw new CliError('quebrou', { hint: 'faça algo' });
      }),
    });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toBe('cabecao: quebrou\nfaça algo\n');
  });

  it('a ajuda e os erros de uso continuam normais', async () => {
    const commands = owner(() => ({}));
    expect((await run(['proto', '--help'], { commands })).stdout).toContain('cabecao proto');
    const usage = await run(['proto', '--xyz', '--json'], { commands });
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout).error.kind).toBe('usage');
  });
});

describe('registro de comandos', () => {
  it('nenhum comando redefine uma opção global e todo comando tem load', () => {
    const globals = new Set(['help', 'version', 'json', 'brain']);
    const shorts = new Set(['h', 'v']);
    const names = new Set<string>();
    for (const command of COMMANDS) {
      expect(names.has(command.name)).toBe(false);
      names.add(command.name);
      expect(typeof command.load).toBe('function');
      for (const [name, option] of Object.entries(command.options ?? {})) {
        expect(globals.has(name)).toBe(false);
        if (option.short !== undefined) expect(shorts.has(option.short)).toBe(false);
      }
    }
  });
});
