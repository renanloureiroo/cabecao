/**
 * Formato binário do segmento de embeddings (doc 03, "Segmento de embeddings"; decisões 10 e 12).
 *
 * Um segmento é imutável e nomeado pelo hash do próprio conteúdo. Todos os inteiros e a escala são little-endian
 * explícitos (`DataView` com `littleEndian = true`), então os mesmos registros dão os mesmos bytes em qualquer
 * máquina e sistema.
 *
 * ```
 * offset  tamanho  campo
 * 0       4        "CBSG" (0x43 0x42 0x53 0x47)
 * 4       1        versão do formato (u8) = 1
 * 5       1        bytes da chave (u8) = 16
 * 6       1        tipo da escala (u8) = 1 (float32 little-endian)
 * 7       1        tipo do vetor (u8) = 1 (int8)
 * 8       4        dimensões (u32 LE)
 * 12      4        número de registros (u32 LE)
 * 16      n × r    registros, r = 16 + 4 + dims, ordenados pela chave (bytes crescentes):
 *                    chave (16 bytes) | escala (float32 LE) | vetor (dims × int8)
 * 16+n×r  32       SHA-256 de tudo o que vem antes
 * ```
 *
 * Nome do arquivo: `seg-<32 primeiros dígitos hex do SHA-256 final>.bin`. Como o SHA-256 final cobre todo o resto,
 * conferir o nome é conferir o checksum: conteúdo igual dá nome igual, em qualquer máquina.
 */
import { createHash } from 'node:crypto';

/** Registro de embedding guardado num segmento. É o contrato com o módulo `vector/`. */
export interface EmbeddingRecord {
  /** Chave do trecho (`chunkKey`): 16 bytes em hexadecimal minúsculo, 32 caracteres. */
  readonly key: string;
  /** Fator de reconstrução do vetor, representável em float32. */
  readonly scale: number;
  /** Vetor quantizado, `dims` componentes. */
  readonly vector: Int8Array;
}

export const SEGMENT_MAGIC = 'CBSG';
export const SEGMENT_FORMAT_VERSION = 1;
export const SEGMENT_KEY_BYTES = 16;
export const SEGMENT_HEADER_BYTES = 16;
export const SEGMENT_CHECKSUM_BYTES = 32;
/** Dígitos hex do hash no nome do arquivo. */
export const SEGMENT_NAME_HEX = 32;
/** Maior dimensão aceita (o campo é u32; o limite só protege contra cabeçalho corrompido). */
export const SEGMENT_MAX_DIMS = 1 << 16;

const SCALE_FLOAT32_LE = 1;
const VECTOR_INT8 = 1;
const MAGIC_BYTES = Buffer.from(SEGMENT_MAGIC, 'latin1');
const KEY_RE = /^[0-9a-f]{32}$/;
export const SEGMENT_NAME_RE = /^seg-[0-9a-f]{32}\.bin$/;

/** Chave de trecho válida: 32 dígitos hexadecimais minúsculos. */
export function isEmbeddingKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_RE.test(key);
}

/** Bytes de um registro com `dims` dimensões. */
export function segmentRecordBytes(dims: number): number {
  return SEGMENT_KEY_BYTES + 4 + dims;
}

/** Tamanho total de um segmento com `count` registros. */
export function segmentSize(dims: number, count: number): number {
  return SEGMENT_HEADER_BYTES + count * segmentRecordBytes(dims) + SEGMENT_CHECKSUM_BYTES;
}

/**
 * Quantos registros um segmento desse tamanho tem, ou `null` se o tamanho não fecha com as dimensões. Permite contar
 * vetores pelo tamanho do blob (`git ls-tree -l`) sem ler o conteúdo.
 */
export function segmentCountFromSize(size: number, dims: number): number | null {
  const body = size - SEGMENT_HEADER_BYTES - SEGMENT_CHECKSUM_BYTES;
  const record = segmentRecordBytes(dims);
  if (body < 0 || body % record !== 0) return null;
  return body / record;
}

export function assertSegmentDims(dims: number): void {
  if (!Number.isSafeInteger(dims) || dims < 1 || dims > SEGMENT_MAX_DIMS) {
    throw new RangeError(`dimensão inválida para segmento: ${dims} (esperado inteiro entre 1 e ${SEGMENT_MAX_DIMS})`);
  }
}

/** Confere um registro antes de gravar. Lança `RangeError`/`TypeError` com o motivo. */
export function assertEmbeddingRecord(record: EmbeddingRecord, dims: number): void {
  if (!isEmbeddingKey(record.key)) {
    throw new TypeError(`chave inválida: ${String(record.key)} (esperado 32 dígitos hex minúsculos)`);
  }
  if (!(record.vector instanceof Int8Array)) throw new TypeError(`o vetor da chave ${record.key} não é um Int8Array`);
  if (record.vector.length !== dims) {
    throw new RangeError(
      `o vetor da chave ${record.key} tem ${record.vector.length} dimensões; o segmento tem ${dims}`,
    );
  }
  if (typeof record.scale !== 'number' || !Number.isFinite(record.scale)) {
    throw new RangeError(`escala inválida na chave ${record.key}: ${String(record.scale)}`);
  }
}

export interface EncodedSegment {
  /** `seg-<hash>.bin`. */
  readonly name: string;
  readonly bytes: Buffer;
  readonly dims: number;
  /** Registros gravados (sem as chaves repetidas). */
  readonly count: number;
}

/**
 * Codifica registros num segmento. Os registros são ordenados pela chave (ordenação estável); numa chave repetida
 * vale a primeira ocorrência. O resultado não depende da máquina: mesmos registros, mesmos bytes, mesmo nome.
 */
export function encodeSegment(records: Iterable<EmbeddingRecord>, dims: number): EncodedSegment {
  assertSegmentDims(dims);
  const unique = new Map<string, EmbeddingRecord>();
  for (const record of records) {
    assertEmbeddingRecord(record, dims);
    if (!unique.has(record.key)) unique.set(record.key, record);
  }
  // hex minúsculo: a ordem das strings é a ordem dos bytes
  const sorted = [...unique.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const recordBytes = segmentRecordBytes(dims);
  const bytes = Buffer.alloc(segmentSize(dims, sorted.length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  MAGIC_BYTES.copy(bytes, 0);
  bytes[4] = SEGMENT_FORMAT_VERSION;
  bytes[5] = SEGMENT_KEY_BYTES;
  bytes[6] = SCALE_FLOAT32_LE;
  bytes[7] = VECTOR_INT8;
  view.setUint32(8, dims, true);
  view.setUint32(12, sorted.length, true);
  let offset = SEGMENT_HEADER_BYTES;
  for (const record of sorted) {
    bytes.write(record.key, offset, SEGMENT_KEY_BYTES, 'hex');
    view.setFloat32(offset + SEGMENT_KEY_BYTES, record.scale, true);
    bytes.set(new Uint8Array(record.vector.buffer, record.vector.byteOffset, dims), offset + SEGMENT_KEY_BYTES + 4);
    offset += recordBytes;
  }
  const checksum = createHash('sha256').update(bytes.subarray(0, offset)).digest();
  checksum.copy(bytes, offset);
  return { name: segmentNameOf(checksum), bytes, dims, count: sorted.length };
}

function segmentNameOf(checksum: Uint8Array): string {
  return `seg-${Buffer.from(checksum.buffer, checksum.byteOffset, checksum.byteLength).toString('hex', 0, SEGMENT_NAME_HEX / 2)}.bin`;
}

/** Por que um segmento foi recusado. */
export type SegmentProblem =
  /** Menor que o cabeçalho, ou menor do que o cabeçalho promete. */
  | 'truncated'
  /** Maior do que o cabeçalho promete. */
  | 'oversized'
  | 'magic'
  /** Versão de formato que este código não conhece (de uma versão mais nova do Cabeção). */
  | 'version'
  /** Campos fixos do cabeçalho com valor desconhecido. */
  | 'format'
  | 'checksum'
  /** O nome do arquivo não é o hash do conteúdo. */
  | 'name'
  /** Dimensões diferentes das do modelo. */
  | 'dims';

/** Segmento lido e conferido. Os vetores devolvidos são vistas sobre os bytes originais (sem cópia). */
export interface DecodedSegment {
  readonly name: string;
  readonly formatVersion: number;
  readonly dims: number;
  readonly count: number;
  readonly bytes: Buffer;
  key(index: number): string;
  scale(index: number): number;
  vector(index: number): Int8Array;
  record(index: number): EmbeddingRecord;
  records(): IterableIterator<EmbeddingRecord>;
}

export type DecodeSegmentResult =
  | { readonly ok: true; readonly segment: DecodedSegment }
  | { readonly ok: false; readonly problem: SegmentProblem; readonly detail: string };

export interface DecodeSegmentExpect {
  /** Nome do arquivo; confere que é o hash do conteúdo. */
  readonly name?: string;
  /** Dimensões esperadas. */
  readonly dims?: number;
}

function fail(problem: SegmentProblem, detail: string): DecodeSegmentResult {
  return { ok: false, problem, detail };
}

/**
 * Lê e confere um segmento: tamanho, cabeçalho, checksum e, quando informados, nome e dimensões. Nunca lança por
 * conteúdo inválido: devolve o problema, para quem lê ignorar o segmento e seguir.
 */
export function decodeSegment(input: Uint8Array, expect: DecodeSegmentExpect = {}): DecodeSegmentResult {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < SEGMENT_HEADER_BYTES + SEGMENT_CHECKSUM_BYTES) {
    return fail('truncated', `${bytes.length} bytes; o mínimo é ${SEGMENT_HEADER_BYTES + SEGMENT_CHECKSUM_BYTES}`);
  }
  if (!bytes.subarray(0, 4).equals(MAGIC_BYTES)) return fail('magic', 'não começa com "CBSG"');
  const version = bytes[4] ?? 0;
  if (version !== SEGMENT_FORMAT_VERSION) {
    return fail('version', `versão de formato ${version}; esta versão do Cabeção lê a ${SEGMENT_FORMAT_VERSION}`);
  }
  if (bytes[5] !== SEGMENT_KEY_BYTES || bytes[6] !== SCALE_FLOAT32_LE || bytes[7] !== VECTOR_INT8) {
    return fail('format', `cabeçalho desconhecido (chave ${bytes[5]}, escala ${bytes[6]}, vetor ${bytes[7]})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dims = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (dims < 1 || dims > SEGMENT_MAX_DIMS) return fail('format', `dimensões fora do intervalo: ${dims}`);
  const expected = segmentSize(dims, count);
  if (bytes.length < expected) return fail('truncated', `${bytes.length} bytes; o cabeçalho promete ${expected}`);
  if (bytes.length > expected) return fail('oversized', `${bytes.length} bytes; o cabeçalho promete ${expected}`);
  const bodyEnd = expected - SEGMENT_CHECKSUM_BYTES;
  const checksum = createHash('sha256').update(bytes.subarray(0, bodyEnd)).digest();
  if (!checksum.equals(bytes.subarray(bodyEnd))) return fail('checksum', 'o SHA-256 final não confere');
  const name = segmentNameOf(checksum);
  if (expect.name !== undefined && expect.name !== name) {
    return fail('name', `o arquivo se chama ${expect.name}, mas o conteúdo é de ${name}`);
  }
  if (expect.dims !== undefined && expect.dims !== dims) {
    return fail('dims', `o segmento tem ${dims} dimensões; o modelo tem ${expect.dims}`);
  }
  return { ok: true, segment: makeDecoded(bytes, view, name, dims, count) };
}

function makeDecoded(bytes: Buffer, view: DataView, name: string, dims: number, count: number): DecodedSegment {
  const recordBytes = segmentRecordBytes(dims);
  const at = (index: number): number => {
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new RangeError(`registro ${index} fora do segmento`);
    return SEGMENT_HEADER_BYTES + index * recordBytes;
  };
  const key = (index: number): string => {
    const offset = at(index);
    return bytes.toString('hex', offset, offset + SEGMENT_KEY_BYTES);
  };
  const scale = (index: number): number => view.getFloat32(at(index) + SEGMENT_KEY_BYTES, true);
  const vector = (index: number): Int8Array =>
    new Int8Array(bytes.buffer, bytes.byteOffset + at(index) + SEGMENT_KEY_BYTES + 4, dims);
  const record = (index: number): EmbeddingRecord => ({ key: key(index), scale: scale(index), vector: vector(index) });
  return {
    name,
    formatVersion: SEGMENT_FORMAT_VERSION,
    dims,
    count,
    bytes,
    key,
    scale,
    vector,
    record,
    *records() {
      for (let i = 0; i < count; i++) yield record(i);
    },
  };
}

/** Lê só o cabeçalho: dimensões e contagem, sem conferir o checksum. `null` se não for um segmento conhecido. */
export function peekSegmentHeader(input: Uint8Array): { dims: number; count: number } | null {
  if (input.length < SEGMENT_HEADER_BYTES) return null;
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, 4).equals(MAGIC_BYTES) || bytes[4] !== SEGMENT_FORMAT_VERSION) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { dims: view.getUint32(8, true), count: view.getUint32(12, true) };
}
