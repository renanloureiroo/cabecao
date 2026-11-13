// Onde a chave de API mora nesta máquina. Nunca no repositório, no cérebro, em arquivo que sincroniza, em log, em
// mensagem de erro ou na saída `--json`; nunca em argumento de processo (outro usuário da máquina veria na lista de
// processos): a gravação passa a chave pela ENTRADA PADRÃO do programa do sistema (no Windows, pelo ambiente só do
// processo do PowerShell, que não lê a entrada redirecionada de forma confiável).
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
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyRef, ProviderEntry } from '@cabecao/core';
import { entryDestination, writeFileAtomic } from '@cabecao/core';
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

/**
 * O ambiente do PowerShell no Windows: o do usuário inteiro (o `PSModulePath` e as pastas do perfil fazem falta para
 * carregar o módulo de segurança e a DPAPI), menos as variáveis de chave dos provedores, que ele não precisa ver.
 */
function windowsEnv(env: Env): Env {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || /(?:API_KEY|_TOKEN|SECRET)$/i.test(name)) continue;
    out[name] = value;
  }
  return out;
}

function powershell(env: Env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

// No Windows, o PowerShell chamado com a entrada redirecionada não lê o `[Console]::In` de forma confiável (no CI ficou
// parado até o tempo limite). A chave vai então numa variável de ambiente SÓ do processo do PowerShell, nunca na linha
// de comando: o ambiente de um processo não aparece na lista de processos e só o próprio usuário (ou um administrador)
// o lê, como a entrada padrão.
const DPAPI_INPUT = 'CABECAO_DPAPI_INPUT';
const PS_ENCRYPT = `ConvertTo-SecureString -String $env:${DPAPI_INPUT} -AsPlainText -Force | ConvertFrom-SecureString`;
const PS_DECRYPT = `$s = ConvertTo-SecureString -String $env:${DPAPI_INPUT}; [System.Net.NetworkCredential]::new('', $s).Password`;

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

/**
 * A conta da chave no cofre e no arquivo: o provedor E o destino (`anthropic@api.anthropic.com`). Uma chave gravada
 * para um endereço nunca é lida para outro, nem se alguém trocar o endereço do provedor.
 */
export function credentialAccount(id: string, entry: ProviderEntry): string {
  const destination = entryDestination(entry);
  let host = destination;
  try {
    host = new URL(destination).host;
  } catch {
    // agente (`agent:claude-code`): fica como está
  }
  return `${id}@${host}`;
}

/** A pasta das chaves não pode ser gravável por outros usuários (POSIX): alguém trocaria o arquivo. */
async function assertPrivateDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const info = await stat(dir);
    if ((info.mode & 0o022) !== 0) {
      throw new Error(
        `a pasta ${dir} pode ser alterada por outros usuários da máquina; corrija com "chmod go-w ${dir}" antes de guardar uma chave`,
      );
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
}

async function writeStore(path: string, store: StoreFile): Promise<void> {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
  await assertPrivateDir(dir);
  // um arquivo que já existia com permissão aberta é fechado ANTES de receber o conteúdo novo (a escrita atômica
  // mantém o modo do arquivo antigo)
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
  await writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
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
      stdin: '',
      env: { ...windowsEnv(io.env), [DPAPI_INPUT]: key },
      timeoutMs: RUN_TIMEOUT_MS * 2,
    });
    const encrypted = result.stdout.trim();
    if (result.code !== 0 || !/^[0-9a-f]+$/i.test(encrypted)) {
      const detail = result.stderr
        .replaceAll(key, '[chave omitida]')
        .trim()
        .split('\n')
        .slice(-2)
        .join(' ')
        .slice(0, 300);
      throw new Error(
        `o PowerShell não conseguiu cifrar a chave com a DPAPI (código ${result.code ?? 'nenhum'}${detail === '' ? '' : `: ${detail}`})`,
      );
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
      stdin: '',
      env: { ...windowsEnv(io.env), [DPAPI_INPUT]: encrypted },
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

/** Apaga no cofre do sistema. Devolve o problema, ou `null` se apagou (ou se não havia o que apagar). */
async function keychainDelete(io: CredentialIo, id: string): Promise<string | null> {
  const run = io.runner ?? systemRunner;
  const env = minimalEnv(io.env);
  if (io.platform === 'darwin') {
    const result = await run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id], {
      stdin: '',
      env,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    // 44: o item não existe
    return result.code === 0 || result.code === 44 ? null : `o Keychain não apagou (código ${result.code ?? 'nenhum'})`;
  }
  if (io.platform === 'win32') {
    const path = join(io.configDir, DPAPI_FILE);
    const store = await readStore(path);
    delete store.keys[id];
    if (Object.keys(store.keys).length === 0) await rm(path, { force: true });
    else await writeStore(path, store);
    return null;
  }
  const result = await run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', id], {
    stdin: '',
    env,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  // o secret-tool sai com 1 quando não havia o item
  return result.code === 0 || result.code === 1 ? null : `o secret-tool não apagou (código ${result.code ?? 'nenhum'})`;
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

/**
 * Apaga a chave guardada pelo Cabeção (no cofre e no arquivo). A variável de ambiente não é dele: fica. Devolve os
 * problemas (vazio: apagou tudo o que havia), para ninguém dizer "apagado" quando o cofre recusou.
 */
export async function deleteKey(io: CredentialIo, id: string): Promise<string[]> {
  const problems: string[] = [];
  if ((await keychainAvailable(io)).ok) {
    const problem = await keychainDelete(io, id).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    if (problem !== null) problems.push(problem);
  }
  const path = credentialsFilePath(io.configDir);
  try {
    const store = await readStore(path);
    if (id in store.keys) {
      delete store.keys[id];
      if (Object.keys(store.keys).length === 0) await rm(path, { force: true });
      else await writeStore(path, store);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}
