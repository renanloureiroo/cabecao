/**
 * Apoio dos testes do índice: repositórios em `os.tmpdir()`, um remoto bare local e "máquinas" que são clones dele.
 * Identidade, assinatura e fim de linha ficam na configuração do próprio repositório; nada toca na global.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../../src/git/index.ts';
import {
  type EmbeddingRecord,
  fetchRemoteIndex,
  type IndexStore,
  indexPushRef,
  mergeRemoteIndex,
  recordIndexPushed,
} from '../../src/indexstore/index.ts';

export const TEST_TIMEOUT_MS = 60_000;
export const MODEL = 'teste-q8-r1';
export const OTHER_MODEL = 'outro-f16-r2';
export const DIMS = 16;

const LOCAL_CONFIG: [string, string][] = [
  ['user.name', 'Teste Cabeção'],
  ['user.email', 'teste@cabecao.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['core.autocrlf', 'false'],
  ['credential.helper', ''],
];

export async function git(dir: string, args: string[], input?: string): Promise<string> {
  return (await runGit(args, { cwd: dir, ...(input === undefined ? {} : { input }) })).stdout.trimEnd();
}

export async function gitTry(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await runGit(args, { cwd: dir, allowFailure: true });
  return { code: r.exitCode, stdout: r.stdout.trim(), stderr: r.stderr };
}

export function write(dir: string, path: string, content: string | Buffer): void {
  const file = join(dir, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function configureLocal(dir: string): void {
  const sections = new Map<string, string[]>();
  for (const [key, value] of LOCAL_CONFIG) {
    const dot = key.indexOf('.');
    const lines = sections.get(key.slice(0, dot)) ?? [];
    lines.push(`\t${key.slice(dot + 1)} = ${value === '' ? '""' : `"${value}"`}`);
    sections.set(key.slice(0, dot), lines);
  }
  appendFileSync(
    join(dir, '.git', 'config'),
    [...sections].map(([section, lines]) => `[${section}]\n${lines.join('\n')}\n`).join(''),
  );
}

/**
 * Pasta temporária com espaço e acento no nome, para exercitar caminhos difíceis. Com `ascii`, só ASCII: quando o
 * remoto é um caminho absoluto com acento, o `git receive-pack` (git 2.54, macOS) ignora o `receive.*` do remoto, e
 * os testes de servidor que proíbe exclusão precisam dessa configuração valendo.
 */
export function tempRoot(ascii = false): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), ascii ? 'cabecao-indice-' : 'cabeção índice ')));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Repositório com um commit de conteúdo na branch principal. */
export async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGit(['-c', 'init.defaultBranch=main', 'init', '--quiet', '--initial-branch=main'], { cwd: dir });
  configureLocal(dir);
  write(dir, '.gitignore', '.cabecao/\n');
  write(dir, 'wiki/x.md', '# Nota X\n\nPrimeiro parágrafo.\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'início']);
}

export interface World {
  readonly root: string;
  readonly remote: string;
  /** A primeira máquina, que criou o cérebro e enviou. */
  readonly a: string;
  clone(name: string, extra?: string[]): Promise<string>;
  cleanup(): void;
}

export async function createWorld(options: { ascii?: boolean } = {}): Promise<World> {
  const root = tempRoot(options.ascii);
  const remote = join(root, 'remote.git');
  await runGit(['-c', 'init.defaultBranch=main', 'init', '--bare', '--quiet', '--initial-branch=main', remote]);
  const a = join(root, 'a');
  await initRepo(a);
  await git(a, ['remote', 'add', 'origin', remote]);
  await git(a, ['push', '--quiet', '-u', 'origin', 'main']);
  return {
    root,
    remote,
    a,
    async clone(name, extra = []) {
      const dir = join(root, name);
      const config = LOCAL_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
      await runGit(['clone', '--quiet', ...config, ...extra, remote, dir], { cwd: root });
      return dir;
    },
    cleanup() {
      removeDir(root);
    },
  };
}

/** Gerador determinístico (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function keyOf(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 32);
}

/** Registros sintéticos: chaves `keyOf(<prefixo>:<i>)`, vetores int8 pseudoaleatórios (não comprimem). */
export function makeRecords(prefix: string, count: number, dims = DIMS, seed = 1): EmbeddingRecord[] {
  const rand = prng(seed ^ count ^ prefix.length);
  const out: EmbeddingRecord[] = [];
  for (let i = 0; i < count; i++) {
    const vector = new Int8Array(dims);
    for (let d = 0; d < dims; d++) vector[d] = Math.floor(rand() * 255) - 127;
    out.push({ key: keyOf(`${prefix}:${i}`), scale: Math.fround(0.001 + rand()), vector });
  }
  return out;
}

export async function collect(store: IndexStore): Promise<EmbeddingRecord[]> {
  const out: EmbeddingRecord[] = [];
  for await (const record of store.readAll()) out.push(record);
  return out;
}

export function sameRecord(a: EmbeddingRecord | undefined, b: EmbeddingRecord | undefined): boolean {
  if (!a || !b) return false;
  return a.key === b.key && a.scale === b.scale && Buffer.from(a.vector).equals(Buffer.from(b.vector));
}

/**
 * O que o sync fará: busca, integra e envia a branch de índice (o push atômico real inclui também o conteúdo).
 * Devolve quantas tentativas levou.
 */
export async function syncIndex(dir: string, remote = 'origin'): Promise<number> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const fetched = await fetchRemoteIndex(dir, remote);
    if (!fetched.ok) throw new Error(`fetch falhou: ${fetched.detail}`);
    await mergeRemoteIndex(dir, remote);
    const ref = await indexPushRef(dir, remote);
    if (ref === null) return attempt;
    const pushed = await gitTry(dir, ['push', '--atomic', '--quiet', remote, `${ref.sha}:${ref.ref}`]);
    if (pushed.code === 0) {
      await recordIndexPushed(dir, remote, ref);
      return attempt;
    }
    if (!/rejected|fetch first|non-fast-forward|stale info/i.test(pushed.stderr)) throw new Error(pushed.stderr);
  }
  throw new Error('o envio do índice não convergiu em 6 tentativas');
}

/** Referências `cabecao/*` de um repositório (nome → sha). */
export async function indexRefs(dir: string): Promise<Map<string, string>> {
  const out = await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/cabecao/']);
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ') as [string, string]),
  );
}

/** Os scripts de apoio importam o TypeScript direto; no Node 22.16 e 22.17 isso pede a opção abaixo. */
const TYPE_FLAGS = process.features.typescript ? [] : ['--experimental-strip-types'];

export function spawnChild(args: string[]): ChildProcess {
  const script = fileURLToPath(new URL('indexstore-child.mjs', import.meta.url));
  return spawn(process.execPath, ['--no-warnings', ...TYPE_FLAGS, script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function waitChild(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
