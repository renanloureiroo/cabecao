// Os dois adaptadores HTTP contra um servidor HTTP LOCAL que imita cada API (nada sai da máquina): formato da
// requisição, streaming, erros, novas tentativas, tempo limite, teto de tamanho e a chave nunca numa mensagem.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenerateRequest, GenerationProvider } from '../../src/ask/index.ts';
import { ANSWER_SCHEMA, ProviderError } from '../../src/ask/index.ts';
import type { HttpPresetId } from '../../src/llm/index.ts';
import { ANTHROPIC_VERSION, createHttpProvider, HTTP_PRESETS, redact, validateBaseUrl } from '../../src/llm/index.ts';

const KEY = 'sk-test-CHAVE-SECRETA-0123456789abcdef';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Handler = (req: Seen, res: ServerResponse, n: number) => void;

let server: Server | null = null;

async function serve(handler: Handler): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const item: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw === '' ? {} : JSON.parse(raw),
      };
      seen.push(item);
      handler(item, res, seen.length);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, seen };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

const ANSWER = {
  status: 'answered',
  claims: [{ text: 'Sim.', sources: ['S1'], quote: 'trecho literal do teste' }],
  missing: '',
};

function request(extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    system: 'sistema',
    user: 'Pergunta: x',
    schema: ANSWER_SCHEMA,
    maxOutputTokens: 300,
    timeoutMs: 5_000,
    ...extra,
  };
}

function provider(
  preset: HttpPresetId,
  base: string,
  extra: { key?: string | null; retries?: number } = {},
): GenerationProvider {
  const key = extra.key === undefined ? KEY : extra.key;
  return createHttpProvider({
    id: preset,
    preset: HTTP_PRESETS[preset],
    model: 'modelo-teste',
    baseUrl: base,
    resolveKey: async () => ({ key, missing: 'defina a variável de teste' }),
    sleep: async () => {},
    ...(extra.retries === undefined ? {} : { retries: extra.retries }),
  });
}

function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) {
    res.write(
      `${e.event === undefined ? '' : `event: ${e.event}\n`}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`,
    );
  }
  res.end();
}

function anthropicStream(res: ServerResponse, text: string, stop = 'end_turn'): void {
  const half = Math.floor(text.length / 2);
  sse(res, [
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 123 } } } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } },
    },
    { event: 'ping', data: { type: 'ping' } },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } },
    },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 45 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('deveria ter falhado');
}

describe('Anthropic Messages', () => {
  it('monta a requisição certa e lê o streaming (texto aos poucos, uso)', async () => {
    const { base, seen } = await serve((_req, res) => anthropicStream(res, JSON.stringify(ANSWER)));
    const deltas: string[] = [];
    const result = await provider('anthropic', base).generate(request({ onText: (d) => deltas.push(d) }));
    expect(result.object).toEqual(ANSWER);
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
    expect(deltas.length).toBe(2);
    const req = seen[0] as Seen;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toEqual({
      model: 'modelo-teste',
      max_tokens: 300,
      system: 'sistema',
      messages: [{ role: 'user', content: 'Pergunta: x' }],
      output_config: { format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
      stream: true,
    });
  });

  it('recusa (stop_reason refusal) e corte por limite (max_tokens)', async () => {
    let stop = 'refusal';
    const { base } = await serve((_req, res) => anthropicStream(res, '{"status":', stop));
    expect((await failure(provider('anthropic', base).generate(request()))).kind).toBe('refused');
    stop = 'max_tokens';
    expect((await failure(provider('anthropic', base).generate(request()))).kind).toBe('invalid_output');
  });

  it('401 vira not_authenticated, sem nova tentativa, e a chave ecoada pelo servidor é redigida', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }),
      );
    });
    const error = await failure(provider('anthropic', base).generate(request()));
    expect(error.kind).toBe('not_authenticated');
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain('[chave omitida]');
    expect(seen).toHaveLength(1);
  });

  it('429 e 529 são tentados de novo (com retry-after); 400 não', async () => {
    const { base, seen } = await serve((_req, res, n) => {
      if (n === 1) {
        res.writeHead(429, { 'retry-after': '0' });
        res.end('{"error":{"message":"rate limited"}}');
      } else if (n === 2) {
        res.writeHead(529);
        res.end('{"error":{"type":"overloaded_error","message":"overloaded"}}');
      } else anthropicStream(res, JSON.stringify(ANSWER));
    });
    expect((await provider('anthropic', base).generate(request())).object).toEqual(ANSWER);
    expect(seen).toHaveLength(3);

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const bad = await serve((_req, res) => {
      res.writeHead(400);
      res.end('{"error":{"message":"bad"}}');
    });
    const error = await failure(provider('anthropic', bad.base).generate(request()));
    expect(error.kind).toBe('unknown');
    expect(error.retryable).toBe(false);
    expect(bad.seen).toHaveLength(1);
  });

  it('5xx em todas as tentativas: desiste depois das novas tentativas', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(503);
      res.end('fora do ar');
    });
    const error = await failure(provider('anthropic', base, { retries: 2 }).generate(request()));
    expect(error.retryable).toBe(true);
    expect(seen).toHaveLength(3);
  });

  it('tempo limite: o servidor não responde', async () => {
    const { base } = await serve(() => {
      // nunca responde
    });
    const error = await failure(provider('anthropic', base).generate(request({ timeoutMs: 300 })));
    expect(error.kind).toBe('timeout');
  });

  it('cancelamento pelo chamador', async () => {
    const { base } = await serve(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await failure(provider('anthropic', base).generate(request({ signal: controller.signal })));
    expect(error.kind).toBe('cancelled');
  });

  it('resposta gigante é descartada (teto de tamanho)', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(64 * 1024) } })}\n\n`;
      for (let i = 0; i < 40; i++) res.write(chunk);
      res.end();
    });
    const error = await failure(provider('anthropic', base).generate(request()));
    expect(error.kind).toBe('invalid_output');
    expect(error.message).toContain('KiB');
  });

  it('evento de erro no meio do streaming', async () => {
    const { base } = await serve((_req, res) =>
      sse(res, [
        { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
      ]),
    );
    const error = await failure(provider('anthropic', base, { retries: 0 }).generate(request()));
    expect(error.kind).toBe('rate_limited');
  });

  it('sem chave: check() diz onde ela deveria estar e generate não chama a rede', async () => {
    const { base, seen } = await serve(() => {});
    const p = provider('anthropic', base, { key: null });
    expect(await p.check()).toEqual({ ok: false, kind: 'not_authenticated', reason: 'defina a variável de teste' });
    expect((await failure(p.generate(request()))).kind).toBe('not_authenticated');
    expect(seen).toHaveLength(0);
  });
});

describe('Chat Completions compatível com OpenAI', () => {
  function chunks(text: string, usage = true): Array<{ data: unknown }> {
    const out: Array<{ data: unknown }> = [
      { data: { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } },
    ];
    for (let i = 0; i < text.length; i += 10)
      out.push({ data: { choices: [{ index: 0, delta: { content: text.slice(i, i + 10) }, finish_reason: null }] } });
    out.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
    if (usage) out.push({ data: { choices: [], usage: { prompt_tokens: 77, completion_tokens: 12 } } });
    out.push({ data: '[DONE]' });
    return out;
  }

  it('OpenAI: requisição com json_schema estrito, max_completion_tokens e uso no streaming', async () => {
    const { base, seen } = await serve((_req, res) => sse(res, chunks(JSON.stringify(ANSWER))));
    const result = await provider('openai', base).generate(request());
    expect(result.object).toEqual(ANSWER);
    expect(result.usage).toEqual({ inputTokens: 77, outputTokens: 12 });
    const req = seen[0] as Seen;
    expect(req.url).toBe('/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toEqual({
      model: 'modelo-teste',
      messages: [
        { role: 'system', content: 'sistema' },
        { role: 'user', content: 'Pergunta: x' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'cabecao_answer', strict: true, schema: ANSWER_SCHEMA },
      },
      max_completion_tokens: 300,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('OpenRouter manda só provedores que não coletam dados; Gemini usa max_tokens', async () => {
    const { base, seen } = await serve((_req, res) => sse(res, chunks(JSON.stringify(ANSWER))));
    await provider('openrouter', base).generate(request());
    expect(seen[0]?.body.provider).toEqual({ require_parameters: true, data_collection: 'deny' });
    await provider('gemini', base).generate(request());
    expect(seen[1]?.body.max_tokens).toBe(300);
    expect(seen[1]?.body.stream_options).toBeUndefined();
  });

  it('Groq: sem streaming (saída estruturada não transmite), JSON inteiro', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(ANSWER) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }),
      );
    });
    const result = await provider('groq', base).generate(request());
    expect(result.object).toEqual(ANSWER);
    expect(seen[0]?.body.stream).toBeUndefined();
    expect(seen[0]?.body.max_completion_tokens).toBe(300);
  });

  it('servidor local (Ollama) sem chave e com o JSON embrulhado em cerca de código', async () => {
    const { base, seen } = await serve((_req, res) =>
      sse(res, chunks(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``, false)),
    );
    const local = provider('ollama', base, { key: null });
    expect(local.leavesMachine).toBe(false);
    expect(await local.check()).toEqual({ ok: true });
    expect((await local.generate(request())).object).toEqual(ANSWER);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('recusa (refusal) e corte por limite (length)', async () => {
    let mode = 'refusal';
    const { base } = await serve((_req, res) =>
      sse(res, [
        {
          data: {
            choices: [
              {
                delta: mode === 'refusal' ? { refusal: 'não posso' } : { content: '{"status":' },
                finish_reason: mode === 'refusal' ? 'stop' : 'length',
              },
            ],
          },
        },
        { data: '[DONE]' },
      ]),
    );
    expect((await failure(provider('openai', base).generate(request()))).kind).toBe('refused');
    mode = 'length';
    expect((await failure(provider('openai', base).generate(request()))).kind).toBe('invalid_output');
  });

  it('texto que não é JSON vira invalid_output, sem a chave na mensagem', async () => {
    const { base } = await serve((_req, res) => sse(res, chunks(`desculpe, a sua chave ${KEY} não serve`, false)));
    const error = await failure(provider('openai', base).generate(request()));
    expect(error.kind).toBe('invalid_output');
    expect(error.message).not.toContain(KEY);
  });

  it('rede fora: network, com novas tentativas', async () => {
    const { base } = await serve(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    const error = await failure(provider('openai', base, { retries: 1 }).generate(request()));
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });
});

describe('endereço base e redação', () => {
  it('só https, ou http em localhost; sem usuário e senha', () => {
    expect(validateBaseUrl('https://api.exemplo.com/v1/')).toBe('https://api.exemplo.com/v1');
    expect(validateBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(validateBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(() => validateBaseUrl('http://api.exemplo.com/v1')).toThrow('https');
    expect(() => validateBaseUrl('https://user:senha@api.exemplo.com')).toThrow('usuário');
    expect(() => validateBaseUrl('ftp://x')).toThrow();
    expect(() => validateBaseUrl('não é url')).toThrow('válido');
  });

  it('redige a chave conhecida e padrões comuns de chave', () => {
    const text = redact(`a ${KEY} b sk-ant-api03-abcdefghijk AIzaSyA1234567890abcdefghijk Bearer abc.def.ghi-123`, [
      KEY,
    ]);
    expect(text).not.toContain(KEY);
    expect(text).not.toMatch(/sk-ant-api03-abc|AIzaSy|abc\.def\.ghi/);
  });
});
