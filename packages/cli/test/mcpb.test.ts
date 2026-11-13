// O pacote `.mcpb` do Claude Desktop, gerado por `scripts/build-mcpb.mjs` a partir do bundle embutido no plugin (o
// mesmo da CLI, conferido pelo `plugin.test.ts`): manifesto conforme a especificação MCPB 0.3, conteúdo só com o
// manifesto, o ícone e o bundle, zip reproduzível, e o servidor sobe a partir do pacote extraído, como o Claude Desktop
// faria (substituindo `${__dirname}` e `${user_config.brain_dir}`). A instalação no aplicativo real não é testada.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { TOOL_NAMES } from '@cabecao/server';
import { afterAll, describe, expect, it } from 'vitest';
import { brainRepo, disposeSandbox, freshDir, TEST_TIMEOUT_MS } from './helpers.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER = join(REPO, 'integrations', 'claude-code', 'server');
const pkg = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'package.json'), 'utf8')) as {
  version: string;
  engines: { node: string };
};
const DIRNAME_VAR = ['$', '{__dirname}'].join('');
const BRAIN_VAR = ['$', '{user_config.brain_dir}'].join('');

afterAll(() => {
  disposeSandbox();
});

function build(out: string): { file: string; bytes: Buffer } {
  const result = spawnSync(
    process.execPath,
    [join(REPO, 'scripts', 'build-mcpb.mjs'), '--dist', SERVER, '--out', out],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const file = result.stdout.trim();
  return { file, bytes: readFileSync(file) };
}

/** Leitor mínimo de zip: diretório central, deflate ou sem compressão, CRC conferido pelo tamanho. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const raw = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + size);
    const content = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(content.length).toBe(raw);
    files.set(name, content);
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

describe('pacote .mcpb do Claude Desktop', { timeout: TEST_TIMEOUT_MS }, () => {
  const out = freshDir('mcpb');
  const first = build(join(out, 'um'));
  const files = readZip(first.bytes);
  const manifest = JSON.parse((files.get('manifest.json') as Buffer).toString('utf8'));

  it('é reproduzível: duas gerações dão os mesmos bytes', () => {
    const second = build(join(out, 'dois'));
    expect(createHash('sha256').update(second.bytes).digest('hex')).toBe(
      createHash('sha256').update(first.bytes).digest('hex'),
    );
    expect(first.file.endsWith(`cabecao-${pkg.version}.mcpb`)).toBe(true);
  });

  it('contém só o manifesto, o ícone e o bundle do servidor: sem node_modules, sem npx, nada da máquina', () => {
    const build = JSON.parse(readFileSync(join(SERVER, 'build.json'), 'utf8')) as { files: Record<string, string> };
    expect([...files.keys()].sort()).toEqual(
      ['icon.png', 'manifest.json', ...Object.keys(build.files).map((name) => `server/${name}`)].sort(),
    );
    for (const [name, hash] of Object.entries(build.files)) {
      expect(
        createHash('sha256')
          .update(files.get(`server/${name}`) as Buffer)
          .digest('hex'),
      ).toBe(hash);
    }
    expect((files.get('icon.png') as Buffer).subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(first.bytes.length).toBeLessThan(600_000);
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/);
    expect(JSON.stringify(manifest.server)).not.toMatch(/npx|node_modules|\/Users\/|\/home\/|[A-Z]:\\\\/);
  });

  it('manifesto conforme a especificação MCPB 0.3, com a pasta do cérebro como opção do usuário', () => {
    const committed = JSON.parse(readFileSync(join(REPO, 'integrations', 'mcpb', 'manifest.json'), 'utf8'));
    expect(committed.version).toBe(pkg.version); // o "pnpm build:plugin" mantém a versão em dia
    expect(manifest).toEqual(committed);
    expect(manifest).toMatchObject({
      manifest_version: '0.3',
      name: 'cabecao',
      version: pkg.version,
      description: expect.any(String),
      author: { name: expect.any(String) },
      icon: 'icon.png',
      server: {
        type: 'node',
        entry_point: 'server/cabecao.mjs',
        mcp_config: {
          command: 'node',
          args: [`${DIRNAME_VAR}/server/cabecao.mjs`, 'mcp'],
          env: { CABECAO_BRAIN: BRAIN_VAR },
        },
      },
      user_config: {
        brain_dir: { type: 'directory', required: true, title: expect.any(String), description: expect.any(String) },
      },
      compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: pkg.engines.node } },
    });
    expect(files.has(manifest.server.entry_point)).toBe(true);
    // a validação do mcpb só aceita estas variáveis no mcp_config
    const vars = JSON.stringify(manifest.server.mcp_config).match(/\$\{[^}]*\}/g) ?? [];
    for (const variable of vars)
      expect(variable).toMatch(/^\$\{(?:__dirname|pathSeparator|\/|user_config\.[a-z_]+)\}$/);
    for (const key of Object.keys(manifest.user_config)) {
      expect(['string', 'number', 'boolean', 'directory', 'file']).toContain(manifest.user_config[key].type);
    }
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  it('o servidor sobe a partir do pacote extraído e lista as tools do manifesto', async () => {
    const dir = join(out, 'extraído');
    for (const [name, data] of files) {
      mkdirSync(dirname(join(dir, ...name.split('/'))), { recursive: true });
      writeFileSync(join(dir, ...name.split('/')), data);
    }
    const brain = await brainRepo('cérebro do desktop');
    const home = freshDir('casa do desktop');
    const sub = (text: string): string => text.replaceAll(DIRNAME_VAR, dir).replaceAll(BRAIN_VAR, brain);
    const config = manifest.server.mcp_config as { command: string; args: string[]; env: Record<string, string> };
    expect(config.command).toBe('node');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CABECAO_CONFIG_DIR: join(home, 'cfg'),
    };
    delete env.CABECAO_BRAIN;
    for (const [key, value] of Object.entries(config.env)) env[key] = sub(value);
    const child: ChildProcess = spawn(process.execPath, config.args.map(sub), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const pending = new Map<
      number,
      (message: { result?: { tools?: Array<{ name: string }>; serverInfo?: unknown } }) => void
    >();
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) pending.get(message.id)?.(message as never);
      }
    });
    const send = (message: object): void => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const request = (id: number, method: string, params: object) =>
      new Promise<{ result?: { tools?: Array<{ name: string }>; serverInfo?: unknown } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`sem resposta para ${method}`)), 30_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        send({ id, method, params });
      });
    try {
      const opened = await request(1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'claude-desktop-simulado', version: '0.0.0' },
      });
      expect(opened.result?.serverInfo).toMatchObject({ name: 'cabecao' });
      send({ method: 'notifications/initialized' });
      const listed = await request(2, 'tools/list', {});
      expect(listed.result?.tools?.map((tool) => tool.name).sort()).toEqual(
        manifest.tools.map((tool: { name: string }) => tool.name).sort(),
      );
      const status = (await request(3, 'tools/call', { name: 'status', arguments: {} })) as {
        result?: { isError?: boolean; structuredContent?: { root?: string } };
      };
      expect(status.result?.isError ?? false).toBe(false);
    } finally {
      child.stdin?.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve(null);
        }, 10_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
    }
  });
});
