// Teste REAL e opcional contra as APIs de verdade: pulado sem `CABECAO_TEST_LLM=1` e sem a variável de chave de cada
// provedor. Nunca roda no CI. Cada provedor recebe UMA pergunta mínima, sem nada de cérebro nenhum, e a resposta tem
// de vir no formato e com a citação conferida. Custa centavos de dólar por execução.
import { describe, expect, it } from 'vitest';
import type { Passage } from '../../src/ask/index.ts';
import {
  ANSWER_SCHEMA,
  assembleAnswer,
  buildPrompt,
  readLlmPolicy,
  selectOutbound,
  validateAnswer,
} from '../../src/ask/index.ts';
import type { HttpPresetId } from '../../src/llm/index.ts';
import { createHttpProvider, HTTP_PRESETS } from '../../src/llm/index.ts';

const ENABLED = process.env.CABECAO_TEST_LLM === '1';
const PRESETS: HttpPresetId[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'groq'];

const PASSAGE: Passage = {
  id: 'teste',
  path: 'teste/ceu.md',
  title: 'Teste',
  type: 'fact',
  scope: null,
  heading_path: [],
  validity: 'current',
  trust: 'high',
  origin: 'human',
  edited_by: null,
  updated: null,
  ended_on: null,
  starts_on: null,
  related: false,
  score: 1,
  content: 'Neste teste do Cabeção, o céu do planeta Atlas é verde-limão durante o dia inteiro.',
  frontmatter: {},
};

describe('provedores reais (opcional)', () => {
  for (const id of PRESETS) {
    const preset = HTTP_PRESETS[id];
    const key = preset.envKey === null ? undefined : process.env[preset.envKey];
    const model = process.env[`CABECAO_TEST_${id.toUpperCase()}_MODEL`] ?? preset.defaultModel;
    it.skipIf(!ENABLED || key === undefined || key === '' || model === null)(
      `${preset.label}: responde no formato, com citação conferida`,
      async () => {
        const provider = createHttpProvider({
          id,
          preset,
          model: model as string,
          resolveKey: async () => ({ key: key ?? null, missing: '' }),
        });
        const outbound = selectOutbound([PASSAGE], readLlmPolicy({ unknown: {} }), { indexMd: 'index.md' }, 1000);
        const prompt = buildPrompt('De que cor é o céu do planeta Atlas no teste?', '2026-11-13', outbound.passages);
        const result = await provider.generate({
          system: prompt.system,
          user: prompt.user,
          schema: ANSWER_SCHEMA,
          maxOutputTokens: 1024,
          timeoutMs: 60_000,
        });
        const validation = validateAnswer(result.object);
        expect(validation.ok).toBe(true);
        if (validation.ok) expect(assembleAnswer(validation.value, outbound.passages).status).toBe('answered');
      },
      90_000,
    );
  }
});
