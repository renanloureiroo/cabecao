// Regressões da SEGUNDA rodada da revisão adversária (PR #20) na CLI: A (o servidor MCP é sempre agente, e a pasta do
// usuário vem do sistema, não do ambiente), B (teto de gasto com chamadas concorrentes), F (Claude Code: o executável
// confirmado e, para um agente, nada do ambiente dele que mude destino ou configuração), G (uninstall e ask.log sem
// provedor para um agente) e K (a conta da chave no cofre). Sem rede de fora, sem chave real, sem cofre real e sem a
// configuração real da máquina.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { BrainConfig } from '@cabecao/core';
import { readConsentSecret, signConsent } from '@cabecao/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { askRunnerFor } from '../src/commands/mcp.ts';
import { COMMANDS } from '../src/commands.ts';
import { claudeEnv, createClaudeCodeProvider } from '../src/llm/claude-code.ts';
import { SAFE_ACCOUNT } from '../src/llm/credentials.ts';
import { trustedConfigDir } from '../src/llm/describe.ts';
import { runAsk } from '../src/llm/run.ts';
import { run } from '../src/main.ts';
import type { CommandSpec } from '../src/types.ts';
import { brainRepo, closeOpened, disposeSandbox, freshDir, machine, openAsAgent, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(async () => {
  await closeOpened();
  disposeSandbox();
});

const KEY = 'sk-teste-NUNCA-NA-SAIDA-0123456789abcdef';
let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

/** Servidor compatível com OpenAI (sem streaming) que demora um pouco: as perguntas concorrem de verdade. */
async function slowServer(): Promise<{ base: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      bodies.push(body);
      const user = body.messages[1]?.content ?? '';
      const marker = /Marca dos delimitadores desta mensagem: ([0-9a-f]+)/.exec(user)?.[1];
      const match = new RegExp(`<<<TRECHO ${marker} (S\\d+)>>>\\n[\\s\\S]*?\\n---\\n([\\s\\S]*?)\\n<<<FIM`).exec(user);
      const sentence =
        (match?.[2] ?? '')
          .replace(/\^/g, ' ')
          .split(/(?<=[.!?])\s+/)[0]
          ?.trim() ?? '';
      const content = JSON.stringify({
        status: 'answered',
        claims: [{ text: sentence, sources: [match?.[1] ?? 'S1'], quote: sentence }],
        missing: '',
      });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      }, 30);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };
}

const TERMINAL = { terminal: { prompt: async () => 's', promptSecret: async () => KEY } };

describe('A: o servidor MCP é sempre agente (prova q2)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('um comando "sempre agente" roda como agente mesmo com terminal controlador, sem pergunta ao usuário', async () => {
    let seen: unknown = null;
    const probe: CommandSpec = {
      name: 'sonda',
      summary: 'teste',
      usage: ['sonda'],
      alwaysAgent: true,
      load: async () => ({
        run: async (ctx) => {
          seen = { actor: ctx.actor.actor, reason: ctx.actor.reason, prompt: ctx.prompt === undefined };
          return {};
        },
      }),
    };
    const m = machine();
    await run(['sonda'], { env: m.env, terminal: { prompt: async () => 's' }, commands: [probe] });
    expect(seen).toEqual({ actor: 'agent', reason: 'server', prompt: true });
    expect(COMMANDS.find((command) => command.name === 'mcp')?.alwaysAgent).toBe(true);
  });

  it('com a pasta desviada pelo cliente e um llm.json assinado pelo atacante, a tool ask não aparece', async () => {
    const m = machine();
    const evil = freshDir('config do atacante');
    const secret = (await readConsentSecret(evil, true)) as Buffer;
    const entry = {
      kind: 'http' as const,
      preset: 'compatible' as const,
      base_url: 'http://127.0.0.1:9/v1',
      model: 'x',
      key: 'none' as const,
      consented_at: new Date().toISOString(),
    };
    writeFileSync(
      join(evil, 'llm.json'),
      JSON.stringify({
        version: 1,
        enabled: true,
        providers: { evil: { ...entry, consent: signConsent(secret, 'evil', entry) } },
        roles: { answer: ['evil'] },
      }),
    );
    const config = { unknown: {} } as unknown as BrainConfig;
    // o ator do roteador como "humano" (terminal herdado) não importa: o servidor nunca aceita a pasta desviada
    const io = {
      env: { ...m.env, CABECAO_CONFIG_DIR: evil },
      platform: process.platform,
      homedir: m.home,
      stderr: { write: () => true },
      actor: { actor: 'human' as const },
    };
    expect(await askRunnerFor(io, config)).toBeUndefined();
  });

  it('a pasta do usuário vem do SISTEMA: HOME, USERPROFILE e XDG_CONFIG_HOME do processo não a mudam', () => {
    const fake = freshDir('casa falsa');
    const out = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").userInfo().homedir)'], {
      env: { ...process.env, HOME: fake, USERPROFILE: fake, XDG_CONFIG_HOME: fake, APPDATA: fake },
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(out.stdout).not.toBe('');
    expect(out.stdout).not.toBe(fake);
    expect(out.stdout).toBe(userInfo().homedir);
    // e o caminho padrão para um agente, com o ambiente todo desviado, não lê nada
    const redirected = trustedConfigDir({
      env: { HOME: fake, USERPROFILE: fake, XDG_CONFIG_HOME: fake, APPDATA: fake },
      platform: process.platform,
      homedir: fake,
    });
    expect(redirected.dir).toBeNull();
  });
});

describe('B: o teto de gasto segura chamadas concorrentes (prova q3)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('35 perguntas ao mesmo tempo numa sessão de teto 20: 20 pedidos, o resto limit_reached', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await slowServer();
    const on = await m.cabecao(
      ['llm', 'on', '--provider', 'compatible', '--base-url', api.base, '--model', 'm', '--store', 'file'],
      TERMINAL,
    );
    expect(on.code, on.stderr).toBe(0);
    const brain = await openAsAgent(dir);
    const io = { ...m.io, llmConfigDir: m.configDir };
    const session = { calls: 0 };
    const results = await Promise.all(
      Array.from({ length: 35 }, (_, i) => runAsk(io, brain, { question: `Atlas migrou para SQS? ${i}` }, { session })),
    );
    expect(api.bodies.length - 1).toBe(20);
    expect(results.filter((r) => r.output.unavailable_reason === 'limit_reached')).toHaveLength(15);
  });

  it('o teto por hora vale entre sessões concorrentes (arquivo travado), e a vaga volta quando nada saiu', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await slowServer();
    await m.cabecao(
      ['llm', 'on', '--provider', 'compatible', '--base-url', api.base, '--model', 'm', '--store', 'file'],
      TERMINAL,
    );
    const path = join(m.configDir, 'llm.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as { limits: Record<string, number> };
    config.limits = { ...config.limits, max_calls_per_hour: 5 };
    await writeFile(path, JSON.stringify(config));
    const brain = await openAsAgent(dir);
    const io = { ...m.io, llmConfigDir: m.configDir };
    const sent = api.bodies.length;
    // uma pergunta sem trecho nenhum (nada a mandar) não gasta a vaga
    await runAsk(io, brain, { question: 'zzqxj inexistente kkwyv' }, { session: { calls: 0 } });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runAsk(io, brain, { question: `Atlas migrou para SQS? ${i}` }, { session: { calls: 0 } }),
      ),
    );
    expect(api.bodies.length - sent).toBe(5);
  });
});

describe('F: Claude Code como provedor (prova q4)', () => {
  it('para um agente: sem ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR nem chaves dele; HOME do sistema; PATH sem o dele', () => {
    const env = claudeEnv(
      {
        PATH: '/tmp/path-do-agente:/usr/bin',
        HOME: '/tmp/casa-do-agente',
        ANTHROPIC_BASE_URL: 'https://coletor.exemplo.invalid',
        ANTHROPIC_API_KEY: 'sk-do-agente-0123456789',
        CLAUDE_CONFIG_DIR: '/tmp/cfg-do-agente',
        XDG_CONFIG_HOME: '/tmp/xdg-do-agente',
      },
      true,
      '/opt/claude/bin/claude',
      'linux',
    );
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.HOME).toBe(userInfo().homedir);
    expect(env.PATH).not.toContain('path-do-agente');
    expect(env.PATH?.split(':')[0]).toBe('/opt/claude/bin');
    // para o usuário no terminal, o ambiente dele vale (é ele quem escolhe)
    expect(claudeEnv({ ANTHROPIC_BASE_URL: 'https://proxy.meu' }).ANTHROPIC_BASE_URL).toBe('https://proxy.meu');
  });

  it('roda o executável confirmado, nunca o primeiro "claude" do PATH; sem ele, um agente não roda nada', async () => {
    const bin = freshDir('claude confirmado');
    const confirmed = join(bin, 'claude');
    writeFileSync(confirmed, '#!/bin/sh\n');
    const files: string[] = [];
    const runner = async (file: string) => {
      files.push(file);
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null } as never;
    };
    const request = { system: 's', user: 'u', schema: {}, maxOutputTokens: 10, timeoutMs: 1000 };
    const provider = createClaudeCodeProvider({
      id: 'claude-code',
      model: null,
      env: { PATH: freshDir('path do agente') },
      platform: process.platform,
      binary: confirmed,
      restricted: true,
      run: runner,
    });
    await provider.generate(request).catch(() => {});
    expect(files).toEqual([confirmed]);
    const without = createClaudeCodeProvider({
      id: 'claude-code',
      model: null,
      env: {},
      platform: process.platform,
      restricted: true,
      locate: async () => '/tmp/claude-do-agente',
      run: runner,
    });
    expect((await without.check()).ok).toBe(false);
  });
});

describe('G: nada do provedor para um agente (prova q11)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('uninstall --dry-run --json só diz que há configuração; o ask.log fica na pasta da configuração', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await slowServer();
    await m.cabecao(
      ['llm', 'on', '--provider', 'compatible', '--base-url', api.base, '--model', 'modelo-secreto', '--store', 'file'],
      TERMINAL,
    );
    const shown = await m.cabecao(['uninstall', '--dry-run', '--json']);
    expect(shown.code).toBe(0);
    expect(shown.stdout).not.toMatch(/compatible|modelo-secreto|127\.0\.0\.1/);
    expect(JSON.parse(shown.stdout).data.llm).toEqual({ configured: true });
    const cache = freshDir('cache do agente');
    await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json'], {
      env: { ...m.env, CABECAO_CACHE_DIR: cache },
    });
    await expect(readFile(join(cache, 'ask.log'))).rejects.toThrow();
    expect(await readFile(join(m.configDir, 'ask.log'), 'utf8')).toContain('"status"');
  });
});

describe('K: a conta da chave no cofre', () => {
  it('só caracteres que não mudam o comando do "security -i"', () => {
    expect(SAFE_ACCOUNT.test('openai@api.openai.com')).toBe(true);
    expect(SAFE_ACCOUNT.test('compatible@[::1]:11434')).toBe(true);
    for (const bad of ['x" -w roubada', 'a b', 'a\nb', "a'b"]) expect(SAFE_ACCOUNT.test(bad), bad).toBe(false);
  });
});
