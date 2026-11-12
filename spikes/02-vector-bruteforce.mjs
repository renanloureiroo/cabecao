// Spike 2: busca vetorial por força bruta em JS puro, sem extensão nativa
const D = 384;
for (const N of [20000, 100000, 300000]) {
  const f32 = new Float32Array(N * D); for (let i = 0; i < f32.length; i++) f32[i] = Math.random() - 0.5;
  const i8 = new Int8Array(N * D); for (let i = 0; i < i8.length; i++) i8[i] = Math.round(f32[i] * 254);
  const q = new Float32Array(D).map(() => Math.random() - 0.5); const q8 = Int8Array.from(q, v => Math.round(v * 254));
  const run = (arr, qq) => { const s = new Float32Array(N); for (let i = 0, o = 0; i < N; i++, o += D) { let a = 0; for (let j = 0; j < D; j++) a += arr[o + j] * qq[j]; s[i] = a; } return s; };
  run(f32, q); run(i8, q8);
  let t = performance.now(); run(f32, q); const tf = performance.now() - t;
  t = performance.now(); run(i8, q8); const ti = performance.now() - t;
  console.log(`${N} vetores x ${D}d  float32: ${tf.toFixed(0)}ms (${(N * D * 4 / 1e6).toFixed(0)}MB)   int8: ${ti.toFixed(0)}ms (${(N * D / 1e6).toFixed(0)}MB)`);
}
