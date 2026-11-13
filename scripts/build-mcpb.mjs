// Gera o pacote `.mcpb` do Claude Desktop (MCP Bundle, github.com/modelcontextprotocol/mcpb) com o servidor EMBUTIDO:
// o mesmo bundle da CLI, sem `npx`, sem `node_modules` e sem rede. O pacote é um zip com só três coisas:
//
//   manifest.json   integrations/mcpb/manifest.json, com a versão do pacote cabecao
//   icon.png        assets/marca/icone-512.png
//   server/*.mjs    o bundle (packages/cli/dist, ou --dist)
//
// O zip é REPRODUZÍVEL: entradas em ordem, data fixa (1980-01-01, a mínima do formato), permissões fixas, sem campo
// extra e com o deflate do zlib do próprio Node; a mesma entrada dá os mesmos bytes. Sem dependência: o formato zip
// é escrito aqui (cabeçalho local, diretório central e fim do diretório, APPNOTE.TXT).
//
// Uso: node scripts/build-mcpb.mjs [--dist <pasta do bundle>] [--out <pasta>] [--version <x.y.z>]
//   Padrão: --dist packages/cli/dist, --out integrations/mcpb/dist, versão do packages/cli/package.json.
//   Imprime o caminho do arquivo gerado.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';

const repo = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    dist: { type: 'string', default: join(repo, 'packages', 'cli', 'dist') },
    out: { type: 'string', default: join(repo, 'integrations', 'mcpb', 'dist') },
    version: { type: 'string' },
  },
});
const dist = resolve(values.dist);
const version =
  values.version ?? JSON.parse(readFileSync(join(repo, 'packages', 'cli', 'package.json'), 'utf8')).version;

if (!existsSync(join(dist, 'cabecao.mjs'))) {
  console.error(`o bundle não existe em ${dist}: rode "pnpm build" antes (ou "pnpm build:mcpb", que faz os dois).`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(repo, 'integrations', 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = version;

/** Entradas do pacote: caminho dentro do zip e bytes. Só o manifesto, o ícone e os arquivos `.mjs` do bundle. */
const entries = [
  { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
  { name: 'icon.png', data: readFileSync(join(repo, 'assets', 'marca', 'icone-512.png')) },
  ...readdirSync(dist)
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => ({ name: `server/${name}`, data: readFileSync(join(dist, name)) })),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// 1980-01-01 00:00 no formato do DOS: data = ((1980-1980) << 9) | (1 << 5) | 1, hora = 0
const DOS_DATE = 0x21;
const DOS_TIME = 0;
const VERSION_MADE_BY = (3 << 8) | 20; // Unix, especificação 2.0
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 1 << 11;
const EXTERNAL_ATTRS = ((0o100644 << 16) >>> 0) >>> 0; // arquivo comum, rw-r--r--

const locals = [];
const centrals = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const compressed = deflateRawSync(entry.data, { level: 9 });
  const crc = crc32(entry.data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(FLAG_UTF8, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(entry.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(VERSION_MADE_BY, 4);
  central.writeUInt16LE(VERSION_NEEDED, 6);
  central.writeUInt16LE(FLAG_UTF8, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(entry.data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comentário
  central.writeUInt16LE(0, 34); // disco
  central.writeUInt16LE(0, 36); // atributos internos
  central.writeUInt32LE(EXTERNAL_ATTRS, 38);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, ...centrals, end]);
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const file = join(out, `cabecao-${version}.mcpb`);
writeFileSync(file, zip);
const unpacked = entries.reduce((sum, entry) => sum + entry.data.length, 0);
console.error(
  `cabecao-${version}.mcpb: ${entries.length} arquivos, ${(zip.length / 1000).toFixed(1)} kB (${(unpacked / 1000).toFixed(1)} kB descompactado), sha256 ${createHash('sha256').update(zip).digest('hex')}`,
);
console.log(file);
