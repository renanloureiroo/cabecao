// Vetores sintéticos determinísticos: sem rede, sem modelo, os mesmos números em qualquer máquina.

/** Gerador congruente linear de 32 bits, em [0, 1). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Normal padrão por Box-Muller. */
export function gaussian(random: () => number): number {
  const u = random() || 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export function normalize(values: Float32Array): Float32Array {
  let squares = 0;
  for (const v of values) squares += v * v;
  const inv = 1 / Math.sqrt(squares);
  return values.map((v) => v * inv);
}

/** Vetor unitário em direção aleatória. */
export function randomUnit(dims: number, random: () => number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = gaussian(random);
  return normalize(v);
}

/**
 * Vetor unitário com cosseno exato `target` com `base` (unitário): `target · base + √(1 − target²) · u`, com `u`
 * unitário e ortogonal a `base`.
 */
export function withCosine(base: Float32Array, target: number, random: () => number): Float32Array {
  const noise = randomUnit(base.length, random);
  let dot = 0;
  for (let i = 0; i < base.length; i++) dot += (noise[i] as number) * (base[i] as number);
  const ortho = normalize(noise.map((v, i) => v - dot * (base[i] as number)));
  const side = Math.sqrt(1 - target * target);
  return base.map((v, i) => target * v + side * (ortho[i] as number));
}

/** Chave de vetor válida (32 hex) a partir de um número. */
export function keyOf(n: number): string {
  return n.toString(16).padStart(32, '0');
}
