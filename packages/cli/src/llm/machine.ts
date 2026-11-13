// Os provedores de geração DESTA máquina: lê o `llm.json`, monta os provedores (HTTP do núcleo, Claude Code daqui),
// detecta o que já existe (agente instalado, variável de chave conhecida) e liga o proxy do ambiente para o `fetch`.
// Carregado só pelos comandos `ask` e `llm`, pelo `status`/`doctor` (resumo) e pelo servidor MCP quando há provedor.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerationProvider, ProviderEntry } from '@cabecao/core';
import {
  activeProviderIds,
  createHttpProvider,
  HTTP_PRESET_IDS,
  HTTP_PRESETS,
  isLocalUrl,
  ProviderError,
} from '@cabecao/core';
import type { Env } from '../types.ts';
import { createClaudeCodeProvider, locateClaude } from './claude-code.ts';
import type { CredentialRunner } from './credentials.ts';
import { credentialAccount, readKey } from './credentials.ts';

import type { LlmIo, LlmMachine } from './describe.ts';

export type { LlmIo, LlmMachine } from './describe.ts';
export { describeEntry, loadLlmMachine } from './describe.ts';

let proxyEnabled: string | null | undefined;

/** Destinos que NUNCA passam por proxy: um servidor nesta máquina não pode virar túnel para fora. */
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * O `fetch` do Node só passa pelo proxy de `HTTPS_PROXY` quando isso é ligado (Node ≥ 24 com `NODE_USE_ENV_PROXY=1`,
 * ou `http.setGlobalProxyFromEnv()` onde existe). Liga uma vez por processo quando há proxy no ambiente, SEMPRE com os
 * endereços desta máquina em `NO_PROXY` (um Ollama em localhost nunca vai por túnel ao proxy, em texto puro); devolve o
 * que foi feito, para o `llm status`.
 */
export async function enableProxyFromEnv(env: Env): Promise<string | null> {
  if (proxyEnabled !== undefined) return proxyEnabled;
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (proxy === undefined || proxy === '') {
    proxyEnabled = null;
    return null;
  }
  const noProxy = [env.no_proxy ?? env.NO_PROXY ?? '', ...LOOPBACK_NO_PROXY].filter((item) => item !== '').join(',');
  const http = (await import('node:http')) as {
    setGlobalProxyFromEnv?: (env?: Record<string, string | undefined>) => unknown;
  };
  if (typeof http.setGlobalProxyFromEnv === 'function') {
    http.setGlobalProxyFromEnv({ ...env, NO_PROXY: noProxy, no_proxy: noProxy });
    proxyEnabled = 'proxy do ambiente (HTTPS_PROXY; endereços desta máquina sempre sem proxy)';
  } else if (env.NODE_USE_ENV_PROXY === '1') {
    proxyEnabled = 'proxy do ambiente (NODE_USE_ENV_PROXY=1; inclua localhost em NO_PROXY se usar um servidor local)';
  } else {
    proxyEnabled = `HTTPS_PROXY definido, mas este Node (${process.versions.node}) não deixa o fetch usar proxy: atualize para o Node 24 e defina NODE_USE_ENV_PROXY=1`;
  }
  return proxyEnabled;
}

/**
 * O proxy do ambiente pode pegar um servidor desta máquina? Só quando quem ligou o proxy foi o próprio Node
 * (`NODE_USE_ENV_PROXY=1`, sem `setGlobalProxyFromEnv` para pôr os endereços locais em `NO_PROXY`) e o `NO_PROXY` do
 * ambiente não cobre `localhost` e `127.0.0.1`.
 */
export function loopbackMayBeProxied(env: Env, enabled: string | null | undefined): boolean {
  if (enabled === null || enabled === undefined || !enabled.includes('NODE_USE_ENV_PROXY')) return false;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
  if (noProxy.includes('*')) return false;
  return !(noProxy.includes('localhost') && noProxy.includes('127.0.0.1'));
}

const refuseProxiedLoopback = async (): Promise<Response> => {
  throw new ProviderError(
    'network',
    'o proxy do ambiente levaria o pedido a este servidor local para fora da máquina: inclua localhost,127.0.0.1 em NO_PROXY',
  );
};

export interface BuildOptions {
  readonly credentialRunner?: CredentialRunner;
  /** Troca o Claude Code de verdade por um falso (testes). */
  readonly claudeRun?: Parameters<typeof createClaudeCodeProvider>[0]['run'];
  readonly claudeLocate?: () => Promise<string | undefined>;
  readonly fetch?: Parameters<typeof createHttpProvider>[0]['fetch'];
}

export function buildProvider(
  io: LlmIo,
  machine: LlmMachine,
  id: string,
  entry: ProviderEntry,
  options: BuildOptions = {},
): GenerationProvider {
  if (entry.kind === 'agent') {
    return createClaudeCodeProvider({
      id,
      model: entry.model,
      env: io.env,
      platform: io.platform,
      // o executável confirmado; e, para um agente, sem nada do ambiente dele que mude destino ou configuração
      ...(entry.binary === undefined ? {} : { binary: entry.binary }),
      restricted: io.actor?.actor !== 'human',
      ...(options.claudeRun === undefined ? {} : { run: options.claudeRun }),
      ...(options.claudeLocate === undefined ? {} : { locate: options.claudeLocate }),
    });
  }
  const preset = HTTP_PRESETS[entry.preset];
  const runner = options.credentialRunner ?? io.credentialRunner;
  return createHttpProvider({
    id,
    preset,
    model: entry.model,
    ...(entry.base_url === undefined ? {} : { baseUrl: entry.base_url }),
    requireKey: entry.key !== 'none',
    resolveKey: () =>
      readKey(
        {
          env: io.env,
          platform: io.platform,
          configDir: machine.configDir,
          ...(runner === undefined ? {} : { runner }),
        },
        credentialAccount(id, entry),
        entry.key,
        preset.envKey,
      ),
    ...(options.fetch !== undefined
      ? { fetch: options.fetch }
      : isLocalUrl(entry.base_url ?? preset.baseUrl ?? '') && loopbackMayBeProxied(io.env, proxyEnabled)
        ? { fetch: refuseProxiedLoopback }
        : {}),
  });
}

/** Os provedores ativos, na ordem de recuo. Liga o proxy se houver provedor HTTP. */
export async function activeProviders(
  io: LlmIo,
  machine: LlmMachine,
  options: BuildOptions = {},
): Promise<GenerationProvider[]> {
  const config = machine.config;
  if (config === null) return [];
  // só os confirmados pelo usuário nesta máquina (assinatura local válida)
  const ids = activeProviderIds(config, machine.secret);
  if (ids.some((id) => config.providers[id]?.kind === 'http')) await enableProxyFromEnv(io.env);
  return ids.map((id) => buildProvider(io, machine, id, config.providers[id] as ProviderEntry, options));
}

export interface Detected {
  /** Claude Code no PATH. */
  readonly claude: { readonly path: string | null; readonly problem: string | null };
  /** Variáveis de chave conhecidas definidas neste ambiente (só o nome; a chave não é lida aqui). */
  readonly envKeys: readonly { readonly preset: (typeof HTTP_PRESET_IDS)[number]; readonly env: string }[];
}

/** O que já existe nesta máquina, para oferecer primeiro no `llm on` (e no `ask` sem provedor). */
export async function detectLlm(io: LlmIo): Promise<Detected> {
  const claude = await locateClaude(io.env, io.platform);
  const envKeys = HTTP_PRESET_IDS.flatMap((preset) => {
    const env = HTTP_PRESETS[preset].envKey;
    return env !== null && (io.env[env] ?? '') !== '' ? [{ preset, env }] : [];
  });
  return { claude, envKeys };
}

/** Uma linha por pergunta em `<pasta do llm.json>/ask.log` (sem trechos do cérebro e sem chave). Rotaciona em 1 MiB. */
export async function appendAskLog(cache: string, entry: Record<string, unknown>): Promise<void> {
  if (cache === '') return;
  try {
    await mkdir(cache, { recursive: true });
    const path = join(cache, 'ask.log');
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    if (size > 1024 * 1024) await rename(path, `${path}.1`).catch(() => {});
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // o log é ajuda para diagnóstico; nunca derruba a pergunta
  }
}
