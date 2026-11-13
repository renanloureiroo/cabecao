/**
 * Prova de carga do runtime depois de instalar: num processo filho, importa o `loader.mjs`, abre uma sessão ONNX com
 * um modelo mínimo (um nó `Identity`, 67 bytes, montado aqui mesmo) e roda uma inferência. É o que pega o caso do
 * Alpine/musl, onde o `onnxruntime-node` instala mas não carrega (`Error loading shared library
 * ld-linux-x86-64.so.2`). O processo filho isola a CLI de uma falha grave do binário nativo e não deixa um módulo
 * quebrado no cache de `import()` do processo atual.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface ProbeResult {
  ok: boolean;
  /** Primeira linha útil do erro, sem pilha. */
  error?: string;
  ms: number;
}

/** Prova a carga do runtime cujo `loader.mjs` está em `loaderPath`. Injetável nos testes. */
export type RuntimeProbe = (loaderPath: string) => Promise<ProbeResult>;

// ---- protobuf mínimo para um ModelProto do ONNX
const varint = (value: number): number[] => {
  const out: number[] = [];
  let n = value;
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return out;
};
const field = (no: number, wire: number, payload: number[]): number[] => [...varint((no << 3) | wire), ...payload];
const message = (no: number, payload: number[]): number[] => field(no, 2, [...varint(payload.length), ...payload]);
const text = (no: number, value: string): number[] => message(no, [...new TextEncoder().encode(value)]);
const integer = (no: number, value: number): number[] => field(no, 0, varint(value));

/** ValueInfoProto: tensor float de forma `[1]`. */
const floatScalar = (name: string) => [
  ...text(1, name),
  ...message(2, message(1, [...integer(1, 1), ...message(2, message(1, integer(1, 1)))])),
];

/** Modelo ONNX (IR 8, opset 13) com `y = Identity(x)`, `x` float `[1]`. */
export function identityModel(): Uint8Array {
  const node = [...text(1, 'x'), ...text(2, 'y'), ...text(4, 'Identity')];
  const graph = [
    ...message(1, node),
    ...text(2, 'probe'),
    ...message(11, floatScalar('x')),
    ...message(12, floatScalar('y')),
  ];
  return Uint8Array.from([...integer(1, 8), ...message(8, integer(2, 13)), ...message(7, graph)]);
}

/** Script do processo filho. Recebe a URL do loader e o modelo em base64; imprime uma linha `PROBE {json}`. */
export const PROBE_SCRIPT = `
const [loaderUrl, modelB64] = process.argv.slice(-2);
try {
  const runtime = await import(loaderUrl);
  const { ort } = runtime;
  if (ort.env?.wasm) ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(Uint8Array.from(Buffer.from(modelB64, 'base64')));
  const out = await session.run({ x: new ort.Tensor('float32', Float32Array.from([42]), [1]) });
  const value = out[session.outputNames[0]].data[0];
  if (value !== 42) throw new Error('inferência de prova devolveu ' + value);
  await session.release?.();
  console.log('PROBE ' + JSON.stringify({ ok: true, backend: runtime.backend }));
  process.exit(0);
} catch (error) {
  console.log('PROBE ' + JSON.stringify({ ok: false, error: String(error && error.message || error) }));
  process.exit(0);
}
`;

const PROBE_TIMEOUT_MS = 120_000;

/** Primeira linha que parece erro, sem as linhas de pilha. */
export function firstErrorLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('at '));
  return (lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? 'sem saída').slice(0, 500);
}

/** Prova padrão: `node --input-type=module -e <script>` com o mesmo executável do Node. */
export const childProcessProbe: RuntimeProbe = (loaderPath) =>
  new Promise((resolve) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const args = [
      '--input-type=module',
      '-e',
      PROBE_SCRIPT,
      pathToFileURL(loaderPath).href,
      Buffer.from(identityModel()).toString('base64'),
    ];
    let output = '';
    const child = spawn(process.execPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-32_768);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `a prova de carga passou de ${PROBE_TIMEOUT_MS} ms`, ms: elapsed() });
    }, PROBE_TIMEOUT_MS);
    child.on('error', (error) => finish({ ok: false, error: error.message, ms: elapsed() }));
    child.on('close', (code, signal) => {
      const line = output.split(/\r?\n/).find((l) => l.startsWith('PROBE '));
      if (line) {
        try {
          const parsed = JSON.parse(line.slice(6)) as { ok: boolean; error?: string };
          finish(parsed.ok ? { ok: true, ms: elapsed() } : { ok: false, error: parsed.error ?? 'erro', ms: elapsed() });
          return;
        } catch {
          // cai no caso abaixo
        }
      }
      const why = signal ? `processo encerrado por ${signal}` : `saiu com código ${code}`;
      finish({ ok: false, error: `${why}: ${firstErrorLine(output)}`, ms: elapsed() });
    });
  });
