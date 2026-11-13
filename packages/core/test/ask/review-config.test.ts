// Regressões da revisão adversária (PR #20) no núcleo: A2 (llm.json forjado: endereço validado na leitura e só nos
// presets que aceitam endereço; confirmação assinada e amarrada ao destino) e M6 (um agente não muda a `llm_policy`,
// nem com o token de confirmação).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ask, createFakeProvider } from '../../src/ask/index.ts';
import { BrainError } from '../../src/brain/index.ts';
import type { HttpProviderEntry, LlmConfig } from '../../src/llm/index.ts';
import {
  activeProviderIds,
  LlmConfigError,
  readConsentSecret,
  signConsent,
  validateLlmConfig,
} from '../../src/llm/index.ts';
import {
  cleanupAll,
  createBrainRepo,
  disposeSandbox,
  git,
  openTest,
  TEST_TIMEOUT_MS,
  tokenOf,
} from '../brain/helpers.ts';

afterEach(cleanupAll);
afterAll(disposeSandbox);

function file(providers: Record<string, unknown>): unknown {
  return { version: 1, enabled: true, providers, roles: { answer: Object.keys(providers) } };
}

const http = (extra: Record<string, unknown>) => ({
  kind: 'http',
  model: 'm',
  key: 'env:K',
  consented_at: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('A2: o llm.json é conferido a cada leitura', () => {
  it('endereço só nos presets compatible, ollama e lmstudio; obrigatório no compatible', () => {
    for (const preset of ['anthropic', 'openai', 'gemini', 'openrouter', 'groq']) {
      expect(
        () =>
          validateLlmConfig('llm.json', file({ p: http({ preset, base_url: 'https://proxy.terceiro.example/v1' }) })),
        preset,
      ).toThrow(LlmConfigError);
    }
    expect(() => validateLlmConfig('llm.json', file({ p: http({ preset: 'compatible' }) }))).toThrow(LlmConfigError);
    expect(() =>
      validateLlmConfig(
        'llm.json',
        file({ p: http({ preset: 'compatible', base_url: 'https://api.exemplo.com/v1' }) }),
      ),
    ).not.toThrow();
  });

  it('um endereço inválido escrito à mão é recusado na leitura (http de fora, metadados, usuário na URL)', () => {
    for (const base_url of [
      'http://evil.example/v1',
      'https://169.254.169.254/v1',
      'https://u:p@api.exemplo.com',
      'http://localhost.evil.com',
    ]) {
      expect(
        () => validateLlmConfig('llm.json', file({ p: http({ preset: 'compatible', base_url }) })),
        base_url,
      ).toThrow(LlmConfigError);
    }
  });

  it('sem a assinatura local, ou com o destino trocado depois da confirmação, nenhum provedor fica ativo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cabecao-consent-'));
    try {
      expect(await readConsentSecret(dir)).toBeNull();
      const secret = (await readConsentSecret(dir, true)) as Buffer;
      expect(secret).toHaveLength(32);
      if (process.platform !== 'win32') {
        const { stat } = await import('node:fs/promises');
        expect((await stat(join(dir, 'llm-consent.key'))).mode & 0o777).toBe(0o600);
      }
      const entry = http({ preset: 'compatible', base_url: 'http://127.0.0.1:9/v1' }) as unknown as HttpProviderEntry;
      const signed: HttpProviderEntry = { ...entry, consent: signConsent(secret, 'p', entry) };
      const config = (providers: Record<string, unknown>): LlmConfig =>
        validateLlmConfig('llm.json', file(providers)) as LlmConfig;
      // forjado: consented_at preenchido, sem assinatura
      expect(activeProviderIds(config({ p: entry }), secret)).toEqual([]);
      // assinado por outro segredo (outra máquina, ou um agente que inventou)
      expect(
        activeProviderIds(config({ p: { ...entry, consent: signConsent(Buffer.alloc(32, 7), 'p', entry) } }), secret),
      ).toEqual([]);
      expect(activeProviderIds(config({ p: signed }), secret)).toEqual(['p']);
      // a mesma assinatura com o endereço trocado (para onde os trechos iriam) não vale
      expect(activeProviderIds(config({ p: { ...signed, base_url: 'https://outro.example/v1' } }), secret)).toEqual([]);
      expect(activeProviderIds(config({ p: { ...signed, model: 'outro' } }), secret)).toEqual([]);
      expect(activeProviderIds(config({ p: signed }), null)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('M6: a llm_policy é protegida como a seção embedding', { timeout: TEST_TIMEOUT_MS }, () => {
  it('um agente não abre o envio, nem com o token de confirmação (prova p12)', async () => {
    const dir = await createBrainRepo();
    const path = join(dir, '.cabecao.json');
    const json = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    json.llm_policy = { allow: 'none' };
    await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'politica']);
    const agent = await openTest(dir, { client: 'agente-x', actor: 'agent' });
    const provider = createFakeProvider();
    const before = await ask(agent, { question: 'Atlas migrou para SQS?' }, { providers: [provider] });
    expect(before.output.unavailable_reason).toBe('disabled_for_brain');

    const open = { ...json };
    delete open.llm_policy;
    const input = { path: '.cabecao.json', mode: 'overwrite' as const, content: `${JSON.stringify(open, null, 2)}\n` };
    const refused = async (promise: Promise<unknown>): Promise<BrainError> => {
      try {
        await promise;
      } catch (error) {
        if (error instanceof BrainError) return error;
        throw error;
      }
      throw new Error('deveria ter recusado');
    };
    const first = await refused(agent.writePage(input));
    expect(first.message).toContain('llm_policy');
    // mesmo que o agente tivesse um token (decisão 37: num cliente sem elicitação, quem confirma é ele), não passa
    const loosened = { ...json, llm_policy: { allow: 'any' } };
    const second = await refused(
      agent.writePage({ ...input, content: `${JSON.stringify(loosened, null, 2)}\n`, confirm_token: 'qualquer' }),
    );
    expect(second.message).toContain('llm_policy');
    const after = await ask(agent, { question: 'Atlas migrou para SQS?' }, { providers: [provider] });
    expect(after.output.unavailable_reason).toBe('disabled_for_brain');
    expect(provider.calls).toHaveLength(0);

    // o usuário (actor human) muda; e uma mudança de outra seção, pelo agente, continua possível
    const human = await openTest(dir, { client: 'cli', actor: 'human' });
    const changed = await human.writePage(input);
    expect(changed.status === 'confirmation_required' ? tokenOf(changed) : 'ok').toBeTruthy();
  });
});
