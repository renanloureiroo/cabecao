import { describe, expect, it } from 'vitest';
import { isUlid, ulid, ulidTime } from '../../src/util/index.ts';

describe('ulid', () => {
  it('tem 26 caracteres do alfabeto Crockford, sem I, L, O e U', () => {
    for (let i = 0; i < 1000; i++) {
      const id = ulid();
      expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(id).not.toMatch(/[ILOU]/);
      expect(isUlid(id)).toBe(true);
    }
  });

  it('ordena como texto na mesma ordem do tempo', () => {
    const times = [0, 1, 31, 32, 1_000, 2 ** 40, 1_700_000_000_000, 1_700_000_000_001, 2 ** 48 - 1];
    const ids = times.map((time) => ulid(time));
    expect([...ids].sort()).toEqual(ids);
    expect(ulid(1_800_000_000_000) > ulid(1_700_000_000_000)).toBe(true);
  });

  it('é monotônico numa rajada de 10 mil no mesmo milissegundo', () => {
    const now = 1_750_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(ulid(now));
    for (let i = 1; i < ids.length; i++) {
      expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
    }
    expect(new Set(ids).size).toBe(10_000);
    expect(ids.every((id) => ulidTime(id) === now)).toBe(true);
  });

  it('sem argumento, cada chamada é maior que a anterior', () => {
    let previous = ulid();
    for (let i = 0; i < 10_000; i++) {
      const next = ulid();
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  it('decodifica o instante', () => {
    for (const time of [0, 1, 1_469_918_176_385, 1_762_950_000_123, 2 ** 48 - 1]) {
      expect(ulidTime(ulid(time))).toBe(time);
    }
    // Exemplo da especificação do ULID.
    expect(ulidTime('01ARYZ6S41TSV4RRFFQ69G5FAV')).toBe(1_469_918_176_385);
    const before = Date.now();
    const time = ulidTime(ulid());
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });

  it('respeita um instante explícito no passado, e ele não desloca o relógio', () => {
    ulid(2 ** 48 - 1);
    expect(ulidTime(ulid(1_000_000_000_000))).toBe(1_000_000_000_000);
    expect(ulidTime(ulid())).toBeLessThanOrEqual(Date.now());
  });

  it('recusa instante inválido', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 48]) {
      expect(() => ulid(bad)).toThrow(RangeError);
    }
  });

  it('isUlid recusa o que não é ULID canônico', () => {
    const valid = '01JD3K8Y6Z9W2T4N5P7Q8R0S1V';
    expect(isUlid(valid)).toBe(true);
    expect(isUlid(valid.toLowerCase())).toBe(false);
    expect(isUlid(valid.slice(1))).toBe(false);
    expect(isUlid(`${valid}0`)).toBe(false);
    expect(isUlid(`8${valid.slice(1)}`)).toBe(false); // instante não cabe em 48 bits
    expect(isUlid(`${valid.slice(0, 25)}U`)).toBe(false);
    expect(isUlid(`${valid.slice(0, 25)}I`)).toBe(false);
    expect(isUlid(undefined)).toBe(false);
    expect(isUlid(123)).toBe(false);
    expect(() => ulidTime('nao-e-ulid')).toThrow(TypeError);
  });
});
