import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installRuntime,
  loadRuntime,
  NpmNotFoundError,
  RUNTIME_PACKAGES,
  RuntimeInstallError,
  RuntimeNotInstalledError,
  RuntimeUnavailableError,
  runtimeDir,
  runtimeStatus,
  uninstallRuntime,
} from '../src/index.ts';
import { childProcessProbe, firstErrorLine, identityModel, type RuntimeProbe } from '../src/probe.ts';
import type { InstallProgress } from '../src/runtime.ts';
import { loaderSource } from '../src/runtime.ts';
import { FAKE_NPM_COMMAND, fakeNpm, MUSL_ERROR, tempDir } from './helpers.ts';

let cacheDir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: cacheDir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const okProbe: RuntimeProbe = async () => ({ ok: true, ms: 1 });

describe('versões fixadas e loader', () => {
  it('fixa as versões validadas no spike 14', () => {
    expect(RUNTIME_PACKAGES.native).toEqual({ 'onnxruntime-node': '1.30.0', '@huggingface/tokenizers': '0.2.0' });
    expect(RUNTIME_PACKAGES.wasm).toEqual({ 'onnxruntime-web': '1.31.1', '@huggingface/tokenizers': '0.2.0' });
  });

  it('o loader exporta ort, Tokenizer e o backend', () => {
    expect(loaderSource('native')).toContain("import ort from 'onnxruntime-node';");
    expect(loaderSource('wasm')).toContain("import * as ort from 'onnxruntime-web';");
    expect(loaderSource('wasm')).toContain("export const backend = 'wasm';");
  });

  it('o modelo ONNX mínimo da prova tem os 67 bytes do Identity', () => {
    expect(Buffer.from(identityModel()).toString('base64')).toBe(
      'CAhCAhANOjsKEAoBeBIBeSIISWRlbnRpdHkSBXByb2JlWg8KAXgSCgoICAESBAoCCAFiDwoBeRIKCggIARIECgIIAQ==',
    );
  });
});

describe('installRuntime', () => {
  it('grava package.json e loader.mjs, roda o npm sem shell e prova a carga', async () => {
    const npm = fakeNpm();
    const events: InstallProgress[] = [];
    const result = await installRuntime({
      cacheDir,
      npm: FAKE_NPM_COMMAND,
      runNpm: npm.run,
      probe: okProbe,
      onProgress: (event) => events.push(event),
    });
    expect(result).toMatchObject({ installed: true, upToDate: true, backend: 'native', alreadyInstalled: false });
    expect(npm.calls).toHaveLength(1);
    const call = npm.calls[0];
    expect(call?.command).toBe(process.execPath);
    expect(call?.args.slice(0, 2)).toEqual(['/fake/npm-cli.js', 'install']);
    expect(call?.args).toContain('--ignore-scripts');
    expect(call?.args).toContain('--no-package-lock');
    expect(call?.cwd).toBe(runtimeDir(cacheDir));
    const pkg = JSON.parse(await readFile(join(runtimeDir(cacheDir), 'package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual(RUNTIME_PACKAGES.native);
    expect(events.map((e) => e.phase)).toEqual(['npm', 'probe', 'done']);
  });

  it('é idempotente: a segunda chamada não roda o npm', async () => {
    const npm = fakeNpm();
    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: npm.run, probe: okProbe });
    const again = await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: npm.run, probe: okProbe });
    expect(again.alreadyInstalled).toBe(true);
    expect(npm.calls).toHaveLength(1);
    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: npm.run, probe: okProbe, force: true });
    expect(npm.calls).toHaveLength(2);
  });

  it('dois processos instalando ao mesmo tempo: a trava faz o npm rodar uma vez só', async () => {
    const npm = fakeNpm({ delayMs: 150 });
    const options = { cacheDir, npm: FAKE_NPM_COMMAND, runNpm: npm.run, probe: okProbe };
    const [a, b] = await Promise.all([installRuntime(options), installRuntime(options)]);
    expect(npm.calls).toHaveLength(1);
    expect([a.alreadyInstalled, b.alreadyInstalled].sort()).toEqual([false, true]);
  });

  it('se o nativo não carrega (Alpine), apaga o que instalou e cai para o WebAssembly', async () => {
    const npm = fakeNpm();
    const events: InstallProgress[] = [];
    const probe: RuntimeProbe = async (loader) => {
      const source = await readFile(loader, 'utf8');
      return source.includes('onnxruntime-node') ? { ok: false, error: MUSL_ERROR, ms: 1 } : { ok: true, ms: 1 };
    };
    const result = await installRuntime({
      cacheDir,
      npm: FAKE_NPM_COMMAND,
      runNpm: npm.run,
      probe,
      onProgress: (e) => events.push(e),
    });
    expect(result).toMatchObject({ installed: true, backend: 'wasm', nativeError: MUSL_ERROR });
    expect(npm.calls).toHaveLength(2);
    expect(existsSync(join(runtimeDir(cacheDir), 'node_modules', 'onnxruntime-node'))).toBe(false);
    expect(events.find((e) => e.phase === 'fallback')).toMatchObject({ backend: 'wasm', reason: MUSL_ERROR });
    // Uma nova chamada "auto" não insiste no nativo.
    expect((await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: npm.run, probe })).alreadyInstalled).toBe(
      true,
    );
  });

  it('se nada carrega, não deixa nada no disco e explica', async () => {
    const npm = fakeNpm();
    const error = await installRuntime({
      cacheDir,
      npm: FAKE_NPM_COMMAND,
      runNpm: npm.run,
      probe: async () => ({ ok: false, error: 'quebrado', ms: 1 }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeUnavailableError);
    expect((error as RuntimeUnavailableError).reasons).toEqual({ native: 'quebrado', wasm: 'quebrado' });
    expect((error as Error).message).toContain('palavra-chave continua funcionando');
    expect(existsSync(runtimeDir(cacheDir))).toBe(false);
  });

  it('backend forçado: só wasm', async () => {
    const npm = fakeNpm();
    const result = await installRuntime({
      cacheDir,
      npm: FAKE_NPM_COMMAND,
      runNpm: npm.run,
      probe: okProbe,
      backend: 'wasm',
    });
    expect(result.backend).toBe('wasm');
    // Pedir nativo depois reinstala, trocando os pacotes.
    const native = await installRuntime({
      cacheDir,
      npm: FAKE_NPM_COMMAND,
      runNpm: npm.run,
      probe: okProbe,
      backend: 'native',
    });
    expect(native.backend).toBe('native');
    expect(existsSync(join(runtimeDir(cacheDir), 'node_modules', 'onnxruntime-web'))).toBe(false);
  });

  it('npm com erro vira RuntimeInstallError com a saída e o palpite de rede', async () => {
    const npm = fakeNpm({ fail: { code: 1, output: 'npm error code ENOTFOUND\nnpm error network request failed' } });
    const error = await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: npm.run, probe: okProbe }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RuntimeInstallError);
    expect((error as RuntimeInstallError).exitCode).toBe(1);
    expect((error as Error).message).toContain('parece não haver rede');
    expect((await runtimeStatus({ cacheDir })).installed).toBe(false);
  });

  it('sem npm encontrável, NpmNotFoundError', async () => {
    const error = await installRuntime({
      cacheDir,
      findNpmContext: { env: {}, execPath: '/x/bin/node', platform: 'linux', exists: () => false },
      runNpm: fakeNpm().run,
      probe: okProbe,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NpmNotFoundError);
    expect((error as NpmNotFoundError).code).toBe('EMBEDDINGS_NPM_NOT_FOUND');
  });

  it('remove binários de outras plataformas e arquivos de navegador', async () => {
    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run, probe: okProbe, backend: 'native' });
    const napi = join(runtimeDir(cacheDir), 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    expect(await readdir(napi)).toEqual([process.platform]);
    expect(await readdir(join(napi, process.platform))).toEqual([process.arch]);

    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run, probe: okProbe, backend: 'wasm' });
    const dist = join(runtimeDir(cacheDir), 'node_modules', 'onnxruntime-web', 'dist');
    expect((await readdir(dist)).sort()).toEqual([
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm',
      'ort.node.min.mjs',
    ]);
  });
});

describe('prova de carga em processo filho (runtime de mentira)', () => {
  it('o nativo de mentira carrega e roda o Identity', async () => {
    const result = await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run });
    expect(result.backend).toBe('native');
  });

  it('nativo quebrado como no Alpine: detecta e cai para o wasm, com a mensagem do erro', async () => {
    const result = await installRuntime({
      cacheDir,
      npm: FAKE_NPM_COMMAND,
      runNpm: fakeNpm({ nativeBroken: MUSL_ERROR }).run,
    });
    expect(result.backend).toBe('wasm');
    expect(result.nativeError).toContain('ld-linux-x86-64.so.2');
  });

  it('a prova devolve a primeira linha do erro, sem pilha', async () => {
    const loader = join(cacheDir, 'quebrado.mjs');
    await writeFile(loader, "throw new Error('falhou de propósito');\n");
    const result = await childProcessProbe(loader);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('falhou de propósito');
    expect(firstErrorLine('    at x (y)\nError: z\n    at w')).toBe('Error: z');
  });
});

describe('runtimeStatus, loadRuntime e uninstallRuntime', () => {
  it('sem instalação: não instalado, e loadRuntime manda rodar embeddings on', async () => {
    expect(await runtimeStatus({ cacheDir })).toEqual({ dir: runtimeDir(cacheDir), installed: false, upToDate: false });
    const error = await loadRuntime({ cacheDir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeNotInstalledError);
    expect((error as Error).message).toContain('cabecao embeddings on');
  });

  it('pacote apagado à mão: deixa de contar como instalado e diz o porquê', async () => {
    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run, probe: okProbe });
    const { rm } = await import('node:fs/promises');
    await rm(join(runtimeDir(cacheDir), 'node_modules', '@huggingface'), { recursive: true });
    const status = await runtimeStatus({ cacheDir });
    expect(status.installed).toBe(false);
    expect(status.problem).toContain('@huggingface/tokenizers ausente');
  });

  it('importa o loader de verdade e mede o tamanho', async () => {
    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run, probe: okProbe });
    const runtime = await loadRuntime({ cacheDir });
    expect(runtime.backend).toBe('native');
    expect(typeof runtime.ort.InferenceSession.create).toBe('function');
    expect(typeof runtime.Tokenizer).toBe('function');
    const status = await runtimeStatus({ cacheDir, measure: true });
    expect(status.sizeBytes).toBeGreaterThan(0);
  });

  it('trocar de runtime no mesmo processo carrega o loader novo, não o do cache de módulos', async () => {
    const options = { cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run, probe: okProbe };
    await installRuntime({ ...options, backend: 'native' });
    expect((await loadRuntime({ cacheDir })).backend).toBe('native');
    await installRuntime({ ...options, backend: 'wasm' });
    expect((await loadRuntime({ cacheDir })).backend).toBe('wasm');
  });

  it('loader que falha ao importar vira RuntimeUnavailableError', async () => {
    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run, probe: okProbe });
    const error = await loadRuntime({
      cacheDir,
      importRuntime: async () => {
        throw new Error(MUSL_ERROR);
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeUnavailableError);
    expect((error as Error).message).toContain('ld-linux');
  });

  it('uninstallRuntime apaga o runtime e, se pedido, os modelos', async () => {
    await installRuntime({ cacheDir, npm: FAKE_NPM_COMMAND, runNpm: fakeNpm().run, probe: okProbe });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(cacheDir, 'models', 'a'), { recursive: true });
    await writeFile(join(cacheDir, 'models', 'a', 'm.onnx'), '12345');
    const first = await uninstallRuntime({ cacheDir });
    expect(first.removed).toBe(true);
    expect(first.freedBytes).toBeGreaterThan(0);
    expect(existsSync(runtimeDir(cacheDir))).toBe(false);
    expect(existsSync(join(cacheDir, 'models'))).toBe(true);
    expect(await uninstallRuntime({ cacheDir, includeModels: true })).toEqual({ removed: true, freedBytes: 5 });
    expect(await uninstallRuntime({ cacheDir })).toEqual({ removed: false, freedBytes: 0 });
  });
});
