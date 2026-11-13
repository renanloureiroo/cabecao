import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeSegment,
  type EmbeddingRecord,
  encodeSegment,
  SEGMENT_NAME_RE,
  segmentCountFromSize,
  segmentSize,
} from '../../src/indexstore/index.ts';
import { keyOf, makeRecords } from './helpers.ts';

function fixed(): EmbeddingRecord[] {
  return [
    { key: 'ff'.repeat(16), scale: 0.5, vector: Int8Array.from([1, -1, 127, -127]) },
    { key: '00'.repeat(16), scale: -2.25, vector: Int8Array.from([0, 2, -3, 4]) },
  ];
}

describe('segmento: formato binário', () => {
  it('cabeçalho, registros e checksum nos offsets documentados, tudo little-endian', () => {
    const seg = encodeSegment(fixed(), 4);
    const b = seg.bytes;
    expect(b.length).toBe(segmentSize(4, 2));
    expect(b.length).toBe(16 + 2 * (16 + 4 + 4) + 32);
    expect(b.subarray(0, 4).toString('latin1')).toBe('CBSG');
    expect([...b.subarray(4, 8)]).toEqual([1, 16, 1, 1]);
    expect([...b.subarray(8, 12)]).toEqual([4, 0, 0, 0]); // dims u32 LE
    expect([...b.subarray(12, 16)]).toEqual([2, 0, 0, 0]); // contagem u32 LE
    // primeiro registro = menor chave (00…), escala -2.25 em float32 LE = 0xC0100000
    expect(b.subarray(16, 32).toString('hex')).toBe('00'.repeat(16));
    expect([...b.subarray(32, 36)]).toEqual([0x00, 0x00, 0x10, 0xc0]);
    expect([...new Int8Array(b.buffer, b.byteOffset + 36, 4)]).toEqual([0, 2, -3, 4]);
    expect(b.subarray(40, 56).toString('hex')).toBe('ff'.repeat(16));
    const body = b.subarray(0, b.length - 32);
    const sha = createHash('sha256').update(body).digest();
    expect(b.subarray(b.length - 32).equals(sha)).toBe(true);
    expect(seg.name).toBe(`seg-${sha.toString('hex').slice(0, 32)}.bin`);
    expect(seg.name).toMatch(SEGMENT_NAME_RE);
  });

  it('determinístico: o mesmo conjunto dá os mesmos bytes e o mesmo nome, em qualquer ordem (valor fixado)', () => {
    const a = encodeSegment(fixed(), 4);
    const b = encodeSegment([...fixed()].reverse(), 4);
    expect(b.bytes.equals(a.bytes)).toBe(true);
    expect(b.name).toBe(a.name);
    // fixado: muda só se o formato mudar (e então a versão do formato tem de subir)
    expect(a.name).toBe(GOLDEN_NAME);
  });

  it('ida e volta: chaves, escalas e vetores voltam iguais; os vetores são vistas sem cópia', () => {
    const records = makeRecords('rt', 300, 384, 7);
    const seg = encodeSegment(records, 384);
    const decoded = decodeSegment(seg.bytes, { name: seg.name, dims: 384 });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const byKey = new Map(records.map((r) => [r.key, r]));
    expect(decoded.segment.count).toBe(300);
    let previous = '';
    for (const record of decoded.segment.records()) {
      const original = byKey.get(record.key);
      expect(record.key > previous).toBe(true);
      previous = record.key;
      expect(record.scale).toBe(original?.scale);
      expect([...record.vector]).toEqual([...(original?.vector ?? [])]);
      expect(record.vector.buffer).toBe(seg.bytes.buffer);
    }
  });

  it('chave repetida no lote: vale a primeira ocorrência', () => {
    const first = { key: keyOf('x'), scale: 1, vector: new Int8Array(4).fill(1) };
    const second = { key: keyOf('x'), scale: 2, vector: new Int8Array(4).fill(2) };
    const seg = encodeSegment([first, second], 4);
    expect(seg.count).toBe(1);
    const decoded = decodeSegment(seg.bytes);
    expect(decoded.ok && decoded.segment.scale(0)).toBe(1);
  });

  it('recusa registros inválidos ao gravar', () => {
    const ok = { key: keyOf('a'), scale: 1, vector: new Int8Array(4) };
    expect(() => encodeSegment([{ ...ok, key: 'XYZ' }], 4)).toThrow(/chave inválida/);
    expect(() => encodeSegment([{ ...ok, key: keyOf('a').toUpperCase() }], 4)).toThrow(/chave inválida/);
    expect(() => encodeSegment([{ ...ok, vector: new Int8Array(5) }], 4)).toThrow(/dimensões/);
    expect(() => encodeSegment([{ ...ok, scale: Number.NaN }], 4)).toThrow(/escala/);
    expect(() => encodeSegment([{ ...ok, vector: new Uint8Array(4) as unknown as Int8Array }], 4)).toThrow(/Int8Array/);
    expect(() => encodeSegment([ok], 0)).toThrow(/dimensão/);
  });

  it('segmento truncado, crescido, com bytes trocados, de outra versão, outro nome ou outra dimensão: recusado com o motivo', () => {
    const seg = encodeSegment(makeRecords('bad', 10, 8), 8);
    const problem = (bytes: Buffer, expect: { name?: string; dims?: number } = {}) => {
      const result = decodeSegment(bytes, expect);
      return result.ok ? 'ok' : result.problem;
    };
    expect(problem(seg.bytes, { name: seg.name, dims: 8 })).toBe('ok');
    expect(problem(seg.bytes.subarray(0, 10))).toBe('truncated');
    expect(problem(seg.bytes.subarray(0, seg.bytes.length - 1))).toBe('truncated');
    expect(problem(Buffer.concat([seg.bytes, Buffer.from([0])]))).toBe('oversized');
    const flipped = Buffer.from(seg.bytes);
    flipped[40] = (flipped[40] ?? 0) ^ 0xff;
    expect(problem(flipped)).toBe('checksum');
    const magic = Buffer.from(seg.bytes);
    magic[0] = 0;
    expect(problem(magic)).toBe('magic');
    const version = Buffer.from(seg.bytes);
    version[4] = 2;
    expect(problem(version)).toBe('version');
    expect(problem(seg.bytes, { name: 'seg-00000000000000000000000000000000.bin' })).toBe('name');
    expect(problem(seg.bytes, { dims: 16 })).toBe('dims');
  });

  it('conta registros pelo tamanho do blob (sem ler o conteúdo)', () => {
    expect(segmentCountFromSize(segmentSize(384, 1234), 384)).toBe(1234);
    expect(segmentCountFromSize(segmentSize(384, 0), 384)).toBe(0);
    expect(segmentCountFromSize(segmentSize(384, 10) + 1, 384)).toBeNull();
    expect(segmentCountFromSize(10, 384)).toBeNull();
  });
});

const GOLDEN_NAME = 'seg-36a8b59443dcc02cb318aaaf75ca53ed.bin';
