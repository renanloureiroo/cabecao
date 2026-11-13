// Runtime de mentira para os testes: pacotes falsos de onnxruntime e tokenizador, gravados num diretório temporário
// como o npm gravaria, para exercitar a instalação, a prova de carga em processo filho e o `import()` do loader de
// verdade, sem rede e sem binário nativo.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NpmRunner, NpmRunRequest } from '../src/npm.ts';

export async function tempDir(prefix = 'cabecao-emb-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/**
 * Corpo do onnxruntime falso. Um modelo cujo arquivo é um JSON `{"fakeModel": true, "dims": N}` vira uma sessão de
 * embeddings determinística (cada posição preenchida recebe 1000, para mostrar se a agregação ignora o
 * preenchimento); qualquer outro modelo vira o `Identity` da prova de carga.
 */
const FAKE_ORT_BODY = `
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
function parseFake(bytes) {
  try { const v = JSON.parse(new TextDecoder().decode(bytes)); return v && v.fakeModel ? v : null; } catch { return null; }
}
const InferenceSession = {
  async create(model, options) {
    const bytes = typeof model === 'string' ? readFileSync(model) : model;
    globalThis.__fakeOrtCreates = (globalThis.__fakeOrtCreates || 0) + 1;
    const fake = parseFake(bytes);
    if (!fake) {
      return { inputNames: ['x'], outputNames: ['y'], async run(f) { return { y: new Tensor('float32', f.x.data, f.x.dims) }; }, async release() {} };
    }
    const D = fake.dims;
    return {
      inputNames: ['input_ids', 'attention_mask'],
      outputNames: fake.graph ? ['sentence_embedding'] : ['last_hidden_state'],
      async run(feeds) {
        const [rows, width] = feeds.input_ids.dims;
        const ids = feeds.input_ids.data, mask = feeds.attention_mask.data;
        const hidden = new Float32Array(rows * width * D);
        for (let r = 0; r < rows; r++) for (let t = 0; t < width; t++) for (let j = 0; j < D; j++) {
          const k = r * width + t;
          hidden[k * D + j] = Number(mask[k]) ? Math.sin(Number(ids[k]) * (j + 1)) : 1000;
        }
        if (!fake.graph) return { last_hidden_state: new Tensor('float32', hidden, [rows, width, D]) };
        const out = new Float32Array(rows * D);
        for (let r = 0; r < rows; r++) {
          let n = 0;
          for (let t = 0; t < width; t++) if (Number(mask[r * width + t])) { n++; for (let j = 0; j < D; j++) out[r * D + j] += hidden[(r * width + t) * D + j]; }
          for (let j = 0; j < D; j++) out[r * D + j] /= n;
        }
        return { sentence_embedding: new Tensor('float32', out, [rows, D]) };
      },
      async release() {},
    };
  },
};
`;

const FAKE_TOKENIZER = `
export class Tokenizer {
  constructor(json, config) { this.json = json; this.config = config; }
  encode(text, options) {
    const ids = Array.from(text, (c) => 3 + (c.codePointAt(0) % 97));
    return { ids: options && options.add_special_tokens === false ? ids : [1, ...ids, 2] };
  }
  token_to_id(token) { return token === '<pad>' ? 0 : undefined; }
}
`;

/** Erro que o onnxruntime-node dá no Alpine (spike 14, "Extra: Alpine"). */
export const MUSL_ERROR =
  'Error loading shared library ld-linux-x86-64.so.2: No such file or directory (needed by onnxruntime_binding.node)';

export interface FakePackagesOptions {
  /** O onnxruntime-node falso lança este erro ao ser importado (simula o Alpine). */
  nativeBroken?: string;
  /** O onnxruntime-web falso também lança. */
  wasmBroken?: string;
}

/** Grava os pacotes de `dependencies` do `package.json` em `node_modules`, como o npm faria. */
export async function writeFakePackages(
  dir: string,
  deps: Record<string, string>,
  options: FakePackagesOptions = {},
): Promise<void> {
  const nm = join(dir, 'node_modules');
  for (const [name, version] of Object.entries(deps)) {
    const pkgDir = join(nm, ...name.split('/'));
    await mkdir(pkgDir, { recursive: true });
    if (name === 'onnxruntime-node') {
      await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
      const body = options.nativeBroken
        ? `throw new Error(${JSON.stringify(options.nativeBroken)});`
        : `const { readFileSync } = require('node:fs');\n${FAKE_ORT_BODY}\nmodule.exports = { InferenceSession, Tensor };`;
      await writeFile(join(pkgDir, 'index.js'), body);
      for (const [platform, arch] of [
        ['linux', 'x64'],
        ['win32', 'x64'],
        [process.platform, process.arch],
        [process.platform, 'other-arch'],
      ]) {
        const bin = join(pkgDir, 'bin', 'napi-v6', platform ?? '', arch ?? '');
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, 'onnxruntime_binding.node'), 'binario');
      }
    } else if (name === 'onnxruntime-web') {
      const exportsField = { '.': { node: { import: './dist/ort.node.min.mjs' } } };
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name, version, type: 'module', exports: exportsField }),
      );
      await mkdir(join(pkgDir, 'dist'), { recursive: true });
      const body = options.wasmBroken
        ? `throw new Error(${JSON.stringify(options.wasmBroken)});`
        : `import { readFileSync } from 'node:fs';\n${FAKE_ORT_BODY}\nexport const env = { wasm: {} };\nexport { InferenceSession, Tensor };`;
      await writeFile(join(pkgDir, 'dist', 'ort.node.min.mjs'), body);
      await writeFile(join(pkgDir, 'dist', 'ort-wasm-simd-threaded.mjs'), '// wasm glue');
      await writeFile(join(pkgDir, 'dist', 'ort-wasm-simd-threaded.wasm'), 'wasm');
      await writeFile(join(pkgDir, 'dist', 'ort.all.bundle.min.mjs'), '// navegador');
      await writeFile(join(pkgDir, 'dist', 'ort-wasm-simd-threaded.jsep.wasm'), 'navegador');
    } else {
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name, version, type: 'module', exports: './index.mjs' }),
      );
      await writeFile(join(pkgDir, 'index.mjs'), FAKE_TOKENIZER);
    }
  }
}

export interface FakeNpm {
  run: NpmRunner;
  calls: NpmRunRequest[];
}

/** npm falso: lê o `package.json` gravado pelo instalador e escreve os pacotes falsos. */
export function fakeNpm(
  options: FakePackagesOptions & { fail?: { code: number; output: string }; delayMs?: number } = {},
): FakeNpm {
  const calls: NpmRunRequest[] = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail) return { code: options.fail.code, output: options.fail.output };
      const { readFile } = await import('node:fs/promises');
      const pkg = JSON.parse(await readFile(join(request.cwd, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      };
      await writeFakePackages(request.cwd, pkg.dependencies, options);
      return { code: 0, output: 'added 3 packages' };
    },
  };
}

/** Comando de npm fixo, para não depender do npm da máquina. */
export const FAKE_NPM_COMMAND = {
  command: process.execPath,
  prefix: ['/fake/npm-cli.js'],
  via: 'npm_execpath' as const,
};
