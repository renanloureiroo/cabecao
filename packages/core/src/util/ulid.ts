import { randomBytes } from 'node:crypto';

/** Alfabeto Crockford base32: sem I, L, O e U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** O instante ocupa 48 bits (10 caracteres). */
const TIME_MAX = 2 ** 48 - 1;
/** Os 80 bits aleatórios são guardados em duas metades de 40 bits, que cabem num `number` sem perda. */
const HALF_MAX = 2 ** 40 - 1;

/** Último valor gerado por uma sequência; é o que permite incrementar em vez de sortear de novo. */
interface Sequence {
  time: number;
  high: number;
  low: number;
}

/**
 * Duas sequências separadas: a do relógio (chamadas sem argumento) e a dos instantes explícitos. Assim um
 * `ulid(instante)` no futuro ou no passado não desloca os identificadores gerados pelo relógio.
 */
const clockSequence: Sequence = { time: -1, high: 0, low: 0 };
const explicitSequence: Sequence = { time: -1, high: 0, low: 0 };

function encode(value: number, length: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function randomize(sequence: Sequence): void {
  const bytes = randomBytes(10);
  sequence.high = bytes.readUIntBE(0, 5);
  sequence.low = bytes.readUIntBE(5, 5);
}

function next(sequence: Sequence, time: number): string {
  if (time !== sequence.time) {
    sequence.time = time;
    randomize(sequence);
  } else if (sequence.low < HALF_MAX) {
    sequence.low++;
  } else if (sequence.high < HALF_MAX) {
    sequence.low = 0;
    sequence.high++;
  } else {
    // 80 bits esgotados no mesmo milissegundo (na prática impossível): avança o instante para manter a ordem.
    sequence.time = Math.min(sequence.time + 1, TIME_MAX);
    randomize(sequence);
  }
  return encode(sequence.time, 10) + encode(sequence.high, 8) + encode(sequence.low, 8);
}

/**
 * Gera um ULID (26 caracteres, ordenável como texto na ordem do tempo).
 *
 * Monotônico dentro do processo: chamadas no mesmo milissegundo devolvem valores crescentes (a parte aleatória é
 * incrementada em vez de sorteada de novo). Sem argumento, cada valor é maior que o anterior mesmo se o relógio
 * andar para trás. Com `now` explícito o instante pedido é sempre respeitado (serve para datas passadas), e a
 * ordem crescente vale entre chamadas seguidas com o mesmo instante.
 */
export function ulid(now?: number): string {
  if (now === undefined) return next(clockSequence, Math.max(Date.now(), clockSequence.time));
  if (!Number.isInteger(now) || now < 0 || now > TIME_MAX) {
    throw new RangeError(`ulid: instante inválido (${now}); esperado inteiro entre 0 e ${TIME_MAX}`);
  }
  return next(explicitSequence, now);
}

/** Aceita só a forma canônica: 26 caracteres Crockford em maiúsculas, com o instante cabendo em 48 bits. */
export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** Instante (ms desde 1970) codificado no ULID. Lança `TypeError` se `id` não for um ULID. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError(`ulidTime: não é um ULID: ${JSON.stringify(id)}`);
  let time = 0;
  for (let i = 0; i < 10; i++) time = time * 32 + ALPHABET.indexOf(id.charAt(i));
  return time;
}
