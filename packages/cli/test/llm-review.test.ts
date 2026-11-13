// Regressões da revisão adversária (PR #20) na CLI: A2 (configuração desviada por variável de ambiente e llm.json
// forjado), M1 (o agente não descobre provedor, modelo nem destino), M6 (`cabecao llm policy` é só do usuário) e os
// achados baixos (endereço em preset fixo, teto de gasto, `llm remove` que não esconde falha do cofre, `eval
// --answers` depois do `llm off`, permissões do arquivo de chaves, caminho e seção sem sequência de terminal).
// Sem rede de fora, sem chave real, sem o cofre real e sem a configuração real da máquina.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpProviderEntry } from '@cabecao/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CredentialRunner } from '../src/llm/credentials.ts';
import { credentialAccount, deleteKey, readKey, storeKey } from '../src/llm/credentials.ts';
import { loopbackMayBeProxied } from '../src/llm/machine.ts';
import { runAsk } from '../src/llm/run.ts';
import {
  brainRepo,
  closeOpened,
  disposeSandbox,
  freshDir,
  HUMAN,
  machine,
  openAsAgent,
  parseJson,
  TEST_TIMEOUT_MS,
  writeNote,
} from './helpers.ts';

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

/** Servidor compatível com OpenAI, sem streaming: cita a primeira frase do primeiro trecho; ou recusa com 401. */
async function compatibleServer(mode: 'ok' | 'fail' = 'ok'): Promise<{ base: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      bodies.push(body);
      if (mode === 'fail') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key for org org-USUARIO-123 project proj_meu' } }));
        return;
      }
      const user = body.messages[1]?.content ?? '';
      const marker = /Marca dos delimitadores desta mensagem: ([0-9a-f]+)/.exec(user)?.[1];
      const match = new RegExp(`<<<TRECHO ${marker} (S\\d+)>>>\\n[\\s\\S]*?\\n---\\n([\\s\\S]*?)\\n<<<FIM`).exec(user);
      const sentence =
        (match?.[2] ?? '')
          .replace(/\^/g, ' ')
          .split(/(?<=[.!?])\s+/)[0]
          ?.trim() ?? '';
      const answer = {
        status: 'answered',
        claims: [{ text: sentence, sources: [match?.[1] ?? 'S1'], quote: sentence }],
      };
      const content = JSON.stringify({ ...answer, missing: '' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };
}

const TERMINAL = { terminal: { prompt: async () => 's', promptSecret: async () => KEY } };
const QUIET = { terminal: { prompt: async () => '' } };

function onArgs(base: string): string[] {
  return [
    'llm',
    'on',
    '--provider',
    'compatible',
    '--base-url',
    base,
    '--model',
    'modelo-secreto-x',
    '--store',
    'file',
  ];
}

describe('A2: a configuração das respostas não vem de onde um agente aponta', { timeout: TEST_TIMEOUT_MS }, () => {
  it('desviada por CABECAO_CONFIG_DIR: vale para você no terminal, não para um agente (prova p3)', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await compatibleServer();
    // sem `llmConfigDir`: o caminho do programa instalado (pasta do usuário do sistema, ou a do ambiente desviada)
    const real = { llmConfigDir: undefined };
    const on = await m.cabecao(onArgs(api.base), { ...real, ...TERMINAL });
    expect(on.code).toBe(0);
    expect(statSync(join(m.configDir, 'llm.json')).isFile()).toBe(true);
    expect(api.bodies).toHaveLength(1); // o teste da ativação

    const agent = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json'], real);
    expect(parseJson(agent).data.status).toBe('unavailable');
    expect(api.bodies).toHaveLength(1); // nada saiu para o agente
    const agentStatus = await m.cabecao(['llm', 'status', '--json'], real);
    expect(parseJson(agentStatus).data).toEqual({ enabled: false });

    const human = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json'], { ...real, ...QUIET });
    expect(parseJson(human).data.status).toBe('answered');
    expect(api.bodies).toHaveLength(2);
  });

  it('llm.json escrito à mão (consented_at sem a assinatura local) não ativa nada', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await compatibleServer();
    mkdirSync(m.configDir, { recursive: true });
    writeFileSync(
      join(m.configDir, 'llm.json'),
      JSON.stringify({
        version: 1,
        enabled: true,
        providers: {
          compatible: {
            kind: 'http',
            preset: 'compatible',
            base_url: api.base,
            model: 'm',
            key: 'env:K',
            consented_at: '2026-01-01T00:00:00Z',
            consent: 'ab'.repeat(32),
          },
        },
        roles: { answer: ['compatible'] },
      }),
    );
    const env = { ...m.env, K: KEY };
    const ask = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json'], { env });
    expect(parseJson(ask).data.status).toBe('unavailable');
    expect(api.bodies).toHaveLength(0);
    const status = await m.cabecao(['llm', 'status', '--json'], { env, ...QUIET });
    expect(parseJson(status).data.providers[0]).toMatchObject({ id: 'compatible', active: false });
  });

  it('a chave guardada fica amarrada ao destino: trocar o endereço não a entrega a outro servidor', async () => {
    const entry = (base_url: string): HttpProviderEntry =>
      ({
        kind: 'http',
        preset: 'compatible',
        base_url,
        model: 'm',
        key: 'file',
        consented_at: null,
      }) as HttpProviderEntry;
    const a = credentialAccount('compatible', entry('https://api.exemplo.com/v1'));
    const b = credentialAccount('compatible', entry('https://outro.example/v1'));
    expect(a).not.toBe(b);
    const io = { env: {}, platform: 'linux' as const, configDir: freshDir('cfg-destino') };
    await storeKey(io, a, KEY, 'file');
    expect((await readKey(io, a, 'file', null)).key).toBe(KEY);
    expect((await readKey(io, b, 'file', null)).key).toBeNull();
  });
});

describe('M1: um agente não descobre provedor, modelo nem destino', { timeout: TEST_TIMEOUT_MS }, () => {
  it('nem pelo erro do provedor, nem por --show-context ou --verbose (prova p6)', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await compatibleServer('fail');
    await m.cabecao(onArgs(api.base), TERMINAL);
    const hidden = /compatible|modelo-secreto|127\.0\.0\.1|org-USUARIO|proj_meu|HTTP 401|Outro serviço/;
    for (const args of [
      ['ask', 'Atlas migrou para SQS?', '--brain', dir],
      ['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json', '--verbose'],
      ['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json', '--show-context'],
      ['ask', 'Atlas migrou para SQS?', '--brain', dir, '--show-context'],
    ]) {
      const result = await m.cabecao(args);
      expect(`${result.stdout}${result.stderr}`, args.join(' ')).not.toMatch(hidden);
    }
    // para você, no terminal, o motivo aparece
    const human = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir], QUIET);
    expect(human.stdout).toContain('compatible');
  });
});

describe('M6: a política de envio é sua, no terminal', { timeout: TEST_TIMEOUT_MS }, () => {
  it('"cabecao llm policy" recusa um agente (código 4) e grava para você, com confirmação', async () => {
    const m = machine();
    const dir = await brainRepo();
    const agent = await m.cabecao(['llm', 'policy', '--allow', 'any', '--brain', dir]);
    expect(agent.code).toBe(4);
    const human = await m.cabecao(['llm', 'policy', '--allow', 'none', '--brain', dir], {
      terminal: { prompt: async () => 's' },
    });
    expect(human.code).toBe(0);
    const config = JSON.parse(await readFile(join(dir, '.cabecao.json'), 'utf8')) as { llm_policy?: unknown };
    expect(config.llm_policy).toEqual({ allow: 'none' });
  });
});

describe('achados baixos', { timeout: TEST_TIMEOUT_MS }, () => {
  it('--base-url num preset de endereço fixo é recusado (o destino mostrado é o real; prova p13)', async () => {
    const m = machine();
    for (const provider of ['anthropic', 'openai', 'groq']) {
      const on = await m.cabecao(
        ['llm', 'on', '--provider', provider, '--base-url', 'https://proxy.terceiro.example/v1', '--model', 'm'],
        TERMINAL,
      );
      expect(on.code, provider).toBe(2);
      expect(on.stderr).toContain('--base-url');
    }
  });

  it('teto de gasto por hora: estourado, o ask devolve só os trechos, sem chamar o provedor', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await compatibleServer();
    await m.cabecao(onArgs(api.base), TERMINAL);
    const path = join(m.configDir, 'llm.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as { limits: Record<string, number> };
    config.limits = { ...config.limits, max_calls_per_hour: 2 };
    await writeFile(path, JSON.stringify(config));
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      const data = parseJson(await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json'])).data;
      statuses.push(`${data.status}${data.unavailable_reason === undefined ? '' : `:${data.unavailable_reason}`}`);
      if (i === 2) expect(data.passages.length).toBeGreaterThan(0);
    }
    expect(statuses).toEqual(['answered', 'answered', 'unavailable:limit_reached']);
    expect(api.bodies).toHaveLength(3); // teste da ativação + 2 perguntas
  });

  it('teto por sessão do servidor MCP: a sessão que já gastou o teto não chama o provedor (prova p9)', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await compatibleServer();
    await m.cabecao(onArgs(api.base), TERMINAL);
    const brain = await openAsAgent(dir);
    const io = { ...m.io, llmConfigDir: m.configDir };
    const session = { calls: 0 };
    const first = await runAsk(io, brain, { question: 'Atlas migrou para SQS?' }, { session });
    expect(first.output.status).toBe('answered');
    expect(session.calls).toBe(1);
    session.calls = 20;
    const capped = await runAsk(io, brain, { question: 'Atlas migrou para SQS?' }, { session });
    expect(capped.output.unavailable_reason).toBe('limit_reached');
    expect(api.bodies).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')(
    '"llm remove" não diz "apagado" quando o cofre recusou: devolve o problema',
    async () => {
      const bin = freshDir('path-secret-tool');
      writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'secret-tool'), 0o755);
      const runner: CredentialRunner = async (_file, args) =>
        args[0] === 'clear' ? { code: 9, stdout: '', stderr: 'locked' } : { code: 0, stdout: '', stderr: '' };
      const io = { env: { PATH: bin }, platform: 'linux' as const, configDir: freshDir('cfg-remove'), runner };
      const problems = await deleteKey(io, 'openai@api.openai.com');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('secret-tool');
    },
  );

  it('"eval --answers --provider" respeita o "llm off": nada é chamado', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await compatibleServer();
    await m.cabecao(onArgs(api.base), TERMINAL);
    await m.cabecao(['llm', 'off'], QUIET);
    const questions = fileURLToPath(new URL('../../../fixtures/eval/respostas.jsonl', import.meta.url));
    const result = await m.cabecao(['eval', '--answers', questions, '--brain', dir, '--provider', 'compatible'], HUMAN);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('não está ligado');
    expect(api.bodies).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'arquivo de chaves: fechado (0600) antes de receber a chave; pasta gravável por outros é recusada',
    async () => {
      const configDir = freshDir('cfg-perm');
      chmodSync(configDir, 0o700);
      const io = { env: {}, platform: 'linux' as const, configDir };
      writeFileSync(join(configDir, 'credentials.json'), '{"version":1,"keys":{}}\n', { mode: 0o644 });
      chmodSync(join(configDir, 'credentials.json'), 0o644);
      await storeKey(io, 'openai@api.openai.com', KEY, 'file');
      expect(statSync(join(configDir, 'credentials.json')).mode & 0o777).toBe(0o600);
      const open = freshDir('cfg-aberta');
      chmodSync(open, 0o777);
      await expect(storeKey({ ...io, configDir: open }, 'x@y', KEY, 'file')).rejects.toThrow('outros usuários');
      expect(() => readFileSync(join(open, 'credentials.json'))).toThrow();
    },
  );

  it('caminho e seção de uma nota de fora saem sem sequência de terminal (prova p7b)', async () => {
    const m = machine();
    const dir = await brainRepo();
    await writeNote(
      dir,
      'raw/articles/hostil.md',
      '---\ntrust: low\norigin: ingest:web\n---\n\n# Filas \u001b]0;JANELA\u0007 \u001b[2J\u001b[31mVERMELHO\n\nO Atlas usa SQS para as filas.\n',
    );
    const result = await m.cabecao(['ask', 'Atlas SQS filas', '--brain', dir]);
    expect(result.stdout).toContain('hostil.md');
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout).not.toContain('\u0007');
  });
});

describe('M2: um servidor desta máquina nunca vai pelo proxy', () => {
  it('com NODE_USE_ENV_PROXY e sem localhost em NO_PROXY, o servidor local é recusado', () => {
    const viaNode = 'proxy do ambiente (NODE_USE_ENV_PROXY=1; inclua localhost em NO_PROXY se usar um servidor local)';
    expect(loopbackMayBeProxied({}, viaNode)).toBe(true);
    expect(loopbackMayBeProxied({ NO_PROXY: 'localhost,127.0.0.1' }, viaNode)).toBe(false);
    expect(loopbackMayBeProxied({ no_proxy: '*' }, viaNode)).toBe(false);
    // ligado pelo Cabeção (setGlobalProxyFromEnv), os endereços locais já vão em NO_PROXY
    expect(loopbackMayBeProxied({}, 'proxy do ambiente (HTTPS_PROXY; endereços desta máquina sempre sem proxy)')).toBe(
      false,
    );
    expect(loopbackMayBeProxied({}, null)).toBe(false);
  });
});

describe('uninstall leva o provedor de respostas junto', { timeout: TEST_TIMEOUT_MS }, () => {
  it.skipIf(process.platform === 'win32')(
    'apaga a chave no cofre (executor falso) e o llm.json; o cérebro fica',
    async () => {
      const m = machine();
      const dir = await brainRepo();
      const api = await compatibleServer();
      const bin = freshDir('path-cofre');
      writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'secret-tool'), 0o755);
      const vault = new Map<string, string>();
      const calls: string[] = [];
      const credentialRunner: CredentialRunner = async (_file, args, options) => {
        const account = args[args.indexOf('account') + 1] ?? '';
        calls.push(`${args[0]} ${account}`);
        if (args[0] === 'store') vault.set(account, options.stdin.trim());
        if (args[0] === 'lookup') return { code: 0, stdout: vault.get(account) ?? '', stderr: '' };
        if (args[0] === 'clear') vault.delete(account);
        return { code: 0, stdout: '', stderr: '' };
      };
      const linux = { platform: 'linux' as const, env: { ...m.env, PATH: bin }, credentialRunner };
      const on = await m.cabecao(
        ['llm', 'on', '--provider', 'compatible', '--base-url', api.base, '--model', 'm', '--store', 'keychain'],
        { ...linux, ...TERMINAL },
      );
      expect(on.code, on.stderr).toBe(0);
      expect([...vault.values()]).toEqual([KEY]);
      const shown = await m.cabecao(['uninstall', '--dry-run'], { ...linux, ...QUIET });
      expect(shown.stdout).toContain('respostas (ask)');
      expect(shown.stdout).toContain('compatible');
      const done = await m.cabecao(['uninstall'], { ...linux, terminal: { prompt: async () => 's' } });
      expect(done.code, done.stdout + done.stderr).toBe(0);
      expect(vault.size).toBe(0);
      expect(calls.some((call) => call.startsWith('clear compatible@'))).toBe(true);
      expect(() => statSync(join(m.configDir, 'llm.json'))).toThrow();
      expect(() => statSync(join(m.configDir, 'llm-consent.key'))).toThrow();
      expect(statSync(join(dir, '.cabecao.json')).isFile()).toBe(true);
    },
  );
});
