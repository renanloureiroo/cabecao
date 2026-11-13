// `cabecao ask` e `cabecao llm`, de ponta a ponta, sem rede: um servidor HTTP LOCAL que imita a API compatível com
// OpenAI, um Claude Code FALSO (`fake-claude.mjs`) e um executor falso no lugar do cofre do sistema. Nenhum teste toca
// o chaveiro real, a configuração real ou um modelo de verdade.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER_SCHEMA, cacheDir } from '@cabecao/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runAgentProcess } from '../src/agents/index.ts';
import { claudeArgs, claudeEnv, createClaudeCodeProvider, parseClaudeOutput } from '../src/llm/claude-code.ts';
import type { CredentialRunner } from '../src/llm/credentials.ts';
import { deleteKey, maskKey, readKey, storeKey } from '../src/llm/credentials.ts';
import type { CliResult } from '../src/main.ts';
import {
  brainRepo,
  closeOpened,
  disposeSandbox,
  freshDir,
  HUMAN,
  machine,
  parseJson,
  TEST_TIMEOUT_MS,
} from './helpers.ts';

afterAll(async () => {
  await closeOpened();
  disposeSandbox();
});

const KEY = 'sk-teste-NUNCA-NA-SAIDA-0123456789abcdef';
const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

/** Servidor compatível com OpenAI: responde citando o primeiro trecho do prompt (como o provedor falso). */
async function compatibleServer(
  mode: 'ok' | 'fail' = 'ok',
): Promise<{ base: string; bodies: Array<Record<string, unknown>>; headers: IncomingMessage['headers'][] }> {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: IncomingMessage['headers'][] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      bodies.push(body as unknown as Record<string, unknown>);
      headers.push(req.headers);
      if (mode === 'fail') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }));
        return;
      }
      const user = body.messages[1]?.content ?? '';
      const marker = /Marca dos delimitadores desta mensagem: ([0-9a-f]+)/.exec(user)?.[1];
      const match = new RegExp(`<<<TRECHO ${marker} (S\\d+)>>>\\n[\\s\\S]*?\\n---\\n([\\s\\S]*?)\\n<<<FIM`).exec(user);
      const sentence =
        (match?.[2] ?? '')
          .replace(/\^/g, ' ')
          .split(/(?<=[.!?])\s+/)[0]
          ?.trim()
          .slice(0, 150) ?? '';
      const answer = {
        status: 'answered',
        claims: [{ text: sentence, sources: [match?.[1] ?? 'S1'], quote: sentence }],
        missing: '',
      };
      const text = JSON.stringify(answer);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < text.length; i += 16) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(i, i + 16) } }] })}\n\n`,
        );
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies, headers };
}

/** Respostas em sequência para as perguntas do terminal. */
function answers(...list: string[]): { prompt: (q: string) => Promise<string | null>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    prompt: async (question) => {
      asked.push(question);
      return list.shift() ?? '';
    },
  };
}

/** Tudo o que uma execução escreveu, mais os arquivos da máquina (config e cache). */
function everything(results: CliResult[], dirs: string[]): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(readFileSync(path, 'utf8'));
    }
  };
  for (const dir of dirs) walk(dir);
  return [...results.flatMap((r) => [r.stdout, r.stderr]), ...files].join('\n');
}

describe('cabecao ask sem provedor', { timeout: TEST_TIMEOUT_MS }, () => {
  it('não é erro: mostra os trechos achados e como ativar, com código 5; nada sai da máquina', async () => {
    const m = machine();
    const dir = await brainRepo();
    const text = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir]);
    expect(text.code).toBe(5);
    expect(text.stdout).toContain('Nenhum provedor de respostas está ativado');
    expect(text.stdout).toContain('cabecao llm on');
    expect(text.stdout).toContain('fato-atlas-usa-sqs.md');
    expect(text.stderr).toBe('');
    const json = parseJson(await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json']));
    expect(json.data.status).toBe('unavailable');
    expect(json.data.unavailable_reason).toBe('not_configured');
    expect(json.data.passages.length).toBeGreaterThan(0);
    expect(json.data.diagnostics).toBeUndefined();
  });

  it('--show-context mostra o que iria, sem chamar nada; uso errado sai com 2', async () => {
    const m = machine();
    const dir = await brainRepo();
    const shown = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--show-context']);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('Nada foi enviado');
    expect(shown.stdout).toContain('===== mensagem de sistema =====');
    expect(shown.stdout).toContain('<<<TRECHO');
    expect((await m.cabecao(['ask', '--brain', dir])).code).toBe(2);
    expect((await m.cabecao(['ask', 'x', '--limit', '99', '--brain', dir])).code).toBe(2);
    expect((await m.cabecao(['ask', 'x', '--type', 'nao-existe', '--brain', dir])).code).toBe(2);
  });
});

describe('cabecao llm: ativar é com você no terminal', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sem terminal, ou dentro de um agente, recusa ativar e apagar', async () => {
    const m = machine();
    const noTty = await m.cabecao(['llm', 'on', '--provider', 'openai']);
    expect(noTty.code).toBe(4);
    expect(noTty.stderr).toContain('só roda para o usuário, num terminal interativo');
    const inAgent = await m.cabecao(['llm', 'on', '--provider', 'openai'], {
      env: { ...m.env, CLAUDECODE: '1' },
      terminal: { prompt: async () => 's' },
    });
    expect(inAgent.code).toBe(4);
    expect(inAgent.stderr).toContain('CLAUDECODE');
    // desligar, testar (gasta) e apagar também são só seus; ver o estado, não
    for (const sub of [['off'], ['test'], ['remove', 'openai']]) {
      expect((await m.cabecao(['llm', ...sub])).code, sub.join(' ')).toBe(4);
    }
    expect((await m.cabecao(['llm', 'status'])).code).toBe(0);
    // o ask é de memória: um agente pode perguntar
    expect((await m.cabecao(['ask', 'x', '--brain', await brainRepo()])).code).toBe(5);
  });

  it('Antigravity e Codex não são oferecidos, com o motivo', async () => {
    const m = machine();
    const agy = await m.cabecao(['llm', 'on', '--provider', 'antigravity'], { terminal: { prompt: async () => '' } });
    expect(agy.stderr).toContain('Antigravity');
    expect(agy.stderr).toContain('--provider gemini');
    const codex = await m.cabecao(['llm', 'on', '--provider', 'codex'], { terminal: { prompt: async () => '' } });
    expect(codex.stderr).toContain('Codex');
  });

  it('de ponta a ponta: on (mostra o que sai e para onde) → test → ask → status → off → remove; a chave nunca aparece', async () => {
    const m = machine();
    const dir = await brainRepo();
    const api = await compatibleServer();
    const terminal = answers('s');
    const results: CliResult[] = [];
    const on = await m.cabecao(
      ['llm', 'on', '--provider', 'compatible', '--base-url', api.base, '--model', 'modelo-local', '--store', 'file'],
      { terminal: { prompt: terminal.prompt, promptSecret: async () => KEY } },
    );
    results.push(on);
    expect(on.code).toBe(0);
    expect(on.stderr).toContain(`o serviço nesta máquina (${api.base})`);
    expect(on.stderr).toContain('O que NUNCA sai');
    expect(on.stderr).toContain('private: true');
    expect(on.stdout).toContain('Teste: funcionou');
    expect(terminal.asked.at(-1)).toContain('Ativar?');
    const config = JSON.parse(await readFile(join(m.configDir, 'llm.json'), 'utf8'));
    expect(config.enabled).toBe(true);
    expect(config.providers.compatible).toMatchObject({ kind: 'http', key: 'file', model: 'modelo-local' });
    expect(config.providers.compatible.consented_at).toEqual(expect.any(String));
    if (process.platform !== 'win32') {
      expect(statSync(join(m.configDir, 'llm.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(m.configDir, 'credentials.json')).mode & 0o777).toBe(0o600);
    }
    // o teste de ativação não manda nada do cérebro
    expect(JSON.stringify(api.bodies[0])).toContain('Teste do provedor');
    expect(api.headers[0]?.authorization).toBe(`Bearer ${KEY}`);

    const ask = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir]);
    results.push(ask);
    expect(ask.code).toBe(0);
    expect(ask.stdout).toMatch(/\[1\]/);
    expect(ask.stdout).toContain('Fontes:');
    const json = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json']);
    results.push(json);
    const data = parseJson(json).data;
    expect(data.status).toBe('answered');
    // transparência: nem o id, nem o modelo, nem o endereço do provedor
    expect(json.stdout).not.toContain('modelo-local');
    expect(json.stdout).not.toContain('compatible');
    expect(json.stdout).not.toContain('127.0.0.1');
    // --verbose mostra provedor e modelo só para você, no terminal; para um agente, nada disso
    const verbose = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json', '--verbose'], {
      terminal: { prompt: async () => '' },
    });
    results.push(verbose);
    expect(parseJson(verbose).data.diagnostics).toMatchObject({ provider: 'compatible', model: 'modelo-local' });
    const agentVerbose = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json', '--verbose']);
    results.push(agentVerbose);
    expect(agentVerbose.stdout).not.toMatch(/compatible|modelo-local|127\.0\.0\.1/);

    // no terminal: progresso no stderr e cada afirmação conferida sai uma vez só, pelo streaming
    const tty = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir], {
      terminal: { prompt: async () => '' },
    });
    results.push(tty);
    expect(tty.stderr).toContain('gerando a resposta');
    const claimLine = ask.stdout.split('\n')[0] as string;
    expect(tty.stdout.split('\n').filter((line) => line === claimLine)).toHaveLength(1);
    expect(tty.stdout).toContain('Fontes:');

    const status = await m.cabecao(['llm', 'status'], { terminal: { prompt: async () => '' } });
    results.push(status);
    expect(status.stdout).toContain('ligadas');
    expect(status.stdout).toContain(maskKey(KEY));
    const statusJson = await m.cabecao(['llm', 'status', '--json'], { terminal: { prompt: async () => '' } });
    results.push(statusJson);
    expect(parseJson(statusJson).data.providers[0]).toMatchObject({
      id: 'compatible',
      available: true,
      key: { masked: maskKey(KEY) },
    });
    results.push(await m.cabecao(['status', '--brain', dir], { terminal: { prompt: async () => '' } }));
    expect(results.at(-1)?.stdout).toContain('Respostas (ask): Outro serviço compatível');
    results.push(await m.cabecao(['doctor', '--offline', '--brain', dir], { terminal: { prompt: async () => '' } }));
    expect(results.at(-1)?.stdout).toContain('Respostas (ask)');
    // um agente não descobre provedor, modelo nem destino por status, llm status ou doctor (M1)
    for (const args of [
      ['llm', 'status', '--json'],
      ['status', '--brain', dir, '--json'],
      ['doctor', '--offline', '--brain', dir, '--json'],
    ]) {
      const seen = await m.cabecao(args);
      results.push(seen);
      expect(seen.stdout, args.join(' ')).not.toMatch(/compatible|Outro serviço|modelo-local|127\.0\.0\.1/);
    }
    expect(parseJson(results.at(-3) as CliResult).data).toEqual({ enabled: true });

    const off = await m.cabecao(['llm', 'off'], { terminal: { prompt: async () => '' } });
    results.push(off);
    expect(off.stdout).toContain('desligadas');
    const after = await m.cabecao(['ask', 'Atlas migrou para SQS?', '--brain', dir, '--json']);
    results.push(after);
    expect(parseJson(after).data.status).toBe('unavailable');
    expect(api.bodies.length).toBe(6); // teste + 5 perguntas; nada depois do off
    // a chave continua guardada depois do off
    expect(await readFile(join(m.configDir, 'credentials.json'), 'utf8')).toContain(KEY);

    const remove = await m.cabecao(['llm', 'remove', 'compatible'], { terminal: { prompt: async () => 's' } });
    results.push(remove);
    expect(remove.code).toBe(0);
    expect(() => statSync(join(m.configDir, 'credentials.json'))).toThrow();

    // a chave nunca apareceu em saída, log ou arquivo, fora do arquivo protegido (já apagado)
    const cache = cacheDir({ env: m.env, platform: process.platform, homedir: m.home });
    expect(everything(results, [m.configDir, cache])).not.toContain(KEY);
    // o log do ask não guarda trechos do cérebro
    const log = readFileSync(join(cache, 'ask.log'), 'utf8');
    expect(log).not.toContain('migrou de RabbitMQ');
  });

  it('chave recusada: o teste da ativação diz o que houve, sem a chave na mensagem', async () => {
    const m = machine();
    const api = await compatibleServer('fail');
    const on = await m.cabecao(
      ['llm', 'on', '--provider', 'compatible', '--base-url', api.base, '--model', 'm', '--store', 'file'],
      { terminal: { prompt: async () => 's', promptSecret: async () => KEY } },
    );
    expect(on.stdout).toContain('Teste: falhou');
    expect(on.stdout).toContain('recusou a chave');
    expect(`${on.stdout}${on.stderr}`).not.toContain(KEY);
    const test = await m.cabecao(['llm', 'test', '--json'], { terminal: { prompt: async () => '' } });
    expect(test.code).toBe(1);
    expect(test.stdout).not.toContain(KEY);
  });

  it('eval --answers mede as respostas com o provedor ativado (e pede "llm on" sem ele)', async () => {
    const m = machine();
    const dir = await brainRepo();
    const questions = fileURLToPath(new URL('../../../fixtures/eval/respostas.jsonl', import.meta.url));
    const without = await m.cabecao(['eval', '--answers', questions, '--brain', dir], HUMAN);
    expect(without.code).toBe(1);
    expect(without.stderr).toContain('cabecao llm on');
    const api = await compatibleServer();
    await m.cabecao(
      ['llm', 'on', '--provider', 'compatible', '--base-url', api.base, '--model', 'm', '--store', 'file'],
      { terminal: { prompt: async () => 's', promptSecret: async () => KEY } },
    );
    const result = await m.cabecao(['eval', '--answers', questions, '--brain', dir, '--json'], HUMAN);
    expect(result.code).toBe(0);
    const report = parseJson(result).data;
    expect(report.questions).toBe(8);
    expect(report.unanswerable).toBe(2);
    expect(report.citation_validity.value).toBe(1);
    expect(report.results).toHaveLength(8);
    const text = await m.cabecao(['eval', '--answers', questions, '--brain', dir, '--provider', 'compatible'], HUMAN);
    expect(text.stdout).toContain('citações válidas');
    expect(text.stdout).toContain('recusa correta');
  });

  it('base-url de fora sem https é recusada', async () => {
    const m = machine();
    const on = await m.cabecao(
      ['llm', 'on', '--provider', 'compatible', '--base-url', 'http://exemplo.com/v1', '--model', 'm'],
      { terminal: { prompt: async () => 's', promptSecret: async () => KEY } },
    );
    expect(on.code).toBe(2);
    expect(on.stderr).toContain('https');
  });
});

describe('cofre de chaves (executor falso: o cofre real nunca é tocado)', () => {
  function recorder(stored: Map<string, string>): {
    runner: CredentialRunner;
    calls: Array<{ file: string; args: readonly string[]; stdin: string }>;
  } {
    const calls: Array<{ file: string; args: readonly string[]; stdin: string }> = [];
    return {
      calls,
      runner: async (file, args, options) => {
        calls.push({ file, args, stdin: options.stdin });
        if (file.endsWith('security') && args[0] === '-i') {
          const match = /-a (\S+) -w (\S+)/.exec(options.stdin);
          if (match !== null) stored.set(match[1] as string, match[2] as string);
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'find-generic-password')
          return {
            code: stored.has(args[4] as string) ? 0 : 44,
            stdout: `${stored.get(args[4] as string) ?? ''}\n`,
            stderr: '',
          };
        if (args[0] === 'store') {
          stored.set(args[5] as string, options.stdin);
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'lookup') return { code: 0, stdout: stored.get(args[4] as string) ?? '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('macOS: grava pelo "security -i" com a chave na ENTRADA PADRÃO, nunca nos argumentos, e confere lendo', async () => {
    const stored = new Map<string, string>();
    const { runner, calls } = recorder(stored);
    const io = { env: { PATH: '/usr/bin' }, platform: 'darwin' as const, configDir: freshDir('cfg'), runner };
    if (process.platform !== 'darwin') return; // a detecção do `security` olha /usr/bin de verdade
    const result = await storeKey(io, 'anthropic', KEY, 'keychain');
    expect(result.stored).toBe('keychain');
    for (const call of calls) expect(call.args.join(' ')).not.toContain(KEY);
    expect(calls[0]?.stdin).toContain(KEY);
    expect((await readKey(io, 'anthropic', 'keychain', 'ANTHROPIC_API_KEY')).key).toBe(KEY);
    // a variável de ambiente vem antes do cofre
    expect(
      (
        await readKey(
          { ...io, env: { ANTHROPIC_API_KEY: 'sk-da-variavel-1234' } },
          'anthropic',
          'keychain',
          'ANTHROPIC_API_KEY',
        )
      ).source,
    ).toBe('variável ANTHROPIC_API_KEY');
  });

  it('Linux sem secret-tool: cai para o arquivo 0600 e diz por quê', async () => {
    const io = { env: { PATH: freshDir('path vazio') }, platform: 'linux' as const, configDir: freshDir('cfg') };
    const result = await storeKey(io, 'openai', KEY, 'keychain');
    expect(result.stored).toBe('file');
    expect(result.note).toContain('secret-tool');
    expect((await readKey(io, 'openai', 'file', null)).key).toBe(KEY);
    await deleteKey(io, 'openai');
    expect((await readKey(io, 'openai', 'file', null)).key).toBeNull();
  });

  it('chave com espaço ou aspas é recusada antes de ir a qualquer lugar', async () => {
    const io = { env: {}, platform: 'linux' as const, configDir: freshDir('cfg') };
    await expect(storeKey(io, 'x', 'sk "injeção" aqui', 'file')).rejects.toThrow('caracteres inesperados');
    await expect(storeKey(io, 'x', 'curta', 'file')).rejects.toThrow('curta');
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows: DPAPI de verdade, ida e volta, sem a chave em argumento',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const calls: string[][] = [];
      const { systemRunner } = await import('../src/llm/credentials.ts');
      const io = {
        env: process.env,
        platform: 'win32' as const,
        configDir: freshDir('cfg'),
        runner: (async (file, args, options) => {
          calls.push([file, ...args]);
          return systemRunner(file, args, options);
        }) as CredentialRunner,
      };
      const result = await storeKey(io, 'anthropic', KEY, 'keychain');
      expect(result.stored, result.note ?? '').toBe('keychain');
      expect(readFileSync(join(io.configDir, 'credentials.dpapi.json'), 'utf8')).not.toContain(KEY);
      expect(calls.flat().join(' ')).not.toContain(KEY);
      expect((await readKey(io, 'anthropic', 'keychain', null)).key).toBe(KEY);
    },
  );
});

describe('Claude Code como provedor (agente falso)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('argumentos exatos: sem tools, sem MCP, restrito, sem sessão, prompt pela entrada padrão', () => {
    expect(claudeArgs({ schema: ANSWER_SCHEMA, model: 'haiku', systemFile: '/tmp/s.txt' })).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(ANSWER_SCHEMA),
      '--model',
      'haiku',
      '--system-prompt-file',
      '/tmp/s.txt',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--restricted',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--max-turns',
      '3',
    ]);
    expect(claudeArgs({ schema: ANSWER_SCHEMA, model: 'haiku', systemFile: 'x' })).not.toContain('--bare');
  });

  it('ambiente mínimo: só sistema, rede e login do agente', () => {
    const env = claudeEnv({
      PATH: '/bin',
      HOME: '/h',
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'nao',
      CABECAO_BRAIN: 'nao',
      GITHUB_TOKEN: 'nao',
    });
    expect(Object.keys(env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
      'DISABLE_AUTOUPDATER',
      'HOME',
      'PATH',
    ]);
  });

  it('lê as saídas gravadas: sucesso, sem login, sem structured_output, erro sem JSON', () => {
    const base = {
      code: 0,
      signal: null,
      stderr: '',
      timedOut: false,
      interrupted: false,
      spawnError: null,
      durationMs: 1,
    };
    const ok = parseClaudeOutput(
      {
        ...base,
        stdout: JSON.stringify({
          is_error: false,
          structured_output: { a: 1 },
          total_cost_usd: 0.01,
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      },
      1000,
      [],
    );
    expect(ok).toEqual({ object: { a: 1 }, usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.01 });
    expect(() =>
      parseClaudeOutput(
        { ...base, code: 1, stdout: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }) },
        1000,
        [],
      ),
    ).toThrow('não está logado');
    expect(() =>
      parseClaudeOutput({ ...base, stdout: JSON.stringify({ is_error: false, result: 'prefiro não' }) }, 1000, []),
    ).toThrow('formato');
    expect(() => parseClaudeOutput({ ...base, code: 1, stdout: '', stderr: `erro com ${KEY}` }, 1000, [KEY])).toThrow(
      /^(?!.*NUNCA)/,
    );
  });

  function fakeClaude(mode: string, log: string) {
    return createClaudeCodeProvider({
      id: 'claude-code',
      model: null,
      env: { ...process.env, SEGREDO_QUALQUER: 'nao-deve-passar' },
      platform: process.platform,
      locate: async () => 'claude',
      run: (_file, args, options) => runAgentProcess(process.execPath, [FAKE_CLAUDE, log, mode, ...args], options),
    });
  }

  it('gera pelo processo, numa pasta temporária vazia (só o prompt de sistema), sem variáveis estranhas, e apaga a pasta', async () => {
    const log = join(freshDir('log'), 'claude.json');
    const provider = fakeClaude('ok', log);
    const result = await provider.generate({
      system: 'sistema',
      user: 'Pergunta: x\nMarca dos delimitadores desta mensagem: abc123\n<<<TRECHO abc123 S1>>>\ncaminho: a.md\ntítulo: A\n---\nUma frase de teste longa o bastante. Outra.\n<<<FIM abc123>>>',
      schema: ANSWER_SCHEMA,
      maxOutputTokens: 100,
      timeoutMs: 30_000,
    });
    expect(result.object).toMatchObject({
      status: 'answered',
      claims: [{ sources: ['S1'], quote: 'Uma frase de teste longa o bastante.' }],
    });
    expect(result.costUsd).toBe(0.0012);
    const seen = JSON.parse(readFileSync(log, 'utf8'));
    expect(seen.cwdFiles).toEqual(['system.txt']);
    expect(seen.env).not.toContain('SEGREDO_QUALQUER');
    expect(seen.stdin).toContain('<<<TRECHO abc123 S1>>>');
    expect(() => statSync(seen.cwd)).toThrow();
  });

  it('sem login e sem saída estruturada viram os erros certos', async () => {
    const auth = fakeClaude('auth', join(freshDir('log'), 'a.json'));
    await expect(
      auth.generate({ system: 's', user: 'u', schema: ANSWER_SCHEMA, maxOutputTokens: 10, timeoutMs: 30_000 }),
    ).rejects.toMatchObject({ kind: 'not_authenticated' });
    const none = fakeClaude('noschema', join(freshDir('log'), 'b.json'));
    await expect(
      none.generate({ system: 's', user: 'u', schema: ANSWER_SCHEMA, maxOutputTokens: 10, timeoutMs: 30_000 }),
    ).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('tempo limite e cancelamento encerram a árvore de processos (o neto também)', async () => {
    const log = join(freshDir('log'), 'c.json');
    const slow = fakeClaude('sleep', log);
    const started = Date.now();
    await expect(
      slow.generate({ system: 's', user: 'u', schema: ANSWER_SCHEMA, maxOutputTokens: 10, timeoutMs: 1500 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(15_000);
    const grandchild = Number(readFileSync(`${log}.neto`, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try {
      process.kill(grandchild, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await expect(
      fakeClaude('sleep', join(freshDir('log'), 'd.json')).generate({
        system: 's',
        user: 'u',
        schema: ANSWER_SCHEMA,
        maxOutputTokens: 10,
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('não instalado: check() diz o motivo', async () => {
    const provider = createClaudeCodeProvider({
      id: 'claude-code',
      model: null,
      env: { PATH: freshDir('vazio') },
      platform: process.platform,
    });
    expect(await provider.check()).toMatchObject({ ok: false, kind: 'not_installed' });
  });
});
