// `cabecao llm on|off|status|test|remove|policy`: o provedor que gera as respostas do `ask` NESTA máquina, e a política
// de envio do cérebro. Desligado por padrão; nada sai da máquina até você ativar aqui, vendo o que passa a sair e para
// onde. Pela regra de quem é quem da CLI (`access.ts`), `on`, `off`, `test`, `remove` e `policy` são só do usuário no
// terminal (código 4 para um agente); `status` roda para todos, mas para um agente diz só se as respostas estão ligadas.
// A confirmação do `on` é assinada com um segredo local (`llm-consent.key`): um `llm.json` escrito à mão não ativa nada.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentProviderEntry,
  GenerationProvider,
  HttpPreset,
  HttpPresetId,
  HttpProviderEntry,
  KeyRef,
  LlmConfig,
  Passage,
  ProviderEntry,
} from '@cabecao/core';
import {
  ANSWER_SCHEMA,
  activeProviderIds,
  assembleAnswer,
  BASE_URL_PRESETS,
  buildPrompt,
  emptyLlmConfig,
  HTTP_PRESET_IDS,
  HTTP_PRESETS,
  isHttpPresetId,
  isOllamaCloudModel,
  LLM_POLICY_ALLOW,
  LLM_POLICY_KEY,
  PROVIDER_ID_RE,
  ProviderError,
  readConsentSecret,
  readLlmPolicy,
  selectOutbound,
  signConsent,
  validateAnswer,
  validateBaseUrl,
  writeLlmConfig,
} from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { CLAUDE_CODE_LABEL } from '../llm/claude-code.ts';
import type { CredentialIo } from '../llm/credentials.ts';
import {
  credentialAccount,
  deleteKey,
  describeKeyRef,
  keyProblem,
  maskKey,
  readKey,
  storeKey,
} from '../llm/credentials.ts';
import { confirmed } from '../llm/describe.ts';
import type { HumanIo } from '../llm/human.ts';
import { requireHuman } from '../llm/human.ts';
import type { LlmMachine } from '../llm/machine.ts';
import { buildProvider, describeEntry, detectLlm, enableProxyFromEnv, loadLlmMachine } from '../llm/machine.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const AGENT_ID = 'claude-code';

const yes = (answer: string | null, byDefault: boolean): boolean => {
  if (answer === null) return false;
  const a = answer.trim().toLowerCase();
  if (a === '') return byDefault;
  return ['s', 'sim', 'y', 'yes'].includes(a);
};

function credentialIo(ctx: CommandContext, machine: LlmMachine): CredentialIo {
  return { env: ctx.env, platform: ctx.platform, configDir: machine.configDir };
}

async function save(machine: LlmMachine, config: LlmConfig): Promise<void> {
  try {
    await writeLlmConfig(machine.configDir, config);
  } catch (error) {
    throw new CliError(
      `não consegui gravar ${machine.configDir}/llm.json: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'ELLM_WRITE',
        hint: 'Confira a permissão da pasta de configuração do Cabeção (veja "cabecao doctor").',
      },
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// on

interface Choice {
  readonly label: string;
  readonly agent?: true;
  readonly preset?: HttpPresetId;
  /** A chave vem desta variável (detectada). */
  readonly env?: string;
}

function choices(detected: Awaited<ReturnType<typeof detectLlm>>): { found: Choice[]; others: Choice[] } {
  const found: Choice[] = [];
  if (detected.claude.path !== null) {
    found.push({ label: `${CLAUDE_CODE_LABEL} (${detected.claude.path}), com o login da sua conta`, agent: true });
  }
  for (const { preset, env } of detected.envKeys) {
    found.push({ label: `${HTTP_PRESETS[preset].label}, com a chave da variável ${env}`, preset, env });
  }
  const others: Choice[] = HTTP_PRESET_IDS.map((preset) => ({
    label: HTTP_PRESETS[preset].needsKey
      ? `${HTTP_PRESETS[preset].label} (colar uma chave)`
      : HTTP_PRESETS[preset].label,
    preset,
  }));
  return { found, others };
}

function costLine(entry: ProviderEntry, config: LlmConfig): string {
  const limits = `até ${config.limits.max_output_tokens} tokens de saída e ~${config.limits.context_tokens} de contexto por pergunta, ${Math.round(config.limits.timeout_ms / 1000)} s por chamada`;
  if (entry.kind === 'agent') {
    return `Quem paga: sai dos limites da sua assinatura do Claude (ou da chave que o Claude Code usar). Limites do Cabeção: ${limits}.`;
  }
  if (!describeEntry(entry).leaves) return `Custo: roda nesta máquina, sem cobrança por pergunta. Limites: ${limits}.`;
  return `Quem paga: você, na conta do provedor, por token (veja os preços na página do provedor). Limites do Cabeção: ${limits}; para um teto de gasto, configure-o no painel do provedor.`;
}

function disclosure(id: string, entry: ProviderEntry, config: LlmConfig): string {
  const d = describeEntry(entry);
  const lines = [
    '',
    `Para responder ao "cabecao ask" e à tool "ask" dos seus agentes, o Cabeção vai enviar a: ${d.destination}`,
    `  Provedor "${id}" · modelo ${d.model}${d.leaves ? '' : ' · roda nesta máquina'}`,
    '',
    `O que sai, a cada pergunta: a pergunta e até ~${config.limits.context_tokens} tokens de trechos das notas que a busca achar,`,
    '  com o caminho, o título, o tipo, a validade e a proveniência (trust, origin) de cada um.',
    'O que NUNCA sai: notas com "private: true" no frontmatter; arquivos de controle (catálogo, diário, AGENTS.md,',
    '  CLAUDE.md e afins, cópias de conflito); qualquer trecho em que o scanner de segredos acusar algo (o trecho é',
    '  omitido e a omissão aparece na resposta); o que a "llm_policy" do .cabecao.json do cérebro excluir; a chave.',
    'A resposta nunca é gravada no cérebro nem executada: é só lida.',
  ];
  if (entry.kind === 'agent') {
    lines.push(
      '',
      'Política de dados: a da sua conta Anthropic. Nos planos Free, Pro e Max, o uso para treino depende da sua',
      '  configuração de privacidade (https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training,',
      '  consultada em 2026-11-13); com chave de API valem os termos comerciais (sem treino por padrão).',
      'Se o seu agente da conversa também é o Claude Code, cada "ask" abre uma segunda sessão: custa em dobro.',
    );
  } else {
    const preset = HTTP_PRESETS[entry.preset];
    if (preset.policy !== null) {
      lines.push(
        '',
        `Política de dados (${preset.policy.url}, consultada em ${preset.policy.checked}):`,
        `  ${preset.policy.summary}`,
      );
    }
  }
  lines.push(
    '',
    costLine(entry, config),
    `Para desligar: cabecao llm off. Para apagar ${entry.kind === 'http' && entry.key !== 'none' ? 'a chave e o provedor' : 'o provedor'}: cabecao llm remove ${id}.`,
  );
  return lines.join('\n');
}

async function ask(human: HumanIo, question: string): Promise<string | null> {
  return human.prompt(question);
}

async function chooseModel(human: HumanIo, preset: HttpPreset, flag: string | undefined): Promise<string> {
  if (flag !== undefined) return flag;
  if (preset.defaultModel !== null) return preset.defaultModel;
  const hint = preset.modelsUrl === null ? '' : ` (veja ${preset.modelsUrl})`;
  const answer = (await ask(human, `Qual modelo usar${hint}? `))?.trim() ?? '';
  if (answer === '') throw new UsageError(`diga o modelo: cabecao llm on --provider ${preset.id} --model <modelo>`);
  return answer;
}

async function runOn(ctx: CommandContext): Promise<CommandResult> {
  const human = requireHuman(ctx, 'Ativar um provedor de respostas');
  const machine = await loadLlmMachine(ctx);
  if (machine.problem !== null) {
    ctx.stderr.write(`cabecao: ${machine.problem}\ncabecao: a configuração será refeita do zero.\n`);
  }
  let config = machine.config ?? emptyLlmConfig();
  const flagProvider = typeof ctx.values.provider === 'string' ? ctx.values.provider : undefined;
  const flagModel = typeof ctx.values.model === 'string' ? ctx.values.model : undefined;

  // religar o que já estava, sem perguntar de novo o resto
  const previous = config.roles.answer.find((id) => config.providers[id]?.consented_at != null);
  if (
    flagProvider === undefined &&
    !config.enabled &&
    previous !== undefined &&
    confirmed(machine, previous, config.providers[previous] as ProviderEntry)
  ) {
    const entry = config.providers[previous] as ProviderEntry;
    const d = describeEntry(entry);
    if (
      yes(
        await ask(
          human,
          `Religar as respostas com ${d.label} (modelo ${d.model}, envia para ${d.destination})? [S/n] `,
        ),
        true,
      )
    ) {
      config = { ...config, enabled: true };
      await save(machine, config);
      return {
        data: { enabled: true, provider: previous },
        text: `Respostas religadas com ${d.label}. Rode "cabecao llm test" para conferir.`,
      };
    }
  }

  const detected = await detectLlm(ctx);
  let choice: Choice;
  if (flagProvider !== undefined) {
    if (flagProvider === AGENT_ID || flagProvider === 'claude') choice = { label: CLAUDE_CODE_LABEL, agent: true };
    else if (isHttpPresetId(flagProvider)) {
      const env = detected.envKeys.find((k) => k.preset === flagProvider)?.env;
      choice = { label: HTTP_PRESETS[flagProvider].label, preset: flagProvider, ...(env === undefined ? {} : { env }) };
    } else if (['antigravity', 'agy', 'gemini-cli'].includes(flagProvider)) {
      throw new CliError('o Antigravity instalado não é oferecido como provedor de respostas', {
        code: 'ELLM_UNSUPPORTED',
        hint: 'A FAQ do Antigravity diz que chamar o "agy" de outro aplicativo não é suportado nos planos pessoais. Para os modelos do Google, use a API do Gemini: cabecao llm on --provider gemini.',
      });
    } else if (flagProvider === 'codex') {
      throw new CliError('o Codex não é oferecido como provedor de respostas', {
        code: 'ELLM_UNSUPPORTED',
        hint: 'Os termos só permitem chamá-lo de outro programa com chave de API (não com o login do ChatGPT), e com essa chave a API da OpenAI faz o mesmo sem subir um agente: cabecao llm on --provider openai.',
      });
    } else {
      throw new UsageError(
        `provedor desconhecido: ${flagProvider}. Use claude-code ou um de ${HTTP_PRESET_IDS.join(', ')}`,
      );
    }
  } else {
    const { found, others } = choices(detected);
    const list = [...found, ...others];
    const lines = [];
    if (found.length > 0) {
      lines.push('Achei nesta máquina:');
      for (const [i, c] of found.entries()) lines.push(`  ${i + 1}  ${c.label}`);
      lines.push('Outras opções:');
    } else lines.push('Nenhum agente nem chave conhecida nesta máquina. Opções:');
    for (const [i, c] of others.entries()) lines.push(`  ${found.length + i + 1}  ${c.label}`);
    ctx.stderr.write(`${lines.join('\n')}\n`);
    const answer = (await ask(human, 'Qual deve gerar as respostas do "cabecao ask"? [1] ')) ?? '';
    const index = answer.trim() === '' ? 0 : Number(answer.trim()) - 1;
    const picked = list[index];
    if (!Number.isInteger(index) || picked === undefined)
      throw new UsageError(`escolha um número de 1 a ${list.length}`);
    choice = picked;
  }

  let id: string;
  let entry: ProviderEntry;
  let pastedKey: string | null = null;
  const consentedAt = new Date().toISOString();
  if (choice.agent === true) {
    if (detected.claude.path === null) {
      throw new CliError(`o Claude Code não está disponível: ${detected.claude.problem ?? 'não encontrado'}`, {
        code: 'ELLM_MISSING',
        hint: 'Instale e faça login no Claude Code (rode "claude" uma vez), ou escolha uma API: cabecao llm on --provider anthropic.',
      });
    }
    id = AGENT_ID;
    entry = {
      kind: 'agent',
      agent: 'claude-code',
      model: flagModel ?? null,
      consented_at: consentedAt,
    } satisfies AgentProviderEntry;
  } else {
    const preset = HTTP_PRESETS[choice.preset as HttpPresetId];
    id = preset.id;
    const model = await chooseModel(human, preset, flagModel);
    let baseUrl: string | undefined;
    const flagBase = typeof ctx.values['base-url'] === 'string' ? ctx.values['base-url'] : undefined;
    if (flagBase !== undefined && !BASE_URL_PRESETS.has(preset.id)) {
      throw new UsageError(
        `--base-url não vale para ${preset.label}: o endereço dele é fixo. Para outro serviço, use --provider compatible.`,
      );
    }
    const wantedBase =
      flagBase ??
      (preset.baseUrl === null
        ? ((await ask(human, 'Endereço base do serviço (ex.: https://api.exemplo.com/v1): ')) ?? '')
        : undefined);
    if (wantedBase !== undefined) {
      try {
        baseUrl = validateBaseUrl(wantedBase);
      } catch (error) {
        throw new UsageError(`--base-url: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let key: KeyRef;
    const keyEnv = typeof ctx.values['key-env'] === 'string' ? ctx.values['key-env'] : choice.env;
    if (!preset.needsKey && preset.id !== 'compatible') key = 'none';
    else if (keyEnv !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(keyEnv))
        throw new UsageError(`--key-env: nome de variável inválido: ${keyEnv}`);
      key = `env:${keyEnv}`;
      if ((ctx.env[keyEnv] ?? '') === '')
        ctx.stderr.write(`cabecao: aviso: a variável ${keyEnv} não está definida neste terminal.\n`);
    } else {
      if (ctx.promptSecret === undefined) {
        throw new CliError('não há como ler a chave sem mostrá-la neste terminal', {
          code: 'EHUMAN_REQUIRED',
          hint: `Defina a variável ${preset.envKey ?? 'da chave'} e use --key-env ${preset.envKey ?? 'NOME'}.`,
        });
      }
      const optional = preset.id === 'compatible' ? ' (Enter se o serviço não usa chave)' : '';
      const pasted =
        (
          await ctx.promptSecret(`Cole a chave de API de ${preset.label}${optional}; ela não aparece na tela: `)
        )?.trim() ?? '';
      if (pasted === '' && preset.id === 'compatible') key = 'none';
      else {
        const problem = keyProblem(pasted);
        if (problem !== null) throw new UsageError(problem);
        pastedKey = pasted;
        key = ctx.values.store === 'file' ? 'file' : 'keychain';
      }
    }
    let paidTier: boolean | undefined;
    if (preset.id === 'gemini') {
      ctx.stderr.write(`\nAtenção: ${preset.warning}\n`);
      paidTier = yes(
        await ask(human, 'A sua chave é de um projeto com faturamento ativo (camada paga)? [s/N] '),
        false,
      );
      if (!paidTier) {
        ctx.stderr.write(
          'Na camada gratuita, os trechos das suas notas podem ser lidos por revisores do Google e usados para melhorar os produtos dele.\n',
        );
      }
    } else if (preset.warning !== null) ctx.stderr.write(`\nAtenção: ${preset.warning}\n`);
    if (preset.id === 'ollama' && isOllamaCloudModel(model)) {
      ctx.stderr.write(
        `\nAtenção: "${model}" é um modelo de nuvem do Ollama: roda nos servidores do ollama.com mesmo chamado por localhost, e o conteúdo sai da máquina.\n`,
      );
    }
    entry = {
      kind: 'http',
      preset: preset.id,
      ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
      model,
      key,
      consented_at: consentedAt,
      ...(paidTier === undefined ? {} : { paid_tier: paidTier }),
    } satisfies HttpProviderEntry;
  }
  if (!PROVIDER_ID_RE.test(id)) throw new UsageError(`nome de provedor inválido: ${id}`);

  ctx.stderr.write(`${disclosure(id, entry, config)}\n\n`);
  if (!yes(await ask(human, 'Ativar? [s/N] '), false)) {
    return {
      code: 1,
      data: { enabled: config.enabled, cancelled: true },
      text: 'Nada foi ativado e nada saiu da máquina.',
    };
  }
  let keyNote: string | null = null;
  if (pastedKey !== null && entry.kind === 'http') {
    // a chave fica amarrada ao provedor E ao destino
    const stored = await storeKey(
      credentialIo(ctx, machine),
      credentialAccount(id, entry),
      pastedKey,
      entry.key === 'file' ? 'file' : 'keychain',
    );
    entry = { ...entry, key: stored.stored };
    keyNote = stored.note;
  }
  // a confirmação é assinada com o segredo local desta máquina (criado aqui, com o usuário no terminal)
  const secret = await readConsentSecret(machine.configDir, true);
  if (secret === null) {
    throw new CliError(`não consegui criar o segredo local em ${machine.configDir}`, { code: 'ELLM_WRITE' });
  }
  entry = { ...entry, consent: signConsent(secret, id, entry) };
  config = {
    ...config,
    enabled: true,
    providers: { ...config.providers, [id]: entry },
    roles: { answer: [id, ...config.roles.answer.filter((other) => other !== id)] },
  };
  await save(machine, config);
  const d = describeEntry(entry);
  const where =
    entry.kind === 'http' && entry.key !== 'none'
      ? `Chave: ${describeKeyRef(entry.key, HTTP_PRESETS[entry.preset].envKey, ctx.platform, machine.configDir)}.`
      : '';
  const test = await testProvider(ctx, machine, id, entry);
  const lines = [
    `Respostas ativadas com ${d.label} (modelo ${d.model}).`,
    ...(where === '' ? [] : [where]),
    ...(keyNote === null ? [] : [`Aviso: ${keyNote}.`]),
    test.ok
      ? `Teste: funcionou em ${(test.ms / 1000).toFixed(1).replace('.', ',')} s.`
      : `Teste: falhou (${test.message}). ${test.fix}`,
    'Pergunte com: cabecao ask "o que decidimos sobre ...?"',
    'Nos agentes, a tool "ask" aparece na próxima sessão (reinicie o cliente de IA).',
  ];
  return { data: { enabled: true, provider: id, test }, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------------------------------------------
// test

interface TestResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly message: string;
  readonly fix: string;
}

const TEST_PASSAGE: Passage = {
  id: 'teste',
  path: 'teste/ceu.md',
  title: 'Teste do provedor',
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
  unreadable: false,
  tainted: false,
};

function fixFor(error: unknown): string {
  if (!(error instanceof ProviderError)) return 'Rode de novo com CABECAO_DEBUG=1 para ver detalhes.';
  switch (error.kind) {
    case 'not_installed':
      return 'Instale o programa ou confira o endereço do servidor.';
    case 'not_authenticated':
      return 'Confira a chave (ou o login do agente) e rode "cabecao llm on" de novo.';
    case 'rate_limited':
      return 'Espere um pouco ou confira o limite e o crédito no painel do provedor.';
    case 'timeout':
    case 'network':
      return 'Confira a conexão (e o proxy, se houver) e tente de novo.';
    case 'invalid_output':
      return 'O modelo não seguiu o formato: tente outro modelo com "cabecao llm on --model <modelo>".';
    case 'refused':
      return 'O modelo recusou um texto inofensivo: tente outro modelo.';
    default:
      return 'Confira o modelo e o endereço com "cabecao llm status".';
  }
}

/** Uma chamada mínima, sem nada do cérebro, que confere o formato e a citação. */
async function testProvider(
  ctx: CommandContext,
  machine: LlmMachine,
  id: string,
  entry: ProviderEntry,
): Promise<TestResult> {
  const provider: GenerationProvider = buildProvider(ctx, machine, id, entry);
  if (entry.kind === 'http') await enableProxyFromEnv(ctx.env);
  const started = Date.now();
  const check = await provider.check();
  if (!check.ok)
    return {
      ok: false,
      ms: 0,
      message: check.reason ?? 'indisponível',
      fix: fixFor(new ProviderError(check.kind ?? 'not_installed', '')),
    };
  const outbound = selectOutbound([TEST_PASSAGE], readLlmPolicy({ unknown: {} }), { indexMd: 'index.md' }, 1000);
  const prompt = buildPrompt(
    'De que cor é o céu do planeta Atlas no teste?',
    new Date().toISOString().slice(0, 10),
    outbound.passages,
  );
  try {
    const result = await provider.generate({
      system: prompt.system,
      user: prompt.user,
      schema: ANSWER_SCHEMA,
      maxOutputTokens: 512,
      timeoutMs: (machine.config?.limits.timeout_ms ?? 60_000) + (entry.kind === 'agent' ? 60_000 : 0),
    });
    const ms = Date.now() - started;
    const validation = validateAnswer(result.object);
    if (!validation.ok)
      return {
        ok: false,
        ms,
        message: `resposta fora do formato: ${validation.errors.join('; ')}`,
        fix: fixFor(new ProviderError('invalid_output', '')),
      };
    const assembled = assembleAnswer(validation.value, outbound.passages);
    if (assembled.status !== 'answered') {
      return {
        ok: false,
        ms,
        message: 'a resposta veio sem citação conferida',
        fix: 'O formato está certo, mas o modelo não citou o trecho: tente outro modelo.',
      };
    }
    return { ok: true, ms, message: 'resposta no formato, com citação conferida', fix: '' };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
      fix: fixFor(error),
    };
  }
}

async function runTest(ctx: CommandContext): Promise<CommandResult> {
  // uma chamada de verdade: gasta com o provedor do usuário
  requireHuman(ctx, 'Testar o provedor de respostas');
  const machine = await loadLlmMachine(ctx);
  if (machine.problem !== null) throw new CliError(machine.problem, { code: 'ELLM_CONFIG' });
  const config = machine.config;
  const wanted = typeof ctx.values.provider === 'string' ? ctx.values.provider : undefined;
  const id = wanted ?? activeProviderIds(config, machine.secret)[0] ?? config?.roles.answer[0];
  const entry = id === undefined ? undefined : config?.providers[id];
  if (id === undefined || entry === undefined) {
    throw new CliError(
      wanted === undefined
        ? 'nenhum provedor de respostas configurado nesta máquina'
        : `o provedor "${wanted}" não está configurado`,
      {
        code: 'ELLM_NONE',
        hint: 'Rode "cabecao llm on" num terminal para escolher um.',
      },
    );
  }
  const test = await testProvider(ctx, machine, id, entry);
  const d = describeEntry(entry);
  const text = test.ok
    ? `${d.label} (modelo ${d.model}) respondeu em ${(test.ms / 1000).toFixed(1).replace('.', ',')} s: ${test.message}. Nenhum conteúdo do cérebro foi enviado.`
    : `${d.label} (modelo ${d.model}) falhou: ${test.message}\n${test.fix}`;
  return { code: test.ok ? 0 : 1, data: { provider: id, ...test }, text };
}

// ---------------------------------------------------------------------------------------------------------------
// status

async function runStatus(ctx: CommandContext): Promise<CommandResult> {
  const machine = await loadLlmMachine(ctx);
  const config = machine.config;
  if (ctx.actor.actor !== 'human') {
    // um agente sabe só se as respostas estão ligadas (decisão 38: ele não descobre provedor, modelo nem destino)
    const on = config !== null && activeProviderIds(config, machine.secret).length > 0;
    return {
      data: { enabled: on },
      text: `Respostas com modelo: ${on ? 'ligadas' : 'desligadas'}.`,
    };
  }
  if (machine.problem !== null) {
    return {
      data: { configured: false, enabled: false, problem: machine.problem, providers: [] },
      text: `Respostas (ask): configuração inválida. ${machine.problem}`,
    };
  }
  if (config === null || Object.keys(config.providers).length === 0) {
    const detected = await detectLlm(ctx);
    const hint =
      detected.claude.path !== null
        ? 'Achei o Claude Code instalado: "cabecao llm on" usa ele, com uma confirmação.'
        : detected.envKeys.length > 0
          ? `Achei a variável ${detected.envKeys[0]?.env}: "cabecao llm on" usa ela.`
          : '"cabecao llm on" ativa (Anthropic, OpenAI, Gemini, OpenRouter, Groq ou um servidor local).';
    return {
      data: { configured: false, enabled: false, problem: null, providers: [] },
      text: `Respostas (ask): não configuradas (opcional; nada sai da máquina). ${hint}`,
    };
  }
  const active = new Set(activeProviderIds(config, machine.secret));
  const providers = [];
  const lines = [
    `Respostas (ask): ${config.enabled ? 'ligadas' : 'desligadas ("cabecao llm on" religa)'}`,
    `Ordem de uso: ${config.roles.answer.join(', ') || 'nenhuma'}`,
  ];
  for (const [id, entry] of Object.entries(config.providers)) {
    const d = describeEntry(entry);
    const provider = buildProvider(ctx, machine, id, entry);
    const availability = await provider.check();
    let key: { location: string; masked: string | null } | null = null;
    if (entry.kind === 'http' && entry.key !== 'none') {
      const preset = HTTP_PRESETS[entry.preset];
      const location = describeKeyRef(entry.key, preset.envKey, ctx.platform, machine.configDir);
      // só mostra o final da chave para alguém no terminal; o resto do tempo, só onde ela está
      const read =
        ctx.prompt !== undefined
          ? await readKey(credentialIo(ctx, machine), credentialAccount(id, entry), entry.key, preset.envKey)
          : null;
      key = { location: read?.source ?? location, masked: read?.key == null ? null : maskKey(read.key) };
    }
    providers.push({
      id,
      kind: entry.kind,
      label: d.label,
      model: d.model,
      destination: d.destination,
      leaves_machine: d.leaves,
      consented_at: entry.consented_at,
      active: active.has(id),
      available: availability.ok,
      reason: availability.reason ?? null,
      key,
    });
    lines.push(
      `  ${id}: ${d.label} · modelo ${d.model} · ${d.leaves ? `envia para ${d.destination}` : 'roda nesta máquina'}`,
    );
    lines.push(
      `    ${entry.consented_at === null ? 'sem confirmação' : `ativado em ${entry.consented_at.slice(0, 10)}`} · ${availability.ok ? 'disponível' : `indisponível: ${availability.reason ?? '?'}`}`,
    );
    if (key !== null) lines.push(`    chave: ${key.location}${key.masked === null ? '' : ` (${key.masked})`}`);
  }
  const proxy = await enableProxyFromEnv(ctx.env);
  lines.push(
    `Limites: ~${config.limits.context_tokens} tokens de contexto, ${config.limits.max_output_tokens} de saída e ${Math.round(config.limits.timeout_ms / 1000)} s por chamada`,
  );
  if (proxy !== null) lines.push(`Rede: ${proxy}`);
  lines.push(`Configuração: ${machine.configDir}/llm.json · log: ${machine.cacheDir}/ask.log`);
  return {
    data: { configured: true, enabled: config.enabled, problem: null, providers, limits: config.limits, proxy },
    text: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// off e remove

async function runOff(ctx: CommandContext): Promise<CommandResult> {
  requireHuman(ctx, 'Desligar o provedor de respostas');
  const machine = await loadLlmMachine(ctx);
  if (machine.config === null || !machine.config.enabled) {
    return { data: { enabled: false }, text: 'As respostas já estão desligadas: nada sai da máquina.' };
  }
  await save(machine, { ...machine.config, enabled: false });
  return {
    data: { enabled: false },
    text: 'Respostas desligadas: nada mais sai da máquina pelo "ask". A configuração e a chave continuam; "cabecao llm on" religa e "cabecao llm remove <provedor>" apaga a chave.',
  };
}

async function runRemove(ctx: CommandContext): Promise<CommandResult> {
  const human = requireHuman(ctx, 'Apagar um provedor e a chave dele');
  const [id] = ctx.positionals.slice(1);
  const machine = await loadLlmMachine(ctx);
  const config = machine.config;
  if (id === undefined)
    throw new UsageError('diga qual provedor apagar: cabecao llm remove <provedor> (veja "cabecao llm status")');
  if (config === null || config.providers[id] === undefined) {
    throw new CliError(`o provedor "${id}" não está configurado`, {
      code: 'ELLM_NONE',
      hint: 'Veja os configurados com "cabecao llm status".',
    });
  }
  if (!yes(await human.prompt(`Apagar o provedor "${id}" e a chave que o Cabeção guardou para ele? [s/N] `), false)) {
    return { code: 1, data: { removed: false }, text: 'Nada foi apagado.' };
  }
  const entry0 = config.providers[id] as ProviderEntry;
  const problems =
    entry0.kind === 'http' ? await deleteKey(credentialIo(ctx, machine), credentialAccount(id, entry0)) : [];
  const { [id]: _removed, ...providers } = config.providers;
  const answer = config.roles.answer.filter((other) => other !== id);
  await save(machine, { ...config, providers, roles: { answer }, enabled: config.enabled && answer.length > 0 });
  const entry = config.providers[id];
  const envNote =
    entry?.kind === 'http' && HTTP_PRESETS[entry.preset].envKey !== null
      ? ` Se a chave também estiver na variável ${HTTP_PRESETS[entry.preset].envKey}, ela é sua: apague-a do seu shell.`
      : '';
  if (problems.length > 0) {
    return {
      code: 1,
      data: { removed: true, provider: id, key_removed: false, problems },
      text: `Provedor "${id}" apagado da configuração, mas a chave guardada NÃO foi apagada: ${problems.join('; ')}. Apague-a no cofre do sistema (serviço "cabecao").${envNote}`,
    };
  }
  return {
    data: { removed: true, provider: id, key_removed: true },
    text: `Provedor "${id}" apagado, com a chave que o Cabeção guardava.${envNote}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// policy: a política de envio do cérebro (`llm_policy` no .cabecao.json). Só o usuário muda (um agente não, nem com
// confirmação). Ela só RESTRINGE: quem libera um provedor é sempre a configuração da máquina (`llm on`).

function listOf(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

async function runPolicy(ctx: CommandContext): Promise<CommandResult> {
  const human = requireHuman(ctx, 'Mudar a política de envio do cérebro');
  const root = await resolveBrain(ctx);
  const allow = typeof ctx.values.allow === 'string' ? ctx.values.allow : undefined;
  const paths = listOf(ctx.values['exclude-path']);
  const types = listOf(ctx.values['exclude-type']);
  const trust = listOf(ctx.values['exclude-trust']);
  const clear = ctx.values.clear === true;
  if (allow !== undefined && !(LLM_POLICY_ALLOW as readonly string[]).includes(allow)) {
    throw new UsageError(`--allow deveria ser um de ${LLM_POLICY_ALLOW.join(', ')}`);
  }
  const path = join(root, '.cabecao.json');
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const before = (current[LLM_POLICY_KEY] ?? null) as Record<string, unknown> | null;
  const show = (policy: unknown): string =>
    policy === null || policy === undefined ? 'nenhuma (não restringe além da máquina)' : JSON.stringify(policy);
  if (allow === undefined && paths.length === 0 && types.length === 0 && trust.length === 0 && !clear) {
    return {
      data: { policy: before },
      text: `Política de envio deste cérebro (llm_policy): ${show(before)}`,
    };
  }
  const next: Record<string, unknown> | null = clear
    ? null
    : {
        ...(before ?? {}),
        ...(allow === undefined ? {} : { allow }),
        ...(paths.length === 0 ? {} : { exclude_paths: paths }),
        ...(types.length === 0 ? {} : { exclude_types: types }),
        ...(trust.length === 0 ? {} : { exclude_trust: trust }),
      };
  const policy = readLlmPolicy({ unknown: next === null ? {} : { [LLM_POLICY_KEY]: next } });
  if (policy.problem !== null) throw new UsageError(policy.problem);
  if (!yes(await human.prompt(`Gravar a política ${show(next)} no .cabecao.json (vai para o git)? [s/N] `), false)) {
    return { code: 1, data: { policy: before, changed: false }, text: 'Nada mudou.' };
  }
  const updated = { ...current };
  if (next === null) delete updated[LLM_POLICY_KEY];
  else updated[LLM_POLICY_KEY] = next;
  const result = await withBrain(ctx, root, (brain) =>
    // o usuário acabou de confirmar no terminal
    brain.writePage(
      { path: '.cabecao.json', content: `${JSON.stringify(updated, null, 2)}\n`, mode: 'overwrite' },
      { userConfirmed: true },
    ),
  );
  return {
    data: { policy: next, changed: true, commit: (result as { commit?: string }).commit ?? null },
    text: `Política de envio gravada: ${show(next)}. Rode "cabecao sync" para levá-la às outras máquinas.`,
  };
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [sub, ...rest] = ctx.positionals;
  if (sub !== 'remove' && sub !== 'policy' && rest.length > 0) {
    throw new UsageError(`argumento a mais: ${rest.join(' ')}`);
  }
  switch (sub) {
    case undefined:
    case 'status':
      return runStatus(ctx);
    case 'on':
      return runOn(ctx);
    case 'off':
      return runOff(ctx);
    case 'test':
      return runTest(ctx);
    case 'remove':
      return runRemove(ctx);
    case 'policy':
      return runPolicy(ctx);
    default:
      throw new UsageError(`subcomando desconhecido: ${sub}. Use on, off, status, test, remove ou policy`);
  }
}
