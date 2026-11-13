/**
 * Runtime opcional de embeddings, instalado sob demanda (ADR 09) em `<cache>/runtime`:
 * `package.json` + `loader.mjs` + `npm install` com versões fixadas, e carga por `import(pathToFileURL(loader))`.
 * Nada disso entra no pacote `cabecao`; este arquivo só sabe instalar, provar, descrever e remover.
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cacheDir as defaultCacheDir, withLock, writeFileAtomic } from '@cabecao/core';
import {
  EmbeddingsError,
  NpmNotFoundError,
  RuntimeInstallError,
  RuntimeNotInstalledError,
  RuntimeUnavailableError,
} from './errors.ts';
import type { TokenizerLike } from './inference.ts';
import { type FindNpmContext, findNpm, type NpmCommand, type NpmRunner, npmChildEnv, spawnNpm } from './npm.ts';
import { childProcessProbe, type RuntimeProbe } from './probe.ts';

/** Pasta, dentro do diretório de cache do usuário, onde o runtime é instalado. */
export const RUNTIME_DIR_NAME = 'runtime';
export const LOADER_FILE = 'loader.mjs';
export const MANIFEST_FILE = 'cabecao-runtime.json';
const LOCK_FILE = 'runtime.lock';
/** Muda quando o formato do `loader.mjs` ou do manifesto muda: força reinstalar. */
const MANIFEST_FORMAT = 1;

export type RuntimeBackend = 'native' | 'wasm';

/**
 * Versões fixadas. As do nativo são as que o `@huggingface/transformers` 4.3.2 instalou nas 15 combinações de
 * sistema e Node do spike 14 (`onnxruntime-node` 1.30.0, `@huggingface/tokenizers` 0.2.0); o transformers.js em si
 * fica de fora (470 MB, e a sessão ONNX direta dá os mesmos vetores: spike 11, seção 9). As do WebAssembly são as do
 * caminho que funcionou nas 15 combinações e no Alpine.
 */
export const RUNTIME_PACKAGES: Readonly<Record<RuntimeBackend, Readonly<Record<string, string>>>> = {
  native: { 'onnxruntime-node': '1.30.0', '@huggingface/tokenizers': '0.2.0' },
  wasm: { 'onnxruntime-web': '1.31.1', '@huggingface/tokenizers': '0.2.0' },
};

/** Só estes arquivos do `onnxruntime-web/dist` são usados no Node (14,5 MB dos 151 MB; spike 14, seção 3). */
const WASM_DIST_KEEP = ['ort.node.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

export function runtimeDir(cacheDir: string): string {
  return join(cacheDir, RUNTIME_DIR_NAME);
}

/** Fonte do `loader.mjs`: o único ponto de contato entre o Cabeção e os pacotes instalados. */
export function loaderSource(backend: RuntimeBackend): string {
  const ortImport =
    backend === 'native' ? "import ort from 'onnxruntime-node';" : "import * as ort from 'onnxruntime-web';";
  return [
    '// Gerado pelo Cabeção. Não edite: é refeito a cada `cabecao embeddings on`.',
    ortImport,
    "import { Tokenizer } from '@huggingface/tokenizers';",
    `export const backend = '${backend}';`,
    'export { ort, Tokenizer };',
    '',
  ].join('\n');
}

// ---- tipos mínimos do que o loader exporta (sem depender dos pacotes)

export interface OrtTensor {
  data: unknown;
  dims: readonly number[];
  dispose?(): void;
}

export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

export interface OrtModule {
  InferenceSession: { create(model: string | Uint8Array, options?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => OrtTensor;
  env?: { wasm?: { numThreads?: number } };
}

/** O que o `loader.mjs` exporta. */
export interface RuntimeModule {
  backend: RuntimeBackend;
  ort: OrtModule;
  Tokenizer: new (tokenizerJson: object, tokenizerConfig: object) => TokenizerLike;
}

// ---- manifesto e estado

interface RuntimeManifest {
  format: number;
  backend: RuntimeBackend;
  packages: Record<string, string>;
  platform: string;
  arch: string;
  node: string;
  installedAt: string;
  nativeError?: string;
}

export interface RuntimeStatus {
  dir: string;
  installed: boolean;
  backend?: RuntimeBackend;
  /** Versões instaladas. */
  packages?: Record<string, string>;
  /** Instalado com as versões fixadas por esta versão do Cabeção e para este sistema. */
  upToDate: boolean;
  installedAt?: string;
  /** Por que o nativo foi descartado, quando o runtime é o WebAssembly. */
  nativeError?: string;
  /** O que impede de considerar instalado, quando há algo na pasta. */
  problem?: string;
  /** Tamanho da pasta, só com `measure: true`. */
  sizeBytes?: number;
}

async function readManifest(dir: string): Promise<RuntimeManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const m = value as Partial<RuntimeManifest>;
    if (m.backend !== 'native' && m.backend !== 'wasm') return null;
    if (typeof m.packages !== 'object' || m.packages === null) return null;
    return m as RuntimeManifest;
  } catch {
    return null;
  }
}

async function installedVersion(dir: string, name: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export interface RuntimeStatusOptions {
  cacheDir?: string;
  /** Soma o tamanho da pasta (percorre milhares de arquivos). */
  measure?: boolean;
}

/** Estado do runtime no disco. Não usa a rede nem carrega nada. */
export async function runtimeStatus(options: RuntimeStatusOptions = {}): Promise<RuntimeStatus> {
  const dir = runtimeDir(options.cacheDir ?? defaultCacheDir());
  const status = await computeStatus(dir);
  if (options.measure) status.sizeBytes = await dirSize(dir);
  return status;
}

async function computeStatus(dir: string): Promise<RuntimeStatus> {
  const manifest = await readManifest(dir);
  if (!manifest) {
    const leftovers = await exists(join(dir, 'node_modules'));
    return {
      dir,
      installed: false,
      upToDate: false,
      ...(leftovers ? { problem: 'instalação incompleta (sem manifesto)' } : {}),
    };
  }
  if (manifest.format !== MANIFEST_FORMAT) {
    return { dir, installed: false, upToDate: false, problem: `manifesto no formato ${manifest.format}` };
  }
  if (!(await exists(join(dir, LOADER_FILE)))) {
    return { dir, installed: false, upToDate: false, problem: `falta o ${LOADER_FILE}` };
  }
  for (const [name, version] of Object.entries(manifest.packages)) {
    const found = await installedVersion(dir, name);
    if (found !== version) {
      return { dir, installed: false, upToDate: false, problem: `${name} ${found ?? 'ausente'} (esperado ${version})` };
    }
  }
  const pinned = RUNTIME_PACKAGES[manifest.backend];
  const samePackages =
    Object.keys(pinned).length === Object.keys(manifest.packages).length &&
    Object.entries(pinned).every(([name, version]) => manifest.packages[name] === version);
  const sameMachine = manifest.platform === process.platform && manifest.arch === process.arch;
  return {
    dir,
    installed: true,
    backend: manifest.backend,
    packages: manifest.packages,
    upToDate: samePackages && sameMachine,
    installedAt: manifest.installedAt,
    ...(manifest.nativeError ? { nativeError: manifest.nativeError } : {}),
  };
}

// ---- instalação

export type InstallProgress =
  | { phase: 'npm'; backend: RuntimeBackend; message: string }
  | { phase: 'probe'; backend: RuntimeBackend; message: string }
  | { phase: 'fallback'; backend: RuntimeBackend; message: string; reason: string }
  | { phase: 'done'; backend: RuntimeBackend; message: string };

export interface InstallRuntimeOptions {
  cacheDir?: string;
  /** `auto` (padrão): nativo e, se não carregar, WebAssembly. */
  backend?: 'auto' | RuntimeBackend;
  /** Reinstala mesmo se já estiver instalado e atualizado. */
  force?: boolean;
  onProgress?: (event: InstallProgress) => void;
  /** Executor do npm (padrão: `spawn` sem shell). */
  runNpm?: NpmRunner;
  /** Comando do npm já resolvido; sem ele, `findNpm`. */
  npm?: NpmCommand;
  findNpmContext?: FindNpmContext;
  /** Prova de carga (padrão: processo filho com um modelo ONNX mínimo). */
  probe?: RuntimeProbe;
  /** Remove binários de outras plataformas e arquivos não usados pelo Node (padrão: `true`). */
  prune?: boolean;
  npmTimeoutMs?: number;
  /** Quanto esperar por outra instalação em andamento (padrão: 15 min). */
  lockTimeoutMs?: number;
}

export interface InstallRuntimeResult extends RuntimeStatus {
  /** Já estava instalado e atualizado: nada foi feito. */
  alreadyInstalled: boolean;
  npmVia?: NpmCommand['via'];
  durationMs: number;
}

const NPM_INSTALL_FLAGS = [
  'install',
  '--no-audit',
  '--no-fund',
  '--no-package-lock',
  // Os binários de CPU já vêm nos pacotes; os scripts só baixariam extras (CUDA). O npm 11.19+ já os bloqueia por
  // padrão (spike 14); fixar a opção deixa o resultado igual em todas as versões do npm.
  '--ignore-scripts',
  '--loglevel=error',
];

/**
 * Instala o runtime. Idempotente: com o runtime já instalado, atualizado e compatível com o `backend` pedido, não
 * faz nada. Trava entre processos (`<cache>/runtime.lock`). Depois do `npm install`, prova a carga num processo
 * filho; se o nativo não carregar (Alpine/musl), apaga o que instalou e tenta o WebAssembly. Se nenhum carregar,
 * não deixa nada no disco e lança `RuntimeUnavailableError`.
 */
export async function installRuntime(options: InstallRuntimeOptions = {}): Promise<InstallRuntimeResult> {
  const cache = options.cacheDir ?? defaultCacheDir();
  const dir = runtimeDir(cache);
  const requested = options.backend ?? 'auto';
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  return withLock(
    join(cache, LOCK_FILE),
    async () => {
      const before = await computeStatus(dir);
      if (
        !options.force &&
        before.installed &&
        before.upToDate &&
        (requested === 'auto' || requested === before.backend)
      ) {
        return { ...before, alreadyInstalled: true, durationMs: elapsed() };
      }

      let npm = options.npm;
      if (!npm) {
        const found = findNpm(options.findNpmContext);
        if (!found.npm) throw new NpmNotFoundError(found.tried);
        npm = found.npm;
      }
      const runNpm = options.runNpm ?? spawnNpm;
      const probe = options.probe ?? childProcessProbe;
      const candidates: RuntimeBackend[] = requested === 'auto' ? ['native', 'wasm'] : [requested];
      const reasons: Record<string, string> = {};

      // Qualquer instalação anterior deixa de valer até a nova ser provada.
      await rm(join(dir, MANIFEST_FILE), { force: true });

      for (const backend of candidates) {
        const previous = await readPackageJsonDeps(dir);
        if (previous && !sameDeps(previous, RUNTIME_PACKAGES[backend])) await removeNodeModules(dir);
        await writeRuntimeFiles(dir, backend);

        options.onProgress?.({ phase: 'npm', backend, message: `instalando ${describePackages(backend)}` });
        const result = await runNpm({
          command: npm.command,
          args: [...npm.prefix, ...NPM_INSTALL_FLAGS],
          cwd: dir,
          env: npmChildEnv(process.env),
          timeoutMs: options.npmTimeoutMs ?? 15 * 60_000,
        });
        if (result.code !== 0) {
          await removeNodeModules(dir);
          throw new RuntimeInstallError(
            `npm install do runtime de embeddings falhou (via ${npm.via}, código ${result.code ?? 'nenhum'})` +
              `${looksOffline(result.output) ? '; parece não haver rede' : ''}: ${tail(result.output)}`,
            result.code,
            result.output,
          );
        }
        if (options.prune ?? true) await pruneRuntime(dir, backend);

        options.onProgress?.({ phase: 'probe', backend, message: 'testando a carga do runtime' });
        const probed = await probe(join(dir, LOADER_FILE));
        if (probed.ok) {
          const manifest: RuntimeManifest = {
            format: MANIFEST_FORMAT,
            backend,
            packages: { ...RUNTIME_PACKAGES[backend] },
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            installedAt: new Date().toISOString(),
            ...(reasons.native ? { nativeError: reasons.native } : {}),
          };
          await writeFileAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
          options.onProgress?.({ phase: 'done', backend, message: `runtime ${backend} pronto` });
          const after = await computeStatus(dir);
          return { ...after, alreadyInstalled: false, npmVia: npm.via, durationMs: elapsed() };
        }

        reasons[backend] = probed.error ?? 'falhou';
        // Não deixa centenas de MB inúteis no disco.
        await removeNodeModules(dir);
        const next = candidates[candidates.indexOf(backend) + 1];
        if (next) {
          options.onProgress?.({
            phase: 'fallback',
            backend: next,
            reason: reasons[backend],
            message: `o runtime ${backend} não carregou nesta máquina; tentando ${next} (de 3 a 10 vezes mais lento)`,
          });
        }
      }

      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      throw new RuntimeUnavailableError(reasons);
    },
    { timeoutMs: options.lockTimeoutMs ?? 15 * 60_000 },
  );
}

async function writeRuntimeFiles(dir: string, backend: RuntimeBackend): Promise<void> {
  const pkg = {
    name: 'cabecao-embeddings-runtime',
    private: true,
    type: 'module',
    description: 'Runtime opcional de embeddings do Cabeção. Gerado; apague com `cabecao embeddings off`.',
    dependencies: { ...RUNTIME_PACKAGES[backend] },
  };
  await writeFileAtomic(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFileAtomic(join(dir, LOADER_FILE), loaderSource(backend));
}

async function readPackageJsonDeps(dir: string): Promise<Record<string, string> | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies?: unknown };
    return typeof pkg.dependencies === 'object' && pkg.dependencies !== null
      ? (pkg.dependencies as Record<string, string>)
      : {};
  } catch {
    return null;
  }
}

function sameDeps(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

async function removeNodeModules(dir: string): Promise<void> {
  await rm(join(dir, 'node_modules'), { recursive: true, force: true, maxRetries: 3 });
}

function describePackages(backend: RuntimeBackend): string {
  return Object.entries(RUNTIME_PACKAGES[backend])
    .map(([name, version]) => `${name}@${version}`)
    .join(' + ');
}

function looksOffline(output: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network/i.test(output);
}

function tail(output: string): string {
  const text = output.trim();
  return text.length > 800 ? `…${text.slice(-800)}` : text || 'sem saída';
}

/**
 * Tira o que o Node desta máquina nunca vai carregar: no nativo, os binários das outras plataformas (o pacote traz
 * as cinco); no WebAssembly, as variantes de navegador. A prova de carga roda depois e confirma que nada útil saiu.
 */
export async function pruneRuntime(dir: string, backend: RuntimeBackend): Promise<void> {
  if (backend === 'native') {
    const base = join(dir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    if (!(await exists(join(base, process.platform, process.arch)))) return;
    for (const platform of await readdir(base)) {
      if (platform !== process.platform) {
        await rm(join(base, platform), { recursive: true, force: true });
        continue;
      }
      for (const arch of await readdir(join(base, platform))) {
        if (arch !== process.arch) await rm(join(base, platform, arch), { recursive: true, force: true });
      }
    }
    return;
  }
  const dist = join(dir, 'node_modules', 'onnxruntime-web', 'dist');
  const present = await Promise.all(WASM_DIST_KEEP.map((name) => exists(join(dist, name))));
  if (!present.every(Boolean)) return;
  for (const name of await readdir(dist)) {
    if (!WASM_DIST_KEEP.includes(name)) await rm(join(dist, name), { recursive: true, force: true });
  }
}

// ---- remoção

export interface UninstallRuntimeOptions {
  cacheDir?: string;
  /** Apaga também os modelos baixados (`<cache>/models`). */
  includeModels?: boolean;
  lockTimeoutMs?: number;
}

export interface UninstallRuntimeResult {
  removed: boolean;
  freedBytes: number;
}

/**
 * Apaga o runtime (e, se pedido, os modelos). No Windows, falha se algum processo (o servidor MCP) estiver com o
 * binário carregado; a mensagem diz isso.
 */
export async function uninstallRuntime(options: UninstallRuntimeOptions = {}): Promise<UninstallRuntimeResult> {
  const cache = options.cacheDir ?? defaultCacheDir();
  const targets = [runtimeDir(cache), ...(options.includeModels ? [join(cache, 'models')] : [])];
  return withLock(
    join(cache, LOCK_FILE),
    async () => {
      let freedBytes = 0;
      let removed = false;
      for (const target of targets) {
        if (!(await exists(target))) continue;
        freedBytes += await dirSize(target);
        try {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          throw new EmbeddingsError(
            'EMBEDDINGS_RUNTIME_BUSY',
            `não consegui apagar ${target}: feche os processos que usam a busca por significado (servidor MCP) e tente de novo`,
            { cause: error },
          );
        }
        removed = true;
      }
      return { removed, freedBytes };
    },
    { timeoutMs: options.lockTimeoutMs ?? 15 * 60_000 },
  );
}

// ---- carga

/**
 * Importa o `loader.mjs`. Injetável nos testes. `version` identifica a instalação (o `installedAt` do manifesto).
 */
export type RuntimeImporter = (loaderPath: string, version: string) => Promise<RuntimeModule>;

/**
 * O Node guarda cada módulo pela URL: sem a versão na URL, um processo que trocou de runtime (nativo → WebAssembly,
 * ou reinstalou) continuaria recebendo o `loader.mjs` antigo. O teste real pegou isso.
 */
export const importLoader: RuntimeImporter = async (loaderPath, version) =>
  (await import(
    /* @vite-ignore */ `${pathToFileURL(loaderPath).href}?v=${encodeURIComponent(version)}`
  )) as RuntimeModule;

/** Carrega o runtime instalado. Sem instalação, `RuntimeNotInstalledError`. */
export async function loadRuntime(
  options: { cacheDir?: string; importRuntime?: RuntimeImporter } = {},
): Promise<RuntimeModule> {
  const dir = runtimeDir(options.cacheDir ?? defaultCacheDir());
  const status = await computeStatus(dir);
  if (!status.installed) throw new RuntimeNotInstalledError(dir, status.problem);
  try {
    const version = `${status.backend}-${status.installedAt ?? ''}`;
    const runtime = await (options.importRuntime ?? importLoader)(join(dir, LOADER_FILE), version);
    if (!runtime?.ort?.InferenceSession || typeof runtime.Tokenizer !== 'function') {
      throw new Error(`o ${LOADER_FILE} não exporta ort e Tokenizer`);
    }
    return runtime;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new RuntimeUnavailableError({ [status.backend ?? 'runtime']: `${reason}; rode \`cabecao embeddings on\`` });
  }
}

// ---- utilidades de disco

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Soma o tamanho dos arquivos de uma pasta (sem seguir links). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile())
        total += await lstat(path).then(
          (s) => s.size,
          () => 0,
        );
    }
  }
  return total;
}
