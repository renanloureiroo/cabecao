// Scanner de segredos do sync: roda antes de commitar edições feitas fora do Cabeção e antes de enviar. Achou: o
// sync bloqueia. Vale para TUDO o que vai ser commitado e enviado (notas, anexos, configuração), não só para notas.
//
// Marcador `cabecao:allow-secret`: o sync o respeita. Ele é a saída legítima para o USUÁRIO que editou um arquivo no
// Obsidian (ou noutro editor) e sabe que a linha acusada não é um segredo. As escritas de AGENTE (tools do MCP) são
// escaneadas antes, pela camada `brain/`, sem honrar o marcador: um agente não consegue se liberar escrevendo-o.
//
// Custo: arquivo de texto de qualquer tamanho é lido aos pedaços (janelas de 1 Mi caracteres com sobreposição), sem
// carregar o arquivo inteiro na memória. Só fica sem leitura completa o que é CLARAMENTE binário: extensão conhecida
// de binário E conteúdo de binário (assinatura do formato ou byte nulo no começo). Um `.md` com um byte nulo continua
// sendo texto e é escaneado.
import { createReadStream } from 'node:fs';
import { scanSecrets } from '../security/index.ts';
import { type GitContext, git, gitStream, objectSizes, readObjects } from './git.ts';
import type { SecretLocation } from './types.ts';

/** Até este tamanho o conteúdo é lido de uma vez; acima, aos pedaços. */
export const SMALL_FILE_BYTES = 1 << 20;
/** Tamanho de cada janela entregue ao scanner, em caracteres. */
const WINDOW_CHARS = 1 << 20;
/**
 * Sobreposição entre janelas. Maior que qualquer segredo que as regras reconhecem (uma chave privada PEM de 4096
 * bits tem uns 3 KB), então um segredo cortado no fim de uma janela aparece inteiro na seguinte.
 */
const OVERLAP_CHARS = 64 * 1024;
/** Quanto do começo do arquivo decide se ele é binário (o mesmo trecho que o git olha). */
const HEAD_BYTES = 8000;
/** Teto de bytes por leitura em lote de blobs pequenos. */
const BATCH_BYTES = 32 * 1024 * 1024;

// --- Binário ------------------------------------------------------------------------------------------------------

type Magic = (head: Uint8Array) => boolean;

const bytesAt =
  (offset: number, ...bytes: number[]): Magic =>
  (head) =>
    bytes.every((byte, i) => head[offset + i] === byte);
const textAt = (offset: number, text: string): Magic => bytesAt(offset, ...[...text].map((ch) => ch.charCodeAt(0)));
const anyOf =
  (...checks: Magic[]): Magic =>
  (head) =>
    checks.some((check) => check(head));

const ISO_MEDIA = textAt(4, 'ftyp');
const RIFF =
  (kind: string): Magic =>
  (head) =>
    textAt(0, 'RIFF')(head) && textAt(8, kind)(head);
const ZIP = anyOf(
  bytesAt(0, 0x50, 0x4b, 0x03, 0x04),
  bytesAt(0, 0x50, 0x4b, 0x05, 0x06),
  bytesAt(0, 0x50, 0x4b, 0x07, 0x08),
);
const OLE = bytesAt(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const MP3: Magic = anyOf(textAt(0, 'ID3'), (head) => head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);

/** Formatos binários conhecidos (anexos de um cofre de notas), pela extensão, com a assinatura de cada um. */
const BINARY_FORMATS: readonly [readonly string[], Magic][] = [
  [['png', 'apng'], bytesAt(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
  [['jpg', 'jpeg', 'jfif', 'jpe'], bytesAt(0, 0xff, 0xd8, 0xff)],
  [['gif'], textAt(0, 'GIF8')],
  [['webp'], RIFF('WEBP')],
  [['bmp'], textAt(0, 'BM')],
  [['ico', 'cur'], anyOf(bytesAt(0, 0, 0, 1, 0), bytesAt(0, 0, 0, 2, 0))],
  [['tif', 'tiff'], anyOf(textAt(0, 'II*\0'), textAt(0, 'MM\0*'))],
  [['heic', 'heif', 'avif', 'mp4', 'm4a', 'm4v', 'm4b', 'mov', '3gp', 'qt'], ISO_MEDIA],
  [['psd'], textAt(0, '8BPS')],
  [['pdf'], textAt(0, '%PDF-')],
  [['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'jar', 'apk', 'key', 'pages', 'numbers', 'xmind'], ZIP],
  [['doc', 'xls', 'ppt', 'msg'], OLE],
  [['gz', 'tgz'], bytesAt(0, 0x1f, 0x8b)],
  [['7z'], bytesAt(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)],
  [['rar'], textAt(0, 'Rar!')],
  [['bz2'], textAt(0, 'BZh')],
  [['xz'], bytesAt(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)],
  [['zst'], bytesAt(0, 0x28, 0xb5, 0x2f, 0xfd)],
  [['mp3'], MP3],
  [['wav'], RIFF('WAVE')],
  [['avi'], RIFF('AVI ')],
  [['ogg', 'oga', 'ogv', 'opus'], textAt(0, 'OggS')],
  [['flac'], textAt(0, 'fLaC')],
  [['webm', 'mkv', 'mka'], bytesAt(0, 0x1a, 0x45, 0xdf, 0xa3)],
  [['woff'], textAt(0, 'wOFF')],
  [['woff2'], textAt(0, 'wOF2')],
  [['ttf', 'otf'], anyOf(bytesAt(0, 0, 1, 0, 0), textAt(0, 'OTTO'), textAt(0, 'true'))],
  [['sqlite', 'sqlite3', 'db'], textAt(0, 'SQLite format 3\0')],
  [['exe', 'dll'], textAt(0, 'MZ')],
  [['class'], bytesAt(0, 0xca, 0xfe, 0xba, 0xbe)],
  [['wasm'], textAt(0, '\0asm')],
];

const MAGIC_BY_EXTENSION = new Map<string, Magic>(
  BINARY_FORMATS.flatMap(([extensions, magic]) => extensions.map((ext) => [ext, magic] as const)),
);

/**
 * Binário de verdade: extensão de um formato binário conhecido E conteúdo compatível (a assinatura do formato, ou um
 * byte nulo nos primeiros 8000 bytes, como o git decide). Nem a extensão sozinha nem o byte nulo sozinho bastam:
 * um `.md` com um byte nulo e um `.png` que na verdade é texto são escaneados.
 */
export function isClearlyBinary(path: string, head: Uint8Array): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const magic = MAGIC_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase());
  if (magic === undefined) return false;
  return magic(head) || head.subarray(0, HEAD_BYTES).includes(0);
}

// --- Texto em janelas ---------------------------------------------------------------------------------------------

/** Achado com o texto da linha, para conferir se a linha já está no remoto. */
export interface ScanHit extends SecretLocation {
  readonly lineText: string;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/**
 * Escaneia um texto entregue aos pedaços. Cada janela responde só pelos achados que COMEÇAM antes da sua fronteira;
 * a próxima janela recomeça antes dessa fronteira (pelo menos `OVERLAP_CHARS` antes do corte, e uma linha antes,
 * para o marcador "linha anterior" do `cabecao:allow-secret` continuar valendo). Linha e coluna são absolutas.
 */
class TextScanner {
  private readonly path: string;
  private readonly where: SecretLocation['where'];
  private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  private pending = '';
  /** Linha (a partir de 1) do primeiro caractere de `pending`. */
  private lineBase = 1;
  /** Coluna (a partir de 0) do primeiro caractere de `pending` na linha dele. */
  private colBase = 0;
  /** Achados antes deste índice de `pending` já foram respondidos pela janela anterior. */
  private acceptFrom = 0;
  readonly hits: ScanHit[] = [];

  constructor(path: string, where: SecretLocation['where']) {
    this.path = path;
    this.where = where;
  }

  push(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    while (this.pending.length >= WINDOW_CHARS + OVERLAP_CHARS) this.scanWindow(false);
  }

  end(): ScanHit[] {
    this.pending += this.decoder.decode();
    this.scanWindow(true);
    return this.hits;
  }

  private scanWindow(final: boolean): void {
    const text = final ? this.pending : this.pending.slice(0, WINDOW_CHARS);
    let boundary = text.length;
    let next = text.length;
    if (!final) {
      const cut = text.length - OVERLAP_CHARS;
      const lineStart = text.lastIndexOf('\n', cut - 1) + 1;
      // linha curta: a fronteira cai no começo dela; linha enorme (JSON minificado): no meio
      boundary = cut - lineStart <= OVERLAP_CHARS ? lineStart : cut;
      next = boundary;
      if (boundary === lineStart && boundary > 0) {
        const previous = text.lastIndexOf('\n', boundary - 2) + 1;
        if (boundary - previous <= OVERLAP_CHARS) next = previous;
      }
    }
    const findings = scanSecrets(text);
    if (findings.length > 0) {
      const starts = lineStarts(text);
      for (const finding of findings) {
        const start = starts[finding.line - 1] ?? 0;
        const index = start + finding.column - 1;
        if (index < this.acceptFrom || index >= boundary) continue;
        const end = text.indexOf('\n', start);
        this.hits.push({
          path: this.path,
          line: this.lineBase + finding.line - 1,
          column: (finding.line === 1 ? this.colBase : 0) + finding.column,
          rule: finding.rule,
          description: finding.description,
          where: this.where,
          lineText: text.slice(start, end === -1 ? text.length : end).replace(/\r$/, ''),
        });
      }
    }
    if (final) {
      this.pending = '';
      return;
    }
    const dropped = text.slice(0, next);
    const lastNewline = dropped.lastIndexOf('\n');
    if (lastNewline === -1) {
      this.colBase += next;
    } else {
      let newlines = 0;
      for (let i = dropped.indexOf('\n'); i !== -1; i = dropped.indexOf('\n', i + 1)) newlines++;
      this.lineBase += newlines;
      this.colBase = next - (lastNewline + 1);
    }
    this.acceptFrom = boundary - next;
    this.pending = this.pending.slice(next);
  }
}

/**
 * Scanner de um arquivo inteiro entregue aos pedaços: guarda o começo até decidir se é binário. `push` devolve
 * `false` quando o arquivo é claramente binário (não vale a pena ler o resto).
 */
export class FileScanner {
  private readonly path: string;
  private readonly text: TextScanner;
  private head: Buffer[] = [];
  private headLength = 0;
  private kind: 'binary' | 'text' | null = null;

  constructor(path: string, where: SecretLocation['where']) {
    this.path = path;
    this.text = new TextScanner(path, where);
  }

  push(chunk: Uint8Array): boolean {
    if (this.kind === 'binary') return false;
    if (this.kind === 'text') {
      this.text.push(chunk);
      return true;
    }
    this.head.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.headLength += chunk.byteLength;
    if (this.headLength >= HEAD_BYTES) this.decide();
    return this.kind !== 'binary';
  }

  end(): ScanHit[] {
    if (this.kind === null) this.decide();
    return this.kind === 'binary' ? [] : this.text.end();
  }

  private decide(): void {
    const head = Buffer.concat(this.head);
    this.head = [];
    this.kind = isClearlyBinary(this.path, head) ? 'binary' : 'text';
    if (this.kind === 'text') this.text.push(head);
  }
}

/** Escaneia um conteúdo que já está na memória. */
export function scanFile(path: string, data: Uint8Array, where: SecretLocation['where']): ScanHit[] {
  const scanner = new FileScanner(path, where);
  scanner.push(data);
  return scanner.end();
}

/** Resultado de escanear um arquivo da pasta de trabalho. */
export type WorktreeScan = { readonly hits: ScanHit[] } | { readonly unscannable: string };

/**
 * Escaneia um arquivo da pasta de trabalho, aos pedaços. Não conseguir ler o arquivo (permissão, arquivo travado por
 * outro programa) devolve `unscannable`: o chamador bloqueia, porque não sabe o que iria para o remoto.
 */
export async function scanWorktreeFile(
  file: string,
  path: string,
  where: SecretLocation['where'],
): Promise<WorktreeScan> {
  const scanner = new FileScanner(path, where);
  try {
    const stream = createReadStream(file, { highWaterMark: SMALL_FILE_BYTES });
    for await (const chunk of stream) {
      if (!scanner.push(chunk as Buffer)) {
        stream.destroy();
        break;
      }
    }
    return { hits: scanner.end() };
  } catch (error) {
    return { unscannable: error instanceof Error ? error.message : String(error) };
  }
}

/** Escaneia um blob grande do banco de objetos, aos pedaços. */
async function scanBlobStream(ctx: GitContext, oid: string, path: string): Promise<ScanHit[]> {
  const scanner = new FileScanner(path, 'outgoing');
  await gitStream(ctx, ['cat-file', 'blob', oid], (chunk) => scanner.push(chunk));
  return scanner.end();
}

/** Quais das linhas pedidas existem no blob `spec` (`<commit>:<caminho>`); vazio se o blob não existe. */
async function linesPresent(ctx: GitContext, spec: string, wanted: ReadonlySet<string>): Promise<Set<string>> {
  const found = new Set<string>();
  const size = (await objectSizes(ctx, [spec])).get(spec);
  if (size === undefined || size.type !== 'blob') return found;
  const check = (line: string): void => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (wanted.has(clean)) found.add(clean);
  };
  if (size.size <= SMALL_FILE_BYTES) {
    const data = (await readObjects(ctx, [spec])).get(spec);
    for (const line of data?.toString('utf8').split('\n') ?? []) check(line);
    return found;
  }
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let rest = '';
  await gitStream(ctx, ['cat-file', 'blob', spec], (chunk) => {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) check(line);
    return found.size < wanted.size;
  });
  check(rest + decoder.decode());
  return found;
}

const strip = (hit: ScanHit): SecretLocation => ({
  path: hit.path,
  line: hit.line,
  column: hit.column,
  rule: hit.rule,
  description: hit.description,
  where: hit.where,
});

/**
 * Procura segredos em tudo que um envio de `target` levaria a um remoto que já tem `up`: cada versão de arquivo
 * criada por qualquer commit do trecho, e não só a última (um segredo apagado num commit seguinte ainda iria no
 * histórico). Uma linha que já está no arquivo do lado remoto não é acusada: enviá-la de novo não vaza nada.
 */
export async function scanOutgoing(ctx: GitContext, up: string | null, target: string): Promise<SecretLocation[]> {
  const { stdout } = await git(ctx, [
    'rev-list',
    '--objects',
    '--filter=object:type=blob',
    target,
    ...(up === null ? [] : ['--not', up]),
  ]);
  const paths = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue; // commits vêm sem caminho
    const oid = line.slice(0, space);
    if (!paths.has(oid)) paths.set(oid, line.slice(space + 1));
  }
  if (paths.size === 0) return [];
  const sizes = await objectSizes(ctx, paths.keys());
  const found: ScanHit[] = [];
  let batch: string[] = [];
  let batchBytes = 0;
  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const blobs = await readObjects(ctx, batch);
    for (const oid of batch) {
      const data = blobs.get(oid);
      if (data !== undefined) found.push(...scanFile(paths.get(oid) ?? oid, data, 'outgoing'));
    }
    batch = [];
    batchBytes = 0;
  };
  for (const [oid, path] of paths) {
    const size = sizes.get(oid)?.size ?? 0;
    if (size > SMALL_FILE_BYTES) {
      found.push(...(await scanBlobStream(ctx, oid, path)));
      continue;
    }
    if (batchBytes + size > BATCH_BYTES) await flushBatch();
    batch.push(oid);
    batchBytes += size;
  }
  await flushBatch();
  if (found.length === 0 || up === null) return found.map(strip);

  const byPath = new Map<string, ScanHit[]>();
  for (const hit of found) byPath.set(hit.path, [...(byPath.get(hit.path) ?? []), hit]);
  const kept: SecretLocation[] = [];
  for (const [path, hits] of byPath) {
    const present = await linesPresent(ctx, `${up}:${path}`, new Set(hits.map((hit) => hit.lineText)));
    for (const hit of hits) if (!present.has(hit.lineText)) kept.push(strip(hit));
  }
  return kept;
}
