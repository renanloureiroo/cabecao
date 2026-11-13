import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StdioServerOptions } from '../src/commands/mcp.ts';
import { createSyncRunner, parseSyncProcessOutput, runMcp, SYNC_PROCESS_TIMEOUT_MS } from '../src/commands/mcp.ts';
import { COMMANDS } from '../src/commands.ts';
import type { CommandSpec } from '../src/types.ts';
import { brainRepo, disposeSandbox, freshDir, machine, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(() => {
  disposeSandbox();
});

const BIN = '/opt/cabecao/dist/cabecao.mjs';
const NODE = '/opt/node/bin/node';

/** O registro real com o `mcp` trocado por um que usa um servidor falso. */
function registryWith(fake: (options: StdioServerOptions) => Promise<void>): CommandSpec[] {
  return COMMANDS.map((command) =>
    command.name === 'mcp'
      ? { ...command, load: async () => ({ run: (ctx) => runMcp(ctx, { loadServer: async () => fake }) }) }
      : command,
  );
}

const SYNC_DATA = {
  status: 'ok',
  message: 'Nada a sincronizar.',
  pulled: 0,
  pushed: 0,
  committed: 0,
  conflicts: [],
  changed_paths: [],
  secrets: [],
  attempts: 1,
  ms: 12,
  branch: 'main',
  remote: 'origin',
  integration: 'none',
  reason: null,
  remote_error: null,
  recovered: [],
  config_problem: null,
};

describe('mcp', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sobe o servidor com a pasta do cérebro, a versão, a máquina e o syncRunner; stdout fica intocado', async () => {
    const brain = await brainRepo();
    const m = machine();
    await mkdir(m.configDir, { recursive: true });
    await writeFile(join(m.configDir, 'config.json'), JSON.stringify({ machine: 'maquina-m' }));
    let seen: StdioServerOptions | undefined;
    const commands = registryWith(async (options) => {
      seen = options;
    });
    for (const args of [
      ['mcp', '--brain', brain],
      ['mcp', '--brain', brain, '--json'],
    ]) {
      const result = await m.cabecao(args, { commands, binPath: BIN, execPath: NODE });
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(seen?.brainRoot).toBe(brain);
      expect(seen?.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(seen?.machine).toBe('maquina-m');
      expect(typeof seen?.syncRunner).toBe('function');
      // a CLI não passa os canais: o servidor usa os do processo e cuida de sinais e do console
      expect(seen?.stdin).toBeUndefined();
      expect(seen?.stdout).toBeUndefined();
    }
  });

  it('erro (pasta que não é cérebro, servidor que falha) vai só para stderr, mesmo com --json', async () => {
    const m = machine();
    const notBrain = freshDir('nada');
    const commands = registryWith(async () => {
      throw new Error('transporte quebrou');
    });
    const invalid = await m.cabecao(['mcp', '--brain', notBrain, '--json'], { commands });
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('cabecao init');

    const brain = await brainRepo();
    const broken = await m.cabecao(['mcp', '--brain', brain, '--json'], { commands });
    expect(broken.code).toBe(1);
    expect(broken.stdout).toBe('');
    expect(broken.stderr).toContain('transporte quebrou');
  });

  it('--help do mcp ainda sai no stdout', async () => {
    const result = await machine().cabecao(['mcp', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('cabecao mcp');
  });

  it('o syncRunner roda "<node> <bin> sync --json --brain <pasta>" sem shell e devolve a saída do sync', async () => {
    const m = machine();
    m.replies.push({
      code: 0,
      stdout: `${JSON.stringify({ ok: true, command: 'sync', data: SYNC_DATA })}\n`,
      stderr: '',
    });
    const runner = createSyncRunner({ exec: m.exec, execPath: NODE, binPath: BIN, env: m.env }, '/cérebro com espaço');
    const output = await runner({ session_handle: '01JD3K7M0000000000000000AB' });
    expect(output).toEqual(SYNC_DATA);
    expect(m.calls).toEqual([
      {
        file: NODE,
        args: [BIN, 'sync', '--json', '--brain', '/cérebro com espaço', '--session', '01JD3K7M0000000000000000AB'],
      },
    ]);
    m.replies.push({ code: 0, stdout: JSON.stringify({ ok: true, command: 'sync', data: SYNC_DATA }), stderr: '' });
    await runner({});
    expect(m.calls[1]?.args).toEqual([BIN, 'sync', '--json', '--brain', '/cérebro com espaço']);
    expect(SYNC_PROCESS_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('sync bloqueado (código 1) ainda é uma resposta; erro do processo vira erro com o código do núcleo', () => {
    const blocked = { ...SYNC_DATA, status: 'blocked', reason: 'secrets' };
    expect(
      parseSyncProcessOutput({
        code: 1,
        stdout: JSON.stringify({ ok: false, command: 'sync', data: blocked }),
        stderr: '',
      }),
    ).toEqual(blocked);

    let thrown: unknown;
    try {
      parseSyncProcessOutput({
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          command: 'sync',
          error: { kind: 'runtime', message: 'o cérebro está ocupado', code: 'locked', hint: 'Tente de novo.' },
        }),
        stderr: 'cabecao: o cérebro está ocupado\n',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ message: 'o cérebro está ocupado', code: 'locked', next_step: 'Tente de novo.' });

    expect(() => parseSyncProcessOutput({ code: null, stdout: '', stderr: 'morto por sinal' })).toThrow(
      /processo do sync falhou.*morto por sinal/,
    );
  });

  it('sem saber onde está o bin, o syncRunner explica em vez de rodar qualquer coisa', async () => {
    const m = machine();
    const runner = createSyncRunner({ exec: m.exec, execPath: NODE, binPath: undefined, env: m.env }, '/x');
    await expect(runner({})).rejects.toThrow(/onde está o programa cabecao/);
    expect(m.calls).toEqual([]);
  });
});
