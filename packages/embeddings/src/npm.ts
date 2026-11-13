/**
 * Achar e rodar o npm sem `shell: true`. No Windows o `npm` do PATH é um `npm.cmd`, que só roda por shell (e aí
 * aspas e espaços nos caminhos viram problema). O caminho seguro, provado no spike 14 nas 15 combinações de sistema
 * e Node, é rodar o `npm-cli.js` com o próprio executável do Node.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface NpmCommand {
  /** Executável a rodar (o Node, quase sempre). */
  command: string;
  /** Argumentos antes dos do npm (o caminho do `npm-cli.js`). */
  prefix: string[];
  /** De onde veio, para o relatório e para diagnóstico. */
  via: 'npm_execpath' | 'node-sibling' | 'path';
}

export interface FindNpmContext {
  env: Readonly<Record<string, string | undefined>>;
  execPath: string;
  platform: NodeJS.Platform;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
}

export function currentNpmContext(): FindNpmContext {
  return { env: process.env, execPath: process.execPath, platform: process.platform };
}

/**
 * Ordem: `npm_execpath` (dentro de `npx` e `npm exec` aponta para o `npm-cli.js`); o `npm-cli.js` que vem junto do
 * Node; o `npm` do PATH, resolvido até o `npm-cli.js` (ou, fora do Windows, o próprio executável, sem shell).
 * Devolve também a lista do que foi tentado, para a mensagem de erro.
 */
export function findNpm(ctx: FindNpmContext = currentNpmContext()): { npm: NpmCommand | null; tried: string[] } {
  const exists = ctx.exists ?? existsSync;
  const realpath = ctx.realpath ?? realpathSync;
  const pathApi = ctx.platform === 'win32' ? win32 : posix;
  const tried: string[] = [];

  const execpath = ctx.env.npm_execpath;
  if (execpath) {
    tried.push(`npm_execpath (${execpath})`);
    // Sob o pnpm ou o yarn, npm_execpath aponta para eles, não para o npm.
    if (/npm-cli\.c?js$/.test(execpath) && exists(execpath)) {
      return { npm: { command: ctx.execPath, prefix: [execpath], via: 'npm_execpath' }, tried };
    }
  }

  const nodeDir = pathApi.dirname(ctx.execPath);
  const sibling =
    ctx.platform === 'win32'
      ? pathApi.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : pathApi.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  tried.push(sibling);
  if (exists(sibling)) return { npm: { command: ctx.execPath, prefix: [sibling], via: 'node-sibling' }, tried };

  const pathDirs = (ctx.env.PATH ?? ctx.env.Path ?? '').split(pathApi.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    if (ctx.platform === 'win32') {
      const cli = pathApi.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      tried.push(cli);
      if (exists(cli)) return { npm: { command: ctx.execPath, prefix: [cli], via: 'path' }, tried };
      continue;
    }
    const bin = pathApi.join(dir, 'npm');
    if (!exists(bin)) continue;
    tried.push(bin);
    let real = bin;
    try {
      real = realpath(bin);
    } catch {
      // link quebrado: tenta o próximo
      continue;
    }
    if (/npm-cli\.c?js$/.test(real)) return { npm: { command: ctx.execPath, prefix: [real], via: 'path' }, tried };
    return { npm: { command: bin, prefix: [], via: 'path' }, tried };
  }
  return { npm: null, tried };
}

export interface NpmRunRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

export interface NpmRunResult {
  /** Código de saída; `null` se o processo morreu por sinal ou estourou o prazo. */
  code: number | null;
  output: string;
}

/** Executor do npm. Injetável nos testes. */
export type NpmRunner = (request: NpmRunRequest) => Promise<NpmRunResult>;

const MAX_OUTPUT = 64 * 1024;

/** Executor padrão: `spawn` sem shell, sem janela no Windows, guardando só o fim da saída. */
export const spawnNpm: NpmRunner = (request) =>
  new Promise((resolve) => {
    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT);
    };
    let settled = false;
    const finish = (result: NpmRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      append(Buffer.from(`\n[cabecao] npm passou de ${request.timeoutMs} ms e foi interrompido\n`));
      child.kill();
      finish({ code: null, output });
    }, request.timeoutMs);
    child.on('error', (error) => finish({ code: null, output: `${output}\n${error.message}` }));
    child.on('close', (code) => finish({ code, output }));
  });

/**
 * Ambiente do npm filho. Dentro de `npx` ou de `npm i -g`, o processo herda variáveis `npm_config_*` (global,
 * prefixo) que fariam o npm instalar no lugar errado.
 */
export function npmChildEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (lower === 'npm_config_global' || lower === 'npm_config_prefix' || lower === 'npm_config_location') continue;
    out[key] = value;
  }
  return out;
}
