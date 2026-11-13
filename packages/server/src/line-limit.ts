// Limite de tamanho das mensagens que chegam pelo stdin, antes do transporte do SDK.
//
// O `StdioServerTransport` do SDK junta os pedaços até achar a quebra de linha e, se a mensagem passa do limite
// dele (10 MiB), descarta tudo e FECHA o transporte: o servidor sai com código 0, sem responder nada ao cliente e
// sem dizer nada no stderr. Um agente que mande um `content` gigante derrubaria a conexão inteira.
//
// Este filtro fica entre o stdin e o transporte: entrega ao transporte só linhas inteiras de até `maxBytes` e, quando
// uma linha passa disso, joga fora o resto dela, avisa no stderr e responde ao pedido com um erro JSON-RPC (o `id`
// é achado por um leitor de JSON incremental, que só guarda o que precisa). A conexão segue viva.
import { Transform, type TransformCallback } from 'node:stream';

/** Limite de uma mensagem JSON-RPC, em bytes (o mesmo padrão do SDK). */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** `id` de um pedido JSON-RPC; `undefined` quando não foi achado (notificação, JSON quebrado). */
export type RequestId = string | number | undefined;

const NEWLINE = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
/** Quanto do texto de uma chave ou de um `id` em texto o leitor guarda; o resto é ignorado. */
const KEEP = 256;

/**
 * Acha o `id` de primeiro nível de um objeto JSON lido aos pedaços, sem montar o objeto: acompanha só aspas,
 * escapes e profundidade. Custa uma passada pelos bytes, e só roda numa mensagem que já passou do limite.
 */
class TopLevelIdScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** O texto em leitura é uma chave do primeiro nível, ou o valor do `id`. */
  private role: 'key' | 'id' | null = null;
  private buffer: number[] = [];
  private expectKey = false;
  private lastKey: string | null = null;
  private awaitingIdValue = false;
  private number: number[] | null = null;
  private found: RequestId;
  private done = false;

  feed(chunk: Buffer): void {
    for (let i = 0; i < chunk.length && !this.done; i++) this.byte(chunk[i] ?? 0);
  }

  result(): RequestId {
    if (this.number !== null) this.finishNumber();
    return this.found;
  }

  private finishNumber(): void {
    const text = Buffer.from(this.number ?? []).toString('latin1');
    this.number = null;
    const value = Number(text);
    if (text !== '' && Number.isFinite(value)) this.found = value;
    this.done = true;
  }

  private byte(b: number): void {
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
        if (this.role !== null && this.buffer.length < KEEP) this.buffer.push(b);
        return;
      }
      if (b === BACKSLASH) {
        this.escaped = true;
        if (this.role !== null && this.buffer.length < KEEP) this.buffer.push(b);
        return;
      }
      if (b === QUOTE) {
        this.inString = false;
        const raw = Buffer.from(this.buffer).toString('utf8');
        if (this.role === 'key') this.lastKey = raw;
        if (this.role === 'id') {
          try {
            this.found = JSON.parse(`"${raw}"`) as string;
          } catch {
            this.found = undefined;
          }
          this.done = true;
        }
        this.role = null;
        this.buffer = [];
        return;
      }
      if (this.role !== null && this.buffer.length < KEEP) this.buffer.push(b);
      return;
    }
    if (this.number !== null) {
      // número: dígitos, sinal, ponto e expoente
      if ((b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2b || b === 0x2e || b === 0x65 || b === 0x45) {
        if (this.number.length < KEEP) this.number.push(b);
        return;
      }
      this.finishNumber();
      return;
    }
    switch (b) {
      case 0x7b: // {
        this.depth++;
        if (this.depth === 1) this.expectKey = true;
        this.awaitingIdValue = false;
        return;
      case 0x5b: // [
        this.depth++;
        this.awaitingIdValue = false;
        return;
      case 0x7d: // }
      case 0x5d: // ]
        this.depth--;
        return;
      case QUOTE:
        this.inString = true;
        this.buffer = [];
        if (this.depth === 1 && this.expectKey) this.role = 'key';
        else if (this.depth === 1 && this.awaitingIdValue) this.role = 'id';
        else this.role = null;
        this.awaitingIdValue = false;
        return;
      case 0x3a: // :
        if (this.depth === 1) {
          this.expectKey = false;
          this.awaitingIdValue = this.lastKey === 'id';
        }
        return;
      case 0x2c: // ,
        if (this.depth === 1) {
          this.expectKey = true;
          this.lastKey = null;
          this.awaitingIdValue = false;
        }
        return;
      case 0x20:
      case 0x09:
      case 0x0d:
        return;
      default:
        if (this.depth === 1 && this.awaitingIdValue && ((b >= 0x30 && b <= 0x39) || b === 0x2d)) {
          this.number = [b];
        }
        this.awaitingIdValue = false;
    }
  }
}

export interface LineLimitOptions {
  readonly maxBytes?: number;
  /** Chamado quando uma linha passou do limite, depois de ela terminar (ou de a entrada acabar). */
  readonly onOversize: (info: { readonly id: RequestId; readonly bytes: number; readonly maxBytes: number }) => void;
}

/**
 * Transforma o stdin num fluxo de linhas inteiras (cada uma com a sua quebra), de até `maxBytes` cada. Uma linha
 * maior é descartada e relatada a `onOversize`; as outras passam iguais, byte a byte.
 */
export class LineLimiter extends Transform {
  private readonly maxBytes: number;
  private readonly onOversize: LineLimitOptions['onOversize'];
  private parts: Buffer[] = [];
  private size = 0;
  /** A linha atual já passou do limite: o resto dela é só contado e lido pelo `scanner`. */
  private scanner: TopLevelIdScanner | null = null;
  private dropped = 0;

  constructor(options: LineLimitOptions) {
    super();
    this.maxBytes = options.maxBytes ?? MAX_MESSAGE_BYTES;
    this.onOversize = options.onOversize;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, done: TransformCallback): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let start = 0;
    while (start <= data.length) {
      const newline = data.indexOf(NEWLINE, start);
      const end = newline === -1 ? data.length : newline;
      this.accept(data.subarray(start, end));
      if (newline === -1) break;
      this.endLine();
      start = newline + 1;
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    // a entrada acabou no meio de uma linha: passa o que houver (o transporte decide) ou relata o excesso
    if (this.scanner !== null) this.report();
    else if (this.size > 0) this.push(Buffer.concat(this.parts));
    this.parts = [];
    this.size = 0;
    done();
  }

  private accept(piece: Buffer): void {
    if (piece.length === 0) return;
    if (this.scanner === null && this.size + piece.length > this.maxBytes) {
      this.scanner = new TopLevelIdScanner();
      for (const part of this.parts) this.scanner.feed(part);
      this.dropped = this.size;
      this.parts = [];
      this.size = 0;
    }
    if (this.scanner !== null) {
      this.scanner.feed(piece);
      this.dropped += piece.length;
      return;
    }
    this.parts.push(piece);
    this.size += piece.length;
  }

  private endLine(): void {
    if (this.scanner !== null) {
      this.report();
      return;
    }
    this.parts.push(Buffer.from('\n'));
    this.push(Buffer.concat(this.parts));
    this.parts = [];
    this.size = 0;
  }

  private report(): void {
    const id = this.scanner?.result();
    const bytes = this.dropped;
    this.scanner = null;
    this.dropped = 0;
    this.onOversize({ id, bytes, maxBytes: this.maxBytes });
  }
}
