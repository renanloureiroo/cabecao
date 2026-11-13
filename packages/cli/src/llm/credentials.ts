// Onde a chave de API mora nesta máquina. Nunca no repositório, no cérebro, em arquivo que sincroniza, em log, em
// mensagem de erro ou na saída `--json`; nunca em argumento de processo (outro usuário da máquina veria na lista de
// processos): toda gravação passa a chave pela ENTRADA PADRÃO do programa do sistema.
//
// Ordem de leitura: a variável de ambiente do provedor; depois o lugar gravado no `llm.json`:
// - `keychain`: o cofre do sistema, por comando nativo, sem dependência nativa no pacote:
//   - macOS: `security` (Keychain), serviço `cabecao`, conta = nome do provedor; gravado por `security -i`, que lê o
//     comando da entrada padrão;
//   - Linux: `secret-tool` (libsecret/Secret Service), quando existe e responde; `store` lê a chave da entrada padrão;
//   - Windows: DPAPI pelo PowerShell (`ConvertFrom-SecureString` sem `-Key`: cifrado e preso ao seu usuário do
//     Windows), num arquivo `credentials.dpapi.json` na pasta de configuração;
// - `file`: `<configDir>/credentials.json` com permissão 0600 (o recuo do gh, do Codex e do Claude Code);
// - `env:NOME`: só a variável.
import { chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyRef } from '@cabecao/core';
import { writeFileAtomic } from '@cabecao/core';
import { findExecutable } from '../install-client/files.ts';
import type { Env } from '../types.ts';

export const KEYCHAIN_SERVICE = 'cabecao';
export const CREDENTIALS_FILE = 'credentials.json';
export const DPAPI_FILE = 'credentials.dpapi.json';

export interface RunnerResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Roda um programa do sistema sem shell, com a entrada padrão dada. Injetável: nenhum teste toca o cofre real. */
export type CredentialRunner = (
  file: string,
  args: readonly string[],
  options: { readonly stdin: string; readonly env: Env; readonly timeoutMs: number },
) => Promise<RunnerResult>;

export interface CredentialIo {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly configDir: string;
  readonly runner?: CredentialRunner;
}

const RUN_TIMEOUT_MS = 15_000;

const isErrno = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException | null)?.code === code;

/** Executor real: `spawn` sem shell, entrada padrão escrita e fechada, saída capturada. */
export const systemRunner: CredentialRunner = async (file, args, options) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: RunnerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(file, [...args], {
      env: { ...options.env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout, stderr: `${stderr}\nsem resposta em ${options.timeoutMs} ms` });
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => done({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(options.stdin);
  });
};

/** Texto de chave aceito: ASCII visível, sem aspas, barra invertida nem espaço, de 8 a 512 caracteres. */
export function keyProblem(key: string): string | null {
  if (key.length < 8) return 'a chave é curta demais (cole a chave inteira)';
  if (key.length > 512) return 'a chave é longa demais';
  if (!/^[A-Za-z0-9._~+/=:@-]+$/.test(key)) return 'a chave tem caracteres inesperados (espaço, aspas ou acento)';
  return null;
}

/** `••••a1b2`: só os 4 últimos caracteres, para conferir qual chave é. */
export function maskKey(key: string): string {
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}

function minimalEnv(env: Env): Env {
  const keep = [
    'PATH',
    'Path',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'SYSTEMROOT',
    'USER',
    'LOGNAME',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
  ];
  const out: Record<string, string> = {};
  for (const name of keep) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function powershell(env: Env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

// Uma linha da entrada padrão (com a quebra que o Cabeção manda): não depende de o PowerShell ver o fim da entrada.
const PS_ENCRYPT =
  '$k = [Console]::In.ReadLine().Trim(); ConvertTo-SecureString -String $k -AsPlainText -Force | ConvertFrom-SecureString';
const PS_DECRYPT =
  "$e = [Console]::In.ReadLine().Trim(); $s = ConvertTo-SecureString -String $e; [System.Net.NetworkCredential]::new('', $s).Password";

/** O cofre do sistema existe e responde nesta máquina? `reason` explica quando não. */
export async function keychainAvailable(io: CredentialIo): Promise<{ ok: boolean; reason: string; label: string }> {
  if (io.platform === 'darwin') {
    const found = await findExecutable('security', { env: { PATH: '/usr/bin' }, platform: 'darwin' });
    return found === undefined
      ? { ok: false, reason: 'o comando "security" do macOS não foi encontrado', label: 'Keychain do macOS' }
      : { ok: true, reason: '', label: 'Keychain do macOS' };
  }
  if (io.platform === 'win32') {
    return { ok: true, reason: '', label: 'DPAPI do Windows (arquivo cifrado com o seu usuário)' };
  }
  const found = await findExecutable('secret-tool', io);
  return found === undefined
    ? {
        ok: false,
        reason: 'o "secret-tool" (libsecret) não está instalado; sem ele, a chave vai para um arquivo protegido',
        label: 'Secret Service (secret-tool)',
      }
    : { ok: true, reason: '', label: 'Secret Service (secret-tool)' };
}

interface StoreFile {
  version: 1;
  keys: Record<string, string>;
}

async function readStore(path: string): Promise<StoreFile> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<StoreFile>;
    return { version: 1, keys: typeof value.keys === 'object' && value.keys !== null ? { ...value.keys } : {} };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { version: 1, keys: {} };
    throw new Error(`não consegui ler ${path} (arquivo de chaves corrompido?); apague-o e grave a chave de novo`);
  }
}

async function writeStore(path: string, store: StoreFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

async function keychainWrite(io: CredentialIo, id: string, key: string): Promise<void> {
  const run = io.runner ?? systemRunner;
  const env = minimalEnv(io.env);
  if (io.platform === 'darwin') {
    // `security -i` lê os comandos da entrada padrão: a chave não aparece na lista de processos
    const result = await run('/usr/bin/security', ['-i'], {
      stdin: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${id} -w ${key}\n`,
      env,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    if (result.code !== 0 || /error|SecKeychain/i.test(result.stderr)) {
      throw new Error(`o Keychain recusou a gravação (código ${result.code ?? 'nenhum'})`);
    }
    return;
  }
  if (io.platform === 'win32') {
    const result = await run(powershell(io.env), ['-NoProfile', '-NonInteractive', '-Command', PS_ENCRYPT], {
      stdin: `${key}\n`,
      env,
      timeoutMs: RUN_TIMEOUT_MS * 2,
    });
    const encrypted = result.stdout.trim();
    if (result.code !== 0 || !/^[0-9a-f]+$/i.test(encrypted)) {
      throw new Error(`o PowerShell não conseguiu cifrar a chave com a DPAPI (código ${result.code ?? 'nenhum'})`);
    }
    const path = join(io.configDir, DPAPI_FILE);
    const store = await readStore(path);
    store.keys[id] = encrypted;
    await writeStore(path, store);
    return;
  }
  const result = await run(
    'secret-tool',
    ['store', `--label=Cabeção (${id})`, 'service', KEYCHAIN_SERVICE, 'account', id],
    {
      stdin: key,
      env,
      timeoutMs: RUN_TIMEOUT_MS,
    },
  );
  if (result.code !== 0) throw new Error(`o secret-tool recusou a gravação (código ${result.code ?? 'nenhum'})`);
}

async function keychainRead(io: CredentialIo, id: string): Promise<string | null> {
  const run = io.runner ?? systemRunner;
  const env = minimalEnv(io.env);
  if (io.platform === 'darwin') {
    const result = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id, '-w'], {
      stdin: '',
      env,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const key = result.stdout.trim();
    return result.code === 0 && key !== '' ? key : null;
  }
  if (io.platform === 'win32') {
    const store = await readStore(join(io.configDir, DPAPI_FILE));
    const encrypted = store.keys[id];
    if (encrypted === undefined) return null;
    const result = await run(powershell(io.env), ['-NoProfile', '-NonInteractive', '-Command', PS_DECRYPT], {
      stdin: `${encrypted}\n`,
      env,
      timeoutMs: RUN_TIMEOUT_MS * 2,
    });
    const key = result.stdout.trim();
    return result.code === 0 && key !== '' ? key : null;
  }
  const result = await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', id], {
    stdin: '',
    env,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const key = result.stdout.trim();
  return result.code === 0 && key !== '' ? key : null;
}

async function keychainDelete(io: CredentialIo, id: string): Promise<void> {
  const run = io.runner ?? systemRunner;
  const env = minimalEnv(io.env);
  if (io.platform === 'darwin') {
    await run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id], {
      stdin: '',
      env,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    return;
  }
  if (io.platform === 'win32') {
    const path = join(io.configDir, DPAPI_FILE);
    const store = await readStore(path);
    delete store.keys[id];
    if (Object.keys(store.keys).length === 0) await rm(path, { force: true });
    else await writeStore(path, store);
    return;
  }
  await run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', id], {
    stdin: '',
    env,
    timeoutMs: RUN_TIMEOUT_MS,
  });
}

/**
 * Grava a chave. `keychain` tenta o cofre do sistema e CONFERE lendo de volta; se o cofre não existir ou falhar, cai
 * para o arquivo protegido e diz por quê. Devolve onde ficou.
 */
export async function storeKey(
  io: CredentialIo,
  id: string,
  key: string,
  where: 'keychain' | 'file',
): Promise<{ stored: 'keychain' | 'file'; note: string | null }> {
  const problem = keyProblem(key);
  if (problem !== null) throw new Error(problem);
  if (where === 'keychain') {
    const available = await keychainAvailable(io);
    if (available.ok) {
      try {
        await keychainWrite(io, id, key);
        if ((await keychainRead(io, id)) === key) return { stored: 'keychain', note: null };
        throw new Error('a chave gravada não pôde ser lida de volta');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await saveFileKey(io, id, key);
        return { stored: 'file', note: `${available.label}: ${reason}; a chave foi para o arquivo protegido` };
      }
    }
    await saveFileKey(io, id, key);
    return { stored: 'file', note: available.reason };
  }
  await saveFileKey(io, id, key);
  return { stored: 'file', note: null };
}

async function saveFileKey(io: CredentialIo, id: string, key: string): Promise<void> {
  const path = join(io.configDir, CREDENTIALS_FILE);
  const store = await readStore(path);
  store.keys[id] = key;
  await writeStore(path, store);
}

export function credentialsFilePath(configDir: string): string {
  return join(configDir, CREDENTIALS_FILE);
}

/** Onde a chave está, em português, sem a chave. */
export function describeKeyRef(
  ref: KeyRef,
  envKey: string | null,
  platform: NodeJS.Platform,
  configDir: string,
): string {
  if (ref === 'none') return 'sem chave';
  if (ref.startsWith('env:')) return `variável de ambiente ${ref.slice(4)}`;
  const env = envKey === null ? '' : ` (a variável ${envKey}, se definida, vale antes)`;
  if (ref === 'file') return `arquivo protegido ${credentialsFilePath(configDir)}${env}`;
  const vault =
    platform === 'darwin'
      ? 'Keychain do macOS'
      : platform === 'win32'
        ? `DPAPI do Windows (${join(configDir, DPAPI_FILE)})`
        : 'Secret Service (secret-tool)';
  return `${vault}${env}`;
}

/** Lê a chave: a variável do provedor primeiro, depois o lugar gravado. `missing` diz onde ela deveria estar. */
export async function readKey(
  io: CredentialIo,
  id: string,
  ref: KeyRef,
  envKey: string | null,
): Promise<{ key: string | null; missing: string; source: string | null }> {
  if (ref === 'none') return { key: null, missing: '', source: null };
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const value = io.env[name]?.trim();
    return value !== undefined && value !== ''
      ? { key: value, missing: '', source: `variável ${name}` }
      : {
          key: null,
          missing: `a variável ${name} não está definida neste processo (um servidor MCP iniciado pelo cliente pode não herdar as variáveis do seu terminal; rode "cabecao llm on" e guarde a chave no cofre)`,
          source: null,
        };
  }
  if (envKey !== null) {
    const value = io.env[envKey]?.trim();
    if (value !== undefined && value !== '') return { key: value, missing: '', source: `variável ${envKey}` };
  }
  try {
    if (ref === 'keychain') {
      const key = await keychainRead(io, id);
      if (key !== null) return { key, missing: '', source: 'cofre do sistema' };
      return {
        key: null,
        missing: 'a chave não está no cofre do sistema; rode "cabecao llm on" para gravá-la de novo',
        source: null,
      };
    }
    const store = await readStore(credentialsFilePath(io.configDir));
    const key = store.keys[id];
    if (key !== undefined && key !== '') return { key, missing: '', source: 'arquivo protegido' };
    return {
      key: null,
      missing: `a chave não está em ${credentialsFilePath(io.configDir)}; rode "cabecao llm on"`,
      source: null,
    };
  } catch (error) {
    return { key: null, missing: error instanceof Error ? error.message : String(error), source: null };
  }
}

/** Apaga a chave guardada pelo Cabeção (no cofre e no arquivo). A variável de ambiente não é dele: fica. */
export async function deleteKey(io: CredentialIo, id: string): Promise<void> {
  if ((await keychainAvailable(io)).ok) await keychainDelete(io, id).catch(() => {});
  const path = credentialsFilePath(io.configDir);
  const store = await readStore(path).catch(() => ({ version: 1 as const, keys: {} as Record<string, string> }));
  if (id in store.keys) {
    delete store.keys[id];
    if (Object.keys(store.keys).length === 0) await rm(path, { force: true });
    else await writeStore(path, store);
  }
}
